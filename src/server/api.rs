//! Read-only JSON routes for views: server identity, owned processes,
//! staged copies and settings.
use super::Context;
use crate::{
    json,
    native::{PROCESS_LIMIT, ProcessInfo},
    session::unix_ms,
    terminal::HISTORY_LIMIT,
};
use std::path::PathBuf;

pub(super) fn get(path: &str, context: &Context) -> Option<String> {
    let registry = &context.registry;
    Some(match path {
        "/api/sessions" => registry.list_json(),
        "/api/places" => places(context),
        "/api/info" => info(context),
        "/api/processes" => processes(context),
        "/api/files" => registry.uploads.copies_json(),
        "/api/settings" => context.settings.json(),
        _ => return None,
    })
}

fn info(context: &Context) -> String {
    let registry = &context.registry;
    format!(
        "{{\"cwd\":{},\"serverCwd\":{},\"shell\":{},\"version\":{},\"pid\":{},\"port\":{},\"started\":{},\"uptime\":{},\"history\":{HISTORY_LIMIT},\"settings\":{}}}",
        json::quote(&context.start_folder().to_string_lossy()),
        json::quote(&registry.cwd.to_string_lossy()),
        json::quote(&registry.shell),
        json::quote(env!("CARGO_PKG_VERSION")),
        std::process::id(),
        context.port,
        context.started,
        unix_ms().saturating_sub(context.started),
        json::quote(&context.settings.path().to_string_lossy()),
    )
}

/// Processes inside each terminal's own job. Each list is a bounded snapshot;
/// a process that exits or whose ID is reused outside the job is left out.
fn processes(context: &Context) -> String {
    let sessions = context
        .registry
        .all()
        .iter()
        .map(|session| {
            let (list, problem) = match session.processes(PROCESS_LIMIT) {
                Ok(list) => (list, None),
                Err(error) => (Default::default(), Some(error.to_string())),
            };
            let entries = list
                .processes
                .iter()
                .map(process_json)
                .collect::<Vec<_>>()
                .join(",");
            format!(
                "{{\"id\":{},\"total\":{},\"truncated\":{},\"problem\":{},\"processes\":[{entries}]}}",
                json::quote(&session.id),
                list.total,
                list.truncated,
                problem.map_or_else(|| "null".into(), |p| json::quote(&p)),
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "{{\"type\":\"processes\",\"at\":{},\"limit\":{PROCESS_LIMIT},\"sessions\":[{sessions}]}}",
        unix_ms()
    )
}

fn process_json(process: &ProcessInfo) -> String {
    let number = |value: Option<u64>| value.map_or_else(|| "null".into(), |v| v.to_string());
    format!(
        "{{\"pid\":{},\"parent\":{},\"name\":{},\"path\":{},\"started\":{},\"root\":{}}}",
        process.pid,
        number(process.parent.map(u64::from)),
        json::quote(&process.name),
        process
            .path
            .as_deref()
            .map_or_else(|| "null".into(), json::quote),
        number(process.started_ms),
        process.root
    )
}

/// Quick-access folders and drive roots for the folder picker. Only existing
/// folders are listed; drives come from the native boundary without probing.
fn places(context: &Context) -> String {
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from);
    let mut folders = vec![("Start folder", Some(context.start_folder()))];
    folders.push(("Home", home.clone()));
    for name in ["Desktop", "Documents", "Downloads"] {
        folders.push((name, home.as_ref().map(|home| home.join(name))));
    }
    let entry = |name: &str, path: &str| {
        format!(
            "{{\"name\":{},\"path\":{}}}",
            json::quote(name),
            json::quote(path)
        )
    };
    let folders = folders
        .into_iter()
        .filter_map(|(name, path)| path.filter(|path| path.is_dir()).map(|path| (name, path)))
        .map(|(name, path)| entry(name, &path.to_string_lossy()))
        .collect::<Vec<_>>()
        .join(",");
    let drives = crate::native::logical_drives()
        .iter()
        .map(|root| entry(root.trim_end_matches('\\'), root))
        .collect::<Vec<_>>()
        .join(",");
    format!("{{\"folders\":[{folders}],\"drives\":[{drives}]}}")
}
