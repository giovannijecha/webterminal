//! In-memory session ownership, control fencing, and independent console draining.
use crate::{
    json, native,
    terminal::{Event, SnapshotBaseline, Terminal},
    workspaces::{self, Workspaces},
};
use std::collections::{HashSet, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, Ordering},
    mpsc::{self, SyncSender},
};
use std::thread;
use std::time::{Duration, Instant};

const SESSION_LIMIT: usize = 32;
const INPUT_LIMIT: usize = 65_536;
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
    pub cwd: PathBuf,
    pub shell: String,
}

pub enum WorkspaceClose {
    Closed,
    Busy {
        sessions: Vec<String>,
        targets: Vec<String>,
    },
}

impl Registry {
    pub fn new(cwd: PathBuf, shell: String) -> Self {
        Self {
            inner: Mutex::new(Inner {
                sessions: Vec::new(),
                workspaces: Workspaces::default(),
            }),
            next: AtomicU64::new(1),
            cwd,
            shell,
        }
    }
    /// Starts a session in `workspace`, or in the first workspace with room.
    /// Returns the session and the workspace that received it.
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
        let spawned = native::spawn(&self.shell, &path, cols, rows)
            .map_err(|e| format!("Cannot start terminal: {e}"))?;
        let id = format!("s{}", self.next.fetch_add(1, Ordering::Relaxed));
        let (sender, receiver) = mpsc::sync_channel(32);
        let session = Arc::new(Session {
            id: id.clone(),
            cwd: path,
            shell: self.shell.clone(),
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
    /// Checks the confirmation and removes the workspace under the same lock.
    pub fn close_workspace(
        &self,
        id: &str,
        confirmed: Option<&[String]>,
    ) -> Result<WorkspaceClose, String> {
        let mut inner = self.inner.lock().unwrap();
        let targets = inner.workspaces.sessions(id)?.to_vec();
        let busy = inner
            .sessions
            .iter()
            .filter(|session| targets.contains(&session.id) && session.busy())
            .map(|session| session.id.clone())
            .collect::<Vec<_>>();
        if let Some(confirmed) = confirmed {
            let unique = confirmed.iter().map(String::as_str).collect::<HashSet<_>>();
            if confirmed.len() != targets.len()
                || unique.len() != confirmed.len()
                || targets.iter().any(|id| !unique.contains(id.as_str()))
            {
                if busy.is_empty() {
                    return Err("Workspace confirmation expired; retry close".into());
                }
                return Ok(WorkspaceClose::Busy {
                    sessions: busy,
                    targets,
                });
            }
        } else if !busy.is_empty() {
            return Ok(WorkspaceClose::Busy {
                sessions: busy,
                targets,
            });
        }
        let ids = inner.workspaces.close(id)?;
        let mut closed = Vec::new();
        inner.sessions.retain(|session| {
            let keep = !ids.contains(&session.id);
            if !keep {
                closed.push(session.clone());
            }
            keep
        });
        drop(inner);
        for session in closed {
            session.stop();
        }
        Ok(WorkspaceClose::Closed)
    }
    /// Sessions in workspace and pane order, plus the workspaces themselves.
    pub fn list_json(&self) -> String {
        let inner = self.inner.lock().unwrap();
        let entries = inner.workspaces.order().filter_map(|id| inner.sessions.iter().find(|session| session.id == id)).map(|session| {
            let state = session.state.lock().unwrap();
            format!("{{\"id\":{},\"cwd\":{},\"shell\":{},\"title\":{},\"name\":{},\"alive\":{},\"controller\":{},\"exitCode\":{}}}",
                json::quote(&session.id), json::quote(&session.cwd.to_string_lossy()), json::quote(&session.shell),
                json::quote(state.terminal.title()),
                optional_string(&state.name),
                state.alive, optional_string(&state.controller), optional_code(state.exit_code))
        }).collect::<Vec<_>>().join(",");
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
        let index = inner
            .sessions
            .iter()
            .position(|session| session.id == id)
            .ok_or("Terminal session no longer exists")?;
        let session = inner.sessions.remove(index);
        inner.workspaces.remove_session(id);
        drop(inner);
        session.stop();
        Ok(())
    }
    pub fn shutdown(&self) {
        let sessions = std::mem::take(&mut self.inner.lock().unwrap().sessions);
        for session in &sessions {
            session.stop();
        }
    }
}

pub struct Session {
    pub id: String,
    pub cwd: PathBuf,
    pub shell: String,
    pty: Arc<native::Pty>,
    input: SyncSender<Input>,
    control: Mutex<()>,
    state: Mutex<State>,
}
struct Input {
    epoch: Option<u64>,
    data: Vec<u8>,
}
struct State {
    terminal: Terminal,
    name: Option<String>,
    revision: u64,
    epoch: u64,
    controller: Option<String>,
    viewers: HashSet<String>,
    last_input: u64,
    alive: bool,
    exit_code: Option<u32>,
    sync_since: Option<Instant>,
    events: VecDeque<(u64, Event)>,
    event_seq: u64,
}

impl Session {
    pub fn attach(&self, view: &str, size: (u16, u16)) -> Result<(), String> {
        let _gate = self.control.lock().unwrap();
        let mut state = self.state.lock().unwrap();
        state.viewers.insert(view.into());
        let resize = state.controller.is_none() && state.alive;
        if resize {
            state.transfer(Some(view));
        }
        state.revision += 1;
        drop(state);
        if resize {
            self.resize_locked(size)?;
        }
        Ok(())
    }
    pub fn claim(&self, view: &str, size: (u16, u16)) -> Result<(), String> {
        let _gate = self.control.lock().unwrap();
        let mut state = self.state.lock().unwrap();
        if !state.alive {
            return Err("Terminal process has exited".into());
        }
        if !state.viewers.contains(view) {
            return Err("Attach to the session before taking control".into());
        }
        state.transfer(Some(view));
        drop(state);
        self.resize_locked(size)
    }
    pub fn release(&self, view: &str) -> Result<(), String> {
        let _gate = self.control.lock().unwrap();
        let mut state = self.state.lock().unwrap();
        if state.controller.as_deref() != Some(view) {
            return Err("This view does not control the terminal".into());
        }
        state.transfer(None);
        Ok(())
    }
    pub fn detach(&self, view: &str) {
        let _gate = self.control.lock().unwrap();
        let mut state = self.state.lock().unwrap();
        state.viewers.remove(view);
        if state.controller.as_deref() == Some(view) {
            state.transfer(None);
        }
    }
    pub fn send_input(&self, view: &str, epoch: i64, seq: i64, data: &str) -> Result<(), String> {
        if data.len() > INPUT_LIMIT {
            return Err("Input exceeds 65536 UTF-8 bytes".into());
        }
        let mut state = self.state.lock().unwrap();
        state.check_control(view, epoch)?;
        if seq <= 0 || seq as u64 <= state.last_input {
            return Err("Duplicate or out-of-order input rejected".into());
        }
        self.input
            .try_send(Input {
                epoch: Some(state.epoch),
                data: data.as_bytes().to_vec(),
            })
            .map_err(|_| "Terminal input queue is full or closed")?;
        state.last_input = seq as u64;
        Ok(())
    }
    pub fn resize(&self, view: &str, epoch: i64, size: (u16, u16)) -> Result<(), String> {
        let _gate = self.control.lock().unwrap();
        self.state.lock().unwrap().check_control(view, epoch)?;
        self.resize_locked(size)
    }
    fn resize_locked(&self, (cols, rows): (u16, u16)) -> Result<(), String> {
        // Holding the state lock keeps the output reader from feeding ConPTY's
        // post-resize repaint into the old geometry.
        let mut state = self.state.lock().unwrap();
        self.pty
            .resize(cols, rows)
            .map_err(|e| format!("Cannot resize terminal: {e}"))?;
        state.terminal.resize(cols as usize, rows as usize);
        state.revision += 1;
        Ok(())
    }
    pub fn snapshot(
        &self,
        after: u64,
        baseline: Option<&mut SnapshotBaseline>,
    ) -> Option<(u64, String)> {
        let mut state = self.state.lock().unwrap();
        if state
            .sync_since
            .is_some_and(|since| since.elapsed() >= Duration::from_secs(1))
        {
            state.terminal.expire_sync();
            state.sync_since = None;
            state.revision += 1;
        }
        if state.revision <= after || state.terminal.synchronized() {
            return None;
        }
        let compact = baseline.is_some();
        let terminal = match baseline {
            Some(baseline) => state.terminal.snapshot_update(baseline),
            None => state.terminal.snapshot_json(),
        };
        let kind = if compact && after != 0 {
            "update"
        } else {
            "snapshot"
        };
        let base = if kind == "update" {
            format!(",\"base\":{after}")
        } else {
            String::new()
        };
        let json = format!(
            "{{\"type\":\"{kind}\"{base},\"id\":{},\"seq\":{},\"epoch\":{},\"controller\":{},\"alive\":{},\"exitCode\":{},\"terminal\":{}}}",
            json::quote(&self.id),
            state.revision,
            state.epoch,
            optional_string(&state.controller),
            state.alive,
            optional_code(state.exit_code),
            terminal
        );
        Some((state.revision, json))
    }
    pub fn events(&self, after: u64) -> Vec<(u64, String)> {
        self.state
            .lock()
            .unwrap()
            .events
            .iter()
            .filter(|(seq, _)| *seq > after)
            .map(|(seq, event)| {
                let json = match event {
                    Event::Clipboard(data) => format!(
                        "{{\"type\":\"clipboard\",\"id\":{},\"data\":{}}}",
                        json::quote(&self.id),
                        json::quote(data)
                    ),
                    Event::Bell => {
                        format!("{{\"type\":\"bell\",\"id\":{}}}", json::quote(&self.id))
                    }
                };
                (*seq, json)
            })
            .collect()
    }
    pub fn latest_event(&self) -> u64 {
        self.state.lock().unwrap().event_seq
    }
    fn exited(&self) {
        let mut state = self.state.lock().unwrap();
        state.alive = false;
        state.transfer(None);
        state.terminal.expire_sync();
    }
    /// A live terminal is busy while its job holds more than the shell process.
    pub fn busy(&self) -> bool {
        self.state.lock().unwrap().alive
            && self.pty.active_processes().map_or(true, |count| count > 1)
    }
    fn stop(&self) {
        {
            let mut state = self.state.lock().unwrap();
            state.alive = false;
            state.transfer(None);
        }
        let _ = self.pty.terminate();
    }
}
impl State {
    fn transfer(&mut self, view: Option<&str>) {
        self.controller = view.map(str::to_owned);
        self.epoch += 1;
        self.last_input = 0;
        self.revision += 1;
    }
    fn check_control(&self, view: &str, epoch: i64) -> Result<(), String> {
        if !self.alive {
            return Err("Terminal process has exited".into());
        }
        if self.controller.as_deref() != Some(view) || epoch < 0 || self.epoch != epoch as u64 {
            return Err("Control changed; input or resize from this view was rejected".into());
        }
        Ok(())
    }
}
fn optional_string(value: &Option<String>) -> String {
    value
        .as_deref()
        .map(json::quote)
        .unwrap_or_else(|| "null".into())
}
fn optional_code(value: Option<u32>) -> String {
    value
        .map(|v| v.to_string())
        .unwrap_or_else(|| "null".into())
}
