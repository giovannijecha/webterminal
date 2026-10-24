//! In-memory session ownership, control fencing, and independent console draining.
mod state;

pub use state::Session;

use crate::{
    json, native,
    settings::TerminalTheme,
    terminal::{Terminal, TerminalPalette},
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
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub const SESSION_LIMIT: usize = 32;
pub const MAX_COLS: i64 = 300;
pub const MAX_ROWS: i64 = 120;
static NEXT_VIEW: AtomicU64 = AtomicU64::new(1);

pub fn new_view() -> String {
    format!("v{}", NEXT_VIEW.fetch_add(1, Ordering::Relaxed))
}

pub fn geometry(value: &json::Value) -> Result<(u16, u16), String> {
    let cols = value.integer("cols")?;
    let rows = value.integer("rows")?;
    if !(2..=MAX_COLS).contains(&cols) || !(1..=MAX_ROWS).contains(&rows) {
        return Err("Terminal size must be 2..300 columns and 1..120 rows".into());
    }
    Ok((cols as u16, rows as u16))
}

/// Sessions and their workspace organization change under one lock.
struct Inner {
    sessions: Vec<Arc<Session>>,
    workspaces: Workspaces,
    pending: usize,
    theme: TerminalTheme,
    closing: bool,
}

pub struct Registry {
    inner: Mutex<Inner>,
    next: AtomicU64,
    list_revision: Arc<AtomicU64>,
    title_revision: Arc<AtomicU64>,
    list_cache: Mutex<(u64, u64, String)>,
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
                pending: 0,
                theme: TerminalTheme::Dark,
                closing: false,
            }),
            next: AtomicU64::new(1),
            list_revision: Arc::new(AtomicU64::new(1)),
            title_revision: Arc::new(AtomicU64::new(1)),
            list_cache: Mutex::new((0, 0, String::new())),
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
        let path = native::ordinary_path(&path);
        if !path.is_dir() {
            return Err("Working directory must be a directory".into());
        }
        {
            let mut inner = self.inner.lock().unwrap();
            if inner.closing {
                return Err("Server is stopping".into());
            }
            if inner.sessions.len() + inner.pending >= SESSION_LIMIT {
                return Err("Session limit reached (32); close a terminal first".into());
            }
            inner.workspaces.placement(workspace)?;
            inner.pending += 1;
        }
        let id = format!("s{}", self.next.fetch_add(1, Ordering::Relaxed));
        let spawned = native::spawn(&self.shell, &path, cols, rows);
        let mut inner = self.inner.lock().unwrap();
        inner.pending -= 1;
        let spawned = spawned.map_err(|e| format!("Cannot start terminal: {e}"))?;
        if inner.closing {
            drop(inner);
            let _ = spawned.pty.terminate();
            return Err("Server is stopping".into());
        }
        let placement = match inner.workspaces.placement(workspace) {
            Ok(placement) => placement,
            Err(error) => {
                drop(inner);
                let _ = spawned.pty.terminate();
                return Err(error);
            }
        };
        self.uploads.open_session(&id);
        let (sender, receiver) = mpsc::sync_channel(32);
        let mut terminal = Terminal::new(cols as usize, rows as usize);
        terminal.set_palette(theme_palette(inner.theme));
        let session = Arc::new(Session {
            id: id.clone(),
            cwd: path,
            shell: self.shell.clone(),
            created: unix_ms(),
            pty: spawned.pty,
            input: sender,
            list_revision: self.list_revision.clone(),
            title_revision: self.title_revision.clone(),
            control: Mutex::new(()),
            state: Mutex::new(State {
                terminal,
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
        self.changed();
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
                        let old_title = state.terminal.title().to_owned();
                        let responses = state.terminal.feed(&buffer[..n]);
                        if state.terminal.title() != old_title {
                            reader_session
                                .title_revision
                                .fetch_add(1, Ordering::Release);
                        }
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
            if let Ok(code) = monitor_session.pty.wait_exit() {
                let mut state = monitor_session.state.lock().unwrap();
                state.exit_code = Some(code);
                state.revision += 1;
                monitor_session
                    .list_revision
                    .fetch_add(1, Ordering::Release);
                drop(state);
                let _ = monitor_session.pty.terminate();
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
    pub fn set_theme(&self, theme: TerminalTheme) {
        let mut inner = self.inner.lock().unwrap();
        if inner.theme == theme {
            return;
        }
        inner.theme = theme;
        for session in &inner.sessions {
            let mut state = session.state.lock().unwrap();
            state.terminal.set_palette(theme_palette(theme));
            state.revision += 1;
        }
    }
    pub fn all(&self) -> Vec<Arc<Session>> {
        self.inner.lock().unwrap().sessions.clone()
    }
    pub fn rename(&self, id: &str, name: &str) -> Result<(), String> {
        let name = workspaces::custom_name(name, "Terminal")?;
        let inner = self.inner.lock().unwrap();
        let session = inner
            .sessions
            .iter()
            .find(|session| session.id == id)
            .ok_or("Terminal session no longer exists")?;
        let mut state = session.state.lock().unwrap();
        state.name = name;
        self.changed();
        Ok(())
    }
    pub fn create_workspace(&self) -> Result<String, String> {
        let mut inner = self.inner.lock().unwrap();
        let result = inner.workspaces.create();
        if result.is_ok() {
            self.changed();
        }
        result
    }
    pub fn rename_workspace(&self, id: &str, name: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        let result = inner.workspaces.rename(id, name);
        if result.is_ok() {
            self.changed();
        }
        result
    }
    pub fn order_workspaces(&self, ids: &[String]) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        let result = inner.workspaces.reorder(ids);
        if result.is_ok() {
            self.changed();
        }
        result
    }
    pub fn move_session(&self, id: &str, workspace: &str, position: usize) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        let result = inner.workspaces.move_session(id, workspace, position);
        if result.is_ok() {
            self.changed();
        }
        result
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
        self.changed();
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
        self.changed();
        drop(inner);
        self.finish(closed);
        Ok(WorkspaceClose::Closed)
    }
    /// Sessions in workspace and pane order, plus the workspaces themselves.
    pub fn list_json(&self) -> String {
        let revision = self.list_revision();
        let mut cache = self.list_cache.lock().unwrap();
        if (cache.0, cache.1) == revision {
            return cache.2.clone();
        }
        let inner = self.inner.lock().unwrap();
        let entries = inner
            .workspaces
            .order()
            .filter_map(|id| inner.sessions.iter().find(|session| session.id == id))
            .map(|session| session.json())
            .collect::<Vec<_>>()
            .join(",");
        let result = format!(
            "{{\"type\":\"sessions\",\"sessions\":[{entries}],\"workspaces\":{}}}",
            inner.workspaces.json()
        );
        // A concurrent terminal title can change while entries are rendered.
        // In that case the next poll rebuilds the list.
        (cache.0, cache.1) = revision;
        cache.2 = result.clone();
        result
    }
    pub fn list_revision(&self) -> (u64, u64) {
        (
            self.list_revision.load(Ordering::Acquire),
            self.title_revision.load(Ordering::Acquire),
        )
    }
    fn changed(&self) {
        self.list_revision.fetch_add(1, Ordering::Release);
    }
    pub fn detach_view(&self, view: &str) {
        for session in self.all() {
            session.detach(view);
        }
    }
    pub fn close(&self, id: &str, force: bool) -> Result<WorkspaceClose, String> {
        let mut inner = self.inner.lock().unwrap();
        let session = inner
            .sessions
            .iter()
            .find(|session| session.id == id)
            .ok_or("Terminal session no longer exists")?;
        if session.busy() && !force {
            return Ok(WorkspaceClose::Busy {
                sessions: vec![id.to_owned()],
                targets: vec![id.to_owned()],
            });
        }
        inner.workspaces.remove_session(id);
        let closed = take_sessions(&mut inner, &[id.to_owned()]);
        self.changed();
        drop(inner);
        self.finish(closed);
        Ok(WorkspaceClose::Closed)
    }
    pub fn shutdown(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.closing = true;
        let sessions = std::mem::take(&mut inner.sessions);
        for session in &sessions {
            session.mark_closed();
        }
        self.changed();
        drop(inner);
        self.finish(sessions);
        self.uploads.remove_all();
    }
    /// Stops owned processes and releases everything tied to the sessions.
    fn finish(&self, closed: Vec<Arc<Session>>) {
        for session in closed {
            session.terminate();
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
    for session in &closed {
        session.mark_closed();
    }
    closed
}
pub(crate) fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| time.as_millis() as u64)
}

fn theme_palette(theme: TerminalTheme) -> TerminalPalette {
    match theme {
        TerminalTheme::Dark => TerminalPalette::DARK,
        TerminalTheme::Light => TerminalPalette::LIGHT,
    }
}
