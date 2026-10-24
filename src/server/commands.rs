//! WebSocket operations and the central action policy.
//!
//! Controller-only: input, interrupt (input), resize, uploads and staged-copy
//! removal. The server checks control and epoch under the session's control
//! fence when the action runs.
//!
//! Shared with exact-target confirmation: create, rename, move, reorder,
//! close terminals or workspaces, settings and stopping the server. Busy
//! targets are confirmed by repeating the exact set the view was shown.
use super::{Attachment, Context};
use crate::{
    json::{self, Value},
    session::{self, WorkspaceClose},
};
use std::collections::BTreeMap;
use std::path::PathBuf;

pub(super) fn action(
    command: &Value,
    context: &Context,
    view: &str,
    attached: &mut BTreeMap<String, Attachment>,
) -> Result<Option<String>, String> {
    let registry = &context.registry;
    let op = command.field("op")?;
    match op {
        "list" => return Ok(Some(registry.list_json())),
        "create" => {
            let request = optional_request(command)?;
            let updates = wants_updates(command)?;
            let (cols, rows) = session::geometry(command)?;
            if command.get("profile").is_some() {
                return Err("Per-terminal shell selection is not supported".into());
            }
            let workspace = match command.get("workspace") {
                None => None,
                Some(value) => Some(value.string().ok_or("Workspace must be a workspace ID")?),
            };
            let (session, workspace) = registry.create(
                &PathBuf::from(command.field("cwd")?),
                cols,
                rows,
                view,
                workspace,
            )?;
            attached.insert(session.id.clone(), Attachment::new(updates, 0));
            return Ok(Some(format!(
                "{{\"type\":\"created\",\"id\":{},\"workspace\":{}{}}}",
                json::quote(&session.id),
                json::quote(&workspace),
                request_field(request),
            )));
        }
        "create-workspace" => {
            let request = optional_request(command)?;
            let id = registry.create_workspace()?;
            return Ok(Some(format!(
                "{{\"type\":\"workspace-created\",\"id\":{}{}}}",
                json::quote(&id),
                request_field(request),
            )));
        }
        "rename-workspace" => {
            registry.rename_workspace(command.field("id")?, command.field("name")?)?;
            return Ok(None);
        }
        "close-workspace" => {
            let id = command.field("id")?;
            let targets = string_array(
                command.get("targets"),
                "Workspace targets must list terminal IDs",
            )?;
            if targets.len() > 4 {
                return Err("Workspace targets have too many terminal IDs".into());
            }
            if let WorkspaceClose::Busy { sessions, targets } =
                registry.close_workspace(id, &targets, forced(command)?)?
            {
                return Ok(Some(busy_message(
                    "close-workspace",
                    id,
                    &sessions,
                    &targets,
                )));
            }
            attached.retain(|id, _| registry.get(id).is_ok());
            return Ok(None);
        }
        "close-sessions" => {
            let ids = string_array(command.get("ids"), "Selection must list terminal IDs")?;
            if let WorkspaceClose::Busy { sessions, targets } =
                registry.close_sessions(&ids, forced(command)?)?
            {
                return Ok(Some(busy_message(
                    "close-sessions",
                    "",
                    &sessions,
                    &targets,
                )));
            }
            attached.retain(|id, _| registry.get(id).is_ok());
            return Ok(Some(format!(
                "{{\"type\":\"closed\",\"ids\":{}}}",
                json_ids(&ids)
            )));
        }
        "order-workspaces" => {
            let ids = string_array(
                command.get("ids"),
                "Order must be an array of workspace IDs",
            )?;
            registry.order_workspaces(&ids)?;
            return Ok(None);
        }
        "move" => {
            let position = command.integer("position")?;
            if position < 0 {
                return Err("Position must not be negative".into());
            }
            registry.move_session(
                command.field("id")?,
                command.field("workspace")?,
                position as usize,
            )?;
            return Ok(None);
        }
        "save-settings" => {
            let revision = command.integer("revision")?;
            let settings = command.get("settings").ok_or("Settings are missing")?;
            return match context.settings.save(revision.max(0) as u64, settings) {
                Ok(saved) => {
                    registry.set_theme(context.settings.current().terminal_theme);
                    Ok(Some(saved))
                }
                // Views receive the current settings with the next update.
                Err(error) => Err(error.to_string()),
            };
        }
        "remove-copy" => {
            let id = command.field("id")?;
            let copy = registry
                .uploads
                .copy(id)
                .ok_or("Staged copy no longer exists")?;
            let removed = registry.get(&copy.session)?.with_control(
                view,
                command.integer("epoch")?,
                || registry.uploads.remove_copy(id),
            )?;
            return Ok(Some(format!(
                "{{\"type\":\"copy-removed\",\"id\":{}}}",
                json::quote(&removed.id)
            )));
        }
        "stop-server" => {
            if !matches!(command.get("confirmed"), Some(Value::Bool(true))) {
                return Err("Stopping the server needs confirmation".into());
            }
            // The socket loop sends this acknowledgement and its close frame
            // before signaling shutdown; otherwise main can exit first.
            return Ok(Some("{\"type\":\"server-stopping\"}".into()));
        }
        _ => {}
    }
    let id = command.field("id")?;
    let session = registry.get(id)?;
    match op {
        "rename" => registry.rename(id, command.field("name")?)?,
        "attach" => {
            let updates = wants_updates(command)?;
            let request = optional_request(command)?;
            session.attach(view, session::geometry(command)?)?;
            let event_seq = attached
                .get(id)
                .map_or_else(|| session.latest_event(), |old| old.event_seq);
            attached.insert(id.into(), Attachment::new(updates, event_seq));
            if let Some(request) = request {
                return Ok(Some(format!(
                    "{{\"type\":\"attached\",\"id\":{},\"request\":{request}}}",
                    json::quote(id)
                )));
            }
        }
        "detach" => {
            session.detach(view);
            attached.remove(id);
        }
        "claim" => session.claim(view, session::geometry(command)?)?,
        "release" => session.release(view)?,
        "close" => {
            if let WorkspaceClose::Busy { sessions, targets } =
                registry.close(id, forced(command)?)?
            {
                return Ok(Some(busy_message(op, id, &sessions, &targets)));
            }
            attached.remove(id);
        }
        "input" => session.send_input(
            view,
            command.integer("epoch")?,
            command.integer("seq")?,
            command.field("data")?,
        )?,
        "resize" => session.resize(view, command.integer("epoch")?, session::geometry(command)?)?,
        _ => return Err("Unknown terminal operation".into()),
    }
    Ok(None)
}

