//! In-memory session ownership, control fencing, and independent console draining.
mod state;

pub use state::Session;

use crate::{
    json, native,
    terminal::Terminal,
    uploads::Uploads,
    workspaces::{self, Workspaces},
};
use state::{INPUT_LIMIT, Input, State};
use std::collections::{HashSet, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, Ordering},
    mpsc,
};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const SESSION_LIMIT: usize = 32;
static NEXT_VIEW: AtomicU64 = AtomicU64::new(1);

pub fn new_view() -> String {
    format!("v{}", NEXT_VIEW.fetch_add(1, Ordering::Relaxed))
}

pub fn geometry(value: &json::Value) -> Result<(u16, u16), String> {
    let cols = value.integer("cols")?;
    let rows = value.integer("rows")?;
    if !(2..=300).contains(&cols) || !(1..=120).contains(&rows) {
        return Err("Terminal size must be 2..300 columns and 1..120 rows".into());
    }
    Ok((cols as u16, rows as u16))
}

/// Sessions and their workspace organization change under one lock.
struct Inner {
    sessions: Vec<Arc<Session>>,
    workspaces: Workspaces,
}

pub struct Registry {
    inner: Mutex<Inner>,
    next: AtomicU64,
    pub uploads: Uploads,
    pub cwd: PathBuf,
    pub shell: String,
}

/// A close that needs confirmation names the busy sessions and the exact
/// targets the confirmation must repeat.
pub enum WorkspaceClose {
    Closed,
    Busy {
        sessions: Vec<String>,
        targets: Vec<String>,
    },
}

