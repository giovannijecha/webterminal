//! Agent bridge: source-attributed activity, replies and requests reported by
//! optional program adapters. Only a holder of a session's bridge token can
//! report for that session. A request is answered at most once, by the
//! controlling view, and expires with its terminal or program session.
mod claude;
mod codex;
pub mod helper;
mod ledger;
mod values;

use crate::json::{self, Value};
use crate::programs::Program;
use ledger::{expire, live, request_revision, set_activity, trim};
use std::collections::{BTreeMap, VecDeque};
use std::path::Path;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};
use values::{bounded, fingerprint, now, same, text, token};

const LIVE_LIMIT: usize = 32;
const SETTLED_LIMIT: usize = 32;
const TOOL_KEYS_LIMIT: usize = LIVE_LIMIT + SETTLED_LIMIT;
/// Largest program event accepted from a bridge helper.
pub const PAYLOAD_LIMIT: usize = 1 << 20;
const REPLY_LIMIT: usize = 512 * 1024;
const TEXT_LIMIT: usize = 16 * 1024;
/// How long a request waits for a browser answer before the program falls
/// back to its own terminal prompt. Hook timeouts must exceed it.
pub const REQUEST_WAIT: Duration = Duration::from_secs(600);
const POLL: Duration = Duration::from_millis(250);
const IN_TERMINAL: &str = "Answered or cancelled in the terminal";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Activity {
    Ready,
    Working,
    Waiting,
    Idle,
    Ended,
    Failed,
}
impl Activity {
    fn name(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Working => "working",
            Self::Waiting => "waiting",
            Self::Idle => "idle",
            Self::Ended => "ended",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Waiting,
    Pending,
    Resolved,
    Expired,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Command,
    Edit,
    Tool,
    Question,
}

/// A controlling view's answer to one request.
#[derive(Debug, PartialEq, Eq)]
pub enum Answer {
    Allow,
    AllowSession,
    Deny,
    Terminal,
    Answers(BTreeMap<String, String>),
}

/// What an adapter understood from one program event.
enum Signal {
    Activity(Activity, String),
    /// A turn boundary: no earlier request can still hold the program.
    Turn(Activity, String),
    Reply(String),
    Failure(String),
    /// A tool call ran, so its open request was answered in the terminal.
    Ran {
        tool: String,
        input: u64,
    },
    Started(Option<String>),
    Ended,
    Request(Draft),
    Ignore,
}
struct Draft {
    kind: Kind,
    tool: String,
    /// Fingerprint of the exact tool input, matched against later tool runs.
    input: u64,
    evidence: Value,
    suggestions: Option<Value>,
    scope: Option<String>,
    questions: Option<Value>,
}

pub enum Outcome {
    /// Text the helper prints to the program (empty: no decision).
    Respond(String),
    Wait(String),
}

#[derive(Clone, Debug)]
pub struct Reply {
    pub seq: u64,
    pub session: String,
    pub program: Program,
    pub text: String,
    pub at: u64,
}

struct Source {
    program: Program,
    token: String,
    activity: Activity,
    since: u64,
    detail: String,
    conversation: Option<String>,
    /// Tool inputs seen since the last turn or program-session boundary.
    /// Two identical requests cannot be correlated with PostToolUse: its
    /// tool-use ID is absent from PermissionRequest.
    seen: BTreeMap<(String, u64), u8>,
    uncertain: bool,
}
struct Request {
    id: String,
    session: String,
    program: Program,
    draft: Draft,
    revision: u64,
    state: State,
    outcome: String,
    body: Option<String>,
    created: u64,
}

#[derive(Default)]
struct Inner {
    sources: BTreeMap<String, Source>,
    requests: VecDeque<Request>,
    replies: BTreeMap<String, Reply>,
    next: u64,
    revision: u64,
    reply_seq: u64,
}

#[derive(Default)]
pub struct Bridge {
    inner: Mutex<Inner>,
    changed: Condvar,
}

impl Bridge {
    pub fn new() -> Self {
        Self::default()
    }
    /// Starts reporting for a session's program and returns its secret token.
    pub fn register(&self, session: &str, program: Program) -> String {
        let token = token();
        let mut inner = self.inner.lock().unwrap();
        inner.sources.insert(
            session.into(),
            Source {
                program,
                token: token.clone(),
                activity: Activity::Ready,
                since: now(),
                detail: format!("{} is starting", program.label()),
                conversation: None,
                seen: BTreeMap::new(),
                uncertain: false,
            },
        );
        inner.revision += 1;
        token
    }
    pub fn authenticate(&self, session: &str, token: &str) -> bool {
        let inner = self.inner.lock().unwrap();
        inner
            .sources
            .get(session)
            .is_some_and(|source| same(&source.token, token))
    }
    /// Expires the session's requests and forgets its source and reply.
    pub fn remove_session(&self, session: &str) {
        let mut inner = self.inner.lock().unwrap();
        let removed = inner.sources.remove(session).is_some();
        inner.replies.remove(session);
        let expired = expire(&mut inner, |r| r.session == session, "Terminal closed");
        if removed || expired {
            inner.revision += 1;
            self.changed.notify_all();
        }
    }
    /// Applies one event; a request makes the helper wait for an answer.
    pub fn report(&self, session: &str, payload: &str) -> Result<Outcome, String> {
        let mut inner = self.inner.lock().unwrap();
        let program = inner
            .sources
            .get(session)
            .map(|source| source.program)
            .ok_or("Terminal has no program bridge")?;
        let value = json::parse_limited(payload, PAYLOAD_LIMIT)?;
        let signal = match program {
            Program::Claude => claude::interpret(&value),
            Program::Codex => codex::interpret(&value),
            Program::Jecode => Signal::Ignore,
        };
        let label = program.label();
        if matches!(
            signal,
            Signal::Turn(..)
                | Signal::Reply(_)
                | Signal::Failure(_)
                | Signal::Started(_)
                | Signal::Ended
        ) && let Some(source) = inner.sources.get_mut(session)
        {
            source.seen.clear();
            source.uncertain = false;
        }
        if matches!(
            signal,
            Signal::Turn(..) | Signal::Reply(_) | Signal::Failure(_)
        ) {
            // The program moved on, so open requests were settled locally.
            expire(&mut inner, |r| r.session == session, IN_TERMINAL);
        }
        let outcome = match signal {
            Signal::Ignore => return Ok(Outcome::Respond(String::new())),
            Signal::Activity(activity, detail) | Signal::Turn(activity, detail) => {
                set_activity(&mut inner, session, activity, detail);
                Outcome::Respond(String::new())
            }
            Signal::Ran { tool, input } => {
                // A run of one of several identical requests could belong to
                // a different waiting, pending or resolved request. Leave the
                // remaining requests to a turn/session boundary in that case.
                let unique = inner.sources.get(session).is_some_and(|source| {
                    !source.uncertain && source.seen.get(&(tool.clone(), input)) == Some(&1)
                });
                if !unique {
                    return Ok(Outcome::Respond(String::new()));
                }
                let matching = inner
                    .requests
                    .iter()
                    .find(|r| {
                        r.state == State::Waiting
                            && r.session == session
                            && r.draft.tool == tool
                            && r.draft.input == input
                    })
                    .map(|r| r.id.clone());
                let Some(matching) = matching else {
                    return Ok(Outcome::Respond(String::new()));
                };
                expire(&mut inner, |r| r.id == matching, "Answered in the terminal");
                if !inner
                    .requests
                    .iter()
                    .any(|r| r.session == session && live(r))
                {
                    set_activity(
                        &mut inner,
                        session,
                        Activity::Working,
                        format!("{label} is working"),
                    );
                }
                Outcome::Respond(String::new())
            }
            Signal::Reply(text) => {
                inner.reply_seq += 1;
                let reply = Reply {
                    seq: inner.reply_seq,
                    session: session.into(),
                    program,
                    text: bounded(&text, REPLY_LIMIT),
                    at: now(),
                };
                inner.replies.insert(session.into(), reply);
                set_activity(
                    &mut inner,
                    session,
                    Activity::Idle,
                    format!("{label} replied"),
                );
                Outcome::Respond(String::new())
            }
            Signal::Failure(detail) => {
                set_activity(&mut inner, session, Activity::Failed, detail);
                Outcome::Respond(String::new())
            }
            Signal::Started(conversation) => {
                // A new program session invalidates every earlier request.
                expire(
                    &mut inner,
                    |r| r.session == session,
                    "Program session changed",
                );
                if let Some(source) = inner.sources.get_mut(session) {
                    source.conversation = conversation;
                }
                set_activity(
                    &mut inner,
                    session,
                    Activity::Ready,
                    format!("{label} is ready"),
                );
                Outcome::Respond(String::new())
            }
            Signal::Ended => {
                expire(
                    &mut inner,
                    |r| r.session == session,
                    "Program session ended",
                );
                set_activity(
                    &mut inner,
                    session,
                    Activity::Ended,
                    format!("{label} ended"),
                );
                Outcome::Respond(String::new())
            }
            Signal::Request(draft) => {
                let live = inner.requests.iter().filter(|r| live(r)).count();
                if live >= LIVE_LIMIT {
                    // Too many open requests: the program asks in the terminal.
                    return Ok(Outcome::Respond(String::new()));
                }
                if let Some(source) = inner.sources.get_mut(session)
                    && !source.uncertain
                {
                    if draft.tool.len() > 256 {
                        source.seen.clear();
                        source.uncertain = true;
                    } else {
                        let key = (draft.tool.clone(), draft.input);
                        if let Some(count) = source.seen.get_mut(&key) {
                            *count = 2;
                        } else if source.seen.len() < TOOL_KEYS_LIMIT {
                            source.seen.insert(key, 1);
                        } else {
                            // A very long turn cannot retain every identity.
                            // Disable heuristic retirement until its boundary.
                            source.seen.clear();
                            source.uncertain = true;
                        }
                    }
                }
                inner.next += 1;
                inner.revision += 1;
                let (id, revision) = (format!("r{}", inner.next), inner.revision);
                let detail = match draft.kind {
                    Kind::Question => format!("{label} asks a question"),
                    _ => format!("{label} needs approval for {}", draft.tool),
                };
                inner.requests.push_back(Request {
                    id: id.clone(),
                    session: session.into(),
                    program,
                    draft,
                    revision,
                    state: State::Waiting,
                    outcome: String::new(),
                    body: None,
                    created: now(),
                });
                trim(&mut inner);
                set_activity(&mut inner, session, Activity::Waiting, detail);
                Outcome::Wait(id)
            }
        };
        inner.revision += 1;
        self.changed.notify_all();
        Ok(outcome)
    }
    /// Waits for an answer. `connected` reports whether the helper is still
    /// waiting; a closed helper means the program moved on without us.
    pub fn wait(&self, id: &str, deadline: Instant, mut connected: impl FnMut() -> bool) -> String {
        let mut inner = self.inner.lock().unwrap();
        loop {
            let Some(request) = inner.requests.iter_mut().find(|r| r.id == id) else {
                return String::new();
            };
            match request.state {
                State::Pending => {
                    request.state = State::Resolved;
                    let body = request.body.take().unwrap_or_default();
                    inner.revision += 1;
                    self.changed.notify_all();
                    return body;
                }
                State::Resolved | State::Expired => return String::new(),
                State::Waiting => {}
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() || !connected() {
                let reason = if remaining.is_zero() {
                    "No answer in time; the program asks in the terminal"
                } else {
                    IN_TERMINAL
                };
                expire(&mut inner, |r| r.id == id, reason);
                inner.revision += 1;
                self.changed.notify_all();
                return String::new();
            }
            inner = self
                .changed
                .wait_timeout(inner, remaining.min(POLL))
                .unwrap()
                .0;
        }
    }
    /// Records that the program did not receive a resolved answer.
    pub fn undelivered(&self, id: &str) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(request) = inner.requests.iter_mut().find(|r| r.id == id) {
            request.state = State::Expired;
            request.outcome = "The program stopped waiting before the answer arrived".into();
            inner.revision += 1;
            self.changed.notify_all();
        }
    }
    pub fn session_of(&self, id: &str) -> Option<String> {
        let inner = self.inner.lock().unwrap();
        inner
            .requests
            .iter()
            .find(|r| r.id == id)
            .map(|r| r.session.clone())
    }
    /// Accepts one answer for a waiting request at the shown revision. The
    /// caller holds the session's control fence while this runs.
    pub fn respond(&self, id: &str, revision: u64, answer: Answer) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        let request = inner
            .requests
            .iter_mut()
            .find(|r| r.id == id)
            .ok_or("Request is no longer available")?;
        if request.state != State::Waiting {
            return Err("Request was already answered or has expired".into());
        }
        if request.revision != revision {
            return Err("Request changed; review it again".into());
        }
        let (body, outcome) = match request.program {
            Program::Claude => claude::decision(&request.draft, &answer)?,
            _ => return Err("This program does not accept answers from Webterminal".into()),
        };
        request.body = Some(body);
        request.outcome = outcome;
        request.state = State::Pending;
        let (session, label) = (request.session.clone(), request.program.label());
        inner.revision += 1;
        request_revision(&mut inner, id);
        set_activity(
            &mut inner,
            &session,
            Activity::Working,
            format!("{label} is working"),
        );
        inner.revision += 1;
        self.changed.notify_all();
        Ok(())
    }
    pub fn revision(&self) -> u64 {
        self.inner.lock().unwrap().revision
    }
    pub fn reply_seq(&self) -> u64 {
        self.inner.lock().unwrap().reply_seq
    }
    /// Latest reply per session newer than `after`, oldest first.
    pub fn replies_after(&self, after: u64) -> Vec<Reply> {
        let inner = self.inner.lock().unwrap();
        let mut replies: Vec<Reply> = inner
            .replies
            .values()
            .filter(|reply| reply.seq > after)
            .cloned()
            .collect();
        replies.sort_by_key(|reply| reply.seq);
        replies
    }
    pub fn json(&self) -> String {
        ledger::render(&self.inner.lock().unwrap())
    }
}

/// Writes the bridge helper settings for a program and returns its arguments.
pub fn adapter_arguments(
    program: Program,
    helper: &Path,
    directory: &Path,
    endpoint: (u16, &str, &str),
) -> std::io::Result<Vec<String>> {
    match program {
        Program::Claude => claude::arguments(helper, directory, endpoint),
        Program::Codex => Ok(codex::arguments(helper, endpoint)),
        Program::Jecode => Ok(Vec::new()),
    }
}

#[cfg(test)]
#[path = "bridge/tests.rs"]
mod tests;
