//! One terminal session: control fencing, snapshots and terminal events.
use crate::{
    json,
    native::{self, ProcessList},
    terminal::{Event, SnapshotBaseline, Terminal},
};
use std::collections::{HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, Ordering},
    mpsc::SyncSender,
};
use std::time::{Duration, Instant};

pub(super) const INPUT_LIMIT: usize = 65_536;

pub struct Session {
    pub id: String,
    pub cwd: PathBuf,
    pub shell: String,
    /// Unix milliseconds when the terminal started.
    pub created: u64,
    pub(super) pty: Arc<native::Pty>,
    pub(super) input: SyncSender<Input>,
    pub(super) list_revision: Arc<AtomicU64>,
    pub(super) title_revision: Arc<AtomicU64>,
    pub(super) control: Mutex<()>,
    pub(super) state: Mutex<State>,
}
pub(super) struct Input {
    pub epoch: Option<u64>,
    pub data: Vec<u8>,
}
pub(super) struct State {
    pub terminal: Terminal,
    pub name: Option<String>,
    pub revision: u64,
    pub epoch: u64,
    pub controller: Option<String>,
    pub viewers: HashSet<String>,
    pub last_input: u64,
    pub alive: bool,
    pub exit_code: Option<u32>,
    pub sync_since: Option<Instant>,
    pub events: VecDeque<(u64, Event)>,
    pub event_seq: u64,
}

impl Session {
    pub fn attach(&self, view: &str, size: (u16, u16)) -> Result<(), String> {
        let _gate = self.control.lock().unwrap();
        let mut state = self.state.lock().unwrap();
        state.viewers.insert(view.into());
        let resize = state.controller.is_none() && state.alive;
        if resize {
            state.transfer(Some(view));
            self.list_revision.fetch_add(1, Ordering::Release);
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
        self.list_revision.fetch_add(1, Ordering::Release);
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
        self.list_revision.fetch_add(1, Ordering::Release);
        Ok(())
    }
    pub fn detach(&self, view: &str) {
        let _gate = self.control.lock().unwrap();
        let mut state = self.state.lock().unwrap();
        // Remaining views learn their new viewer count from the next snapshot.
        if state.viewers.remove(view) {
            state.revision += 1;
        }
        if state.controller.as_deref() == Some(view) {
            state.transfer(None);
            self.list_revision.fetch_add(1, Ordering::Release);
        }
    }
    /// Uploads follow the same control fence as input.
    pub fn check_control(&self, view: &str, epoch: i64) -> Result<(), String> {
        self.state.lock().unwrap().check_control(view, epoch)
    }
    /// Runs `action` only while `view` controls the terminal at `epoch`;
    /// control cannot change until it returns.
    pub fn with_control<T>(
        &self,
        view: &str,
        epoch: i64,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let _gate = self.control.lock().unwrap();
        self.check_control(view, epoch)?;
        action()
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
        let projection = state.terminal.projection();
        let revision = state.revision;
        let epoch = state.epoch;
        let controller = state.controller.clone();
        let viewers = state.viewers.len();
        let alive = state.alive;
        let exit_code = state.exit_code;
        drop(state);
        let terminal = match baseline {
            Some(baseline) => projection.snapshot_update(baseline),
            None => projection.snapshot_json(),
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
            "{{\"type\":\"{kind}\"{base},\"id\":{},\"seq\":{},\"epoch\":{},\"controller\":{},\"viewers\":{},\"alive\":{},\"exitCode\":{},\"terminal\":{}}}",
            json::quote(&self.id),
            revision,
            epoch,
            optional_string(&controller),
            viewers,
            alive,
            optional_code(exit_code),
            terminal
        );
        Some((revision, json))
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
    pub(super) fn exited(&self) {
        let mut state = self.state.lock().unwrap();
        state.alive = false;
        state.transfer(None);
        state.terminal.expire_sync();
        self.list_revision.fetch_add(1, Ordering::Release);
    }
    /// A live terminal is busy while its job holds more than the shell process.
    pub fn busy(&self) -> bool {
        self.state.lock().unwrap().alive
            && self.pty.active_processes().map_or(true, |count| count > 1)
    }
    /// Processes in this terminal's own job; empty once it has exited.
    pub fn processes(&self, limit: usize) -> std::io::Result<ProcessList> {
        if !self.state.lock().unwrap().alive {
            return Ok(ProcessList::default());
        }
        self.pty.processes(limit)
    }
    pub(super) fn mark_closed(&self) {
        {
            let mut state = self.state.lock().unwrap();
            state.alive = false;
            state.transfer(None);
            self.list_revision.fetch_add(1, Ordering::Release);
        }
    }
    pub(super) fn terminate(&self) {
        let _ = self.pty.terminate();
    }
    /// The `sessions` list entry for this terminal.
    pub(super) fn json(&self) -> String {
        let state = self.state.lock().unwrap();
        format!(
            "{{\"id\":{},\"cwd\":{},\"shell\":{},\"created\":{},\"title\":{},\"name\":{},\"alive\":{},\"controller\":{},\"exitCode\":{}}}",
            json::quote(&self.id),
            json::quote(&self.cwd.to_string_lossy()),
            json::quote(&self.shell),
            self.created,
            json::quote(state.terminal.title()),
            optional_string(&state.name),
            state.alive,
            optional_string(&state.controller),
            optional_code(state.exit_code)
        )
    }
}
impl State {
    pub(super) fn transfer(&mut self, view: Option<&str>) {
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