impl Registry {
    pub fn new(cwd: PathBuf, shell: String, uploads: Uploads) -> Self {
        Self {
            inner: Mutex::new(Inner {
                sessions: Vec::new(),
                workspaces: Workspaces::default(),
            }),
            next: AtomicU64::new(1),
            cwd,
            shell,
            uploads,
        }
    }
    /// Starts a shell session in `workspace`, or in the first workspace with
    /// room. Returns the session and the workspace that received it.
    pub fn create(
        &self,
        cwd: &Path,
        cols: u16,
        rows: u16,
        view: &str,
        workspace: Option<&str>,
    ) -> Result<(Arc<Session>, String), String> {
        let path = cwd
            .canonicalize()
            .map_err(|e| format!("Cannot open directory: {e}"))?;
        if !path.is_dir() {
            return Err("Working directory must be a directory".into());
        }
        let mut inner = self.inner.lock().unwrap();
        if inner.sessions.len() >= SESSION_LIMIT {
            return Err("Session limit reached (32); close a terminal first".into());
        }
        let placement = inner.workspaces.placement(workspace)?;
        let id = format!("s{}", self.next.fetch_add(1, Ordering::Relaxed));
        let spawned = native::spawn(&self.shell, &path, cols, rows)
            .map_err(|e| format!("Cannot start terminal: {e}"))?;
        self.uploads.open_session(&id);
        let (sender, receiver) = mpsc::sync_channel(32);
        let session = Arc::new(Session {
            id: id.clone(),
            cwd: path,
            shell: self.shell.clone(),
            created: unix_ms(),
            pty: spawned.pty,
            input: sender,
            control: Mutex::new(()),
            state: Mutex::new(State {
                terminal: Terminal::new(cols as usize, rows as usize),
                name: None,
                revision: 1,
                epoch: 1,
                controller: Some(view.into()),
                viewers: HashSet::from([view.into()]),
                last_input: 0,
                alive: true,
                exit_code: None,
                sync_since: None,
                events: VecDeque::new(),
                event_seq: 0,
            }),
        });
        inner.sessions.push(session.clone());
        let workspace = inner.workspaces.insert(placement, &id);
        drop(inner);
        let weak = Arc::downgrade(&session);
        let mut input = spawned.input;
        thread::spawn(move || {
            while let Ok(message) = receiver.recv() {
                let Some(session) = weak.upgrade() else {
                    break;
                };
                let _gate = session.control.lock().unwrap();
                let state = session.state.lock().unwrap();
                let valid = state.alive && message.epoch.is_none_or(|epoch| epoch == state.epoch);
                drop(state);
                if valid && input.write_all(&message.data).is_err() {
                    break;
                }
            }
        });
        let reader_session = session.clone();
        let mut output = spawned.output;
        thread::spawn(move || {
            let mut buffer = [0; 16_384];
            loop {
                match output.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(n) => {
                        let mut state = reader_session.state.lock().unwrap();
                        let responses = state.terminal.feed(&buffer[..n]);
                        if state.terminal.synchronized() {
                            state.sync_since.get_or_insert_with(Instant::now);
                        } else {
                            state.sync_since = None;
                        }
                        for event in state.terminal.take_events() {
                            state.event_seq += 1;
                            let seq = state.event_seq;
                            if state.events.len() == 8 {
                                state.events.pop_front();
                            }
                            state.events.push_back((seq, event));
                        }
                        state.revision += 1;
                        drop(state);
                        if responses.len() > INPUT_LIMIT
                            || (!responses.is_empty()
                                && reader_session
                                    .input
                                    .try_send(Input {
                                        epoch: None,
                                        data: responses,
                                    })
                                    .is_err())
                        {
                            let _ = reader_session.pty.terminate();
                            break;
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            reader_session.exited();
        });
        let monitor_session = session.clone();
        thread::spawn(move || {
            loop {
                match monitor_session.pty.exit_code() {
                    Ok(Some(code)) => {
                        {
                            let mut state = monitor_session.state.lock().unwrap();
                            state.exit_code = Some(code);
                        }
                        let _ = monitor_session.pty.terminate();
                        break;
                    }
                    Err(_) => break,
                    Ok(None) => {}
                }
                if !monitor_session.state.lock().unwrap().alive {
                    break;
                }
                thread::sleep(Duration::from_millis(50));
            }
        });
        Ok((session, workspace))
    }
    pub fn get(&self, id: &str) -> Result<Arc<Session>, String> {
        self.inner
            .lock()
            .unwrap()
            .sessions
            .iter()
            .find(|session| session.id == id)
            .cloned()
            .ok_or_else(|| "Terminal session no longer exists".into())
    }
    pub fn all(&self) -> Vec<Arc<Session>> {
        self.inner.lock().unwrap().sessions.clone()
    }
    pub fn rename(&self, id: &str, name: &str) -> Result<(), String> {
        let name = workspaces::custom_name(name, "Terminal")?;
        self.get(id)?.state.lock().unwrap().name = name;
        Ok(())
    }
    pub fn create_workspace(&self) -> Result<String, String> {
        self.inner.lock().unwrap().workspaces.create()
    }
    pub fn rename_workspace(&self, id: &str, name: &str) -> Result<(), String> {
        self.inner.lock().unwrap().workspaces.rename(id, name)
    }
    pub fn order_workspaces(&self, ids: &[String]) -> Result<(), String> {
        self.inner.lock().unwrap().workspaces.reorder(ids)
    }
    pub fn move_session(&self, id: &str, workspace: &str, position: usize) -> Result<(), String> {
        self.inner
            .lock()
            .unwrap()
            .workspaces
            .move_session(id, workspace, position)
    }
    /// Checks the view's observed targets and removes the workspace under the same lock.
    pub fn close_workspace(
        &self,
        id: &str,
        observed: &[String],
        force: bool,
    ) -> Result<WorkspaceClose, String> {
        let mut inner = self.inner.lock().unwrap();
        let targets = inner.workspaces.sessions(id)?.to_vec();
        let busy = busy_among(&inner, &targets);
        if !same_set(observed, &targets) || (!busy.is_empty() && !force) {
            return Ok(WorkspaceClose::Busy {
                sessions: busy,
                targets,
            });
        }
        let ids = inner.workspaces.close(id)?;
        let closed = take_sessions(&mut inner, &ids);
        drop(inner);
        self.finish(closed);
        Ok(WorkspaceClose::Closed)
    }
    /// Closes exactly `ids`. Busy terminals need `force`, which repeats a
    /// confirmation of this same set; a set that changed is refused.
    pub fn close_sessions(&self, ids: &[String], force: bool) -> Result<WorkspaceClose, String> {
        let mut inner = self.inner.lock().unwrap();
        if ids.is_empty() || ids.len() > SESSION_LIMIT {
            return Err("Select 1..32 terminals to close".into());
        }
        let unique = ids.iter().collect::<HashSet<_>>();
        if unique.len() != ids.len() {
            return Err("Selection contains duplicate terminals".into());
        }
        if ids
            .iter()
            .any(|id| !inner.sessions.iter().any(|s| &s.id == id))
        {
            return Err("Selection changed; some terminals already closed".into());
        }
        let busy = busy_among(&inner, ids);
        if !busy.is_empty() && !force {
            return Ok(WorkspaceClose::Busy {
                sessions: busy,
                targets: ids.to_vec(),
            });
        }
        for id in ids {
            inner.workspaces.remove_session(id);
        }
        let closed = take_sessions(&mut inner, ids);
        drop(inner);
        self.finish(closed);
        Ok(WorkspaceClose::Closed)
    }
    /// Sessions in workspace and pane order, plus the workspaces themselves.
    pub fn list_json(&self) -> String {
        let inner = self.inner.lock().unwrap();
        let entries = inner
            .workspaces
            .order()
            .filter_map(|id| inner.sessions.iter().find(|session| session.id == id))
            .map(|session| session.json())
            .collect::<Vec<_>>()
            .join(",");
        format!(
            "{{\"type\":\"sessions\",\"sessions\":[{entries}],\"workspaces\":{}}}",
            inner.workspaces.json()
        )
    }
    pub fn detach_view(&self, view: &str) {
        for session in self.all() {
            session.detach(view);
        }
    }
    pub fn close(&self, id: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        if !inner.sessions.iter().any(|session| session.id == id) {
            return Err("Terminal session no longer exists".into());
        }
        inner.workspaces.remove_session(id);
        let closed = take_sessions(&mut inner, &[id.to_owned()]);
        drop(inner);
        self.finish(closed);
        Ok(())
    }
    pub fn shutdown(&self) {
        let sessions = std::mem::take(&mut self.inner.lock().unwrap().sessions);
        self.finish(sessions);
        self.uploads.remove_all();
    }
    /// Stops owned processes and releases everything tied to the sessions.
    fn finish(&self, closed: Vec<Arc<Session>>) {
        for session in closed {
            session.stop();
            self.uploads.remove_session(&session.id);
        }
    }
}

fn busy_among(inner: &Inner, ids: &[String]) -> Vec<String> {
    inner
        .sessions
        .iter()
        .filter(|session| ids.contains(&session.id) && session.busy())
        .map(|session| session.id.clone())
        .collect()
}
fn same_set(confirmed: &[String], targets: &[String]) -> bool {
    let unique = confirmed.iter().map(String::as_str).collect::<HashSet<_>>();
    confirmed.len() == targets.len()
        && unique.len() == confirmed.len()
        && targets.iter().all(|id| unique.contains(id.as_str()))
}
fn take_sessions(inner: &mut Inner, ids: &[String]) -> Vec<Arc<Session>> {
    let mut closed = Vec::new();
    inner.sessions.retain(|session| {
        let keep = !ids.contains(&session.id);
        if !keep {
            closed.push(session.clone());
        }
        keep
    });
    closed
}
pub(crate) fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| time.as_millis() as u64)
}