/// Closing a running program or a changed workspace needs the view to confirm
/// the server's targets and resend with `force`.
fn busy_message(op: &str, id: &str, busy: &[String], targets: &[String]) -> String {
    format!(
        "{{\"type\":\"busy\",\"op\":{},\"id\":{},\"sessions\":{},\"targets\":{}}}",
        json::quote(op),
        json::quote(id),
        json_ids(busy),
        json_ids(targets)
    )
}

fn json_ids(ids: &[String]) -> String {
    format!(
        "[{}]",
        ids.iter()
            .map(|id| json::quote(id))
            .collect::<Vec<_>>()
            .join(",")
    )
}

fn string_array(value: Option<&Value>, error: &str) -> Result<Vec<String>, String> {
    let Some(Value::Array(values)) = value else {
        return Err(error.into());
    };
    if values.len() > 64 {
        return Err(error.into());
    }
    values
        .iter()
        .map(|value| {
            value
                .string()
                .map(str::to_owned)
                .ok_or_else(|| error.into())
        })
        .collect()
}

fn forced(command: &Value) -> Result<bool, String> {
    match command.get("force") {
        None | Some(Value::Bool(false)) => Ok(false),
        Some(Value::Bool(true)) => Ok(true),
        _ => Err("The force flag must be a boolean".into()),
    }
}

const MAX_SAFE_REQUEST: i64 = 9_007_199_254_740_991;

fn valid_request(command: &Value) -> Option<i64> {
    command
        .get("request")
        .and_then(Value::number)
        .filter(|value| (1..=MAX_SAFE_REQUEST).contains(value))
}

fn optional_request(command: &Value) -> Result<Option<i64>, String> {
    if command.get("request").is_none() {
        return Ok(None);
    }
    valid_request(command)
        .map(Some)
        .ok_or_else(|| "The request must be positive and at most 9007199254740991".into())
}

fn request_field(request: Option<i64>) -> String {
    request.map_or_else(String::new, |value| format!(",\"request\":{value}"))
}

pub(super) fn error(error: &str, command: Option<&Value>) -> String {
    let mut reply = format!("{{\"type\":\"error\",\"message\":{}", json::quote(error));
    if let Some(command) = command {
        if let Some(op) = command.get("op").and_then(Value::string) {
            reply.push_str(&format!(",\"op\":{}", json::quote(op)));
        }
        if let Some(request) = valid_request(command) {
            reply.push_str(&format!(",\"request\":{request}"));
        }
        if let Some(id) = command.get("id").and_then(Value::string) {
            reply.push_str(&format!(",\"id\":{}", json::quote(id)));
        }
    }
    reply.push('}');
    reply
}

fn wants_updates(command: &Value) -> Result<bool, String> {
    match command.get("updates") {
        Some(Value::Bool(value)) => Ok(*value),
        None => Ok(false),
        _ => Err("Updates must be a boolean".into()),
    }
}
