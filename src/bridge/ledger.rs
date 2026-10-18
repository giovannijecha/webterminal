//! Bridge state bookkeeping: activity, request expiry and settled-request
//! trimming, plus the JSON view shared with browser views.
use super::values::now;
use super::{Activity, Inner, Kind, Request, SETTLED_LIMIT, State};
use crate::json;

pub(super) fn set_activity(inner: &mut Inner, session: &str, activity: Activity, detail: String) {
    if let Some(source) = inner.sources.get_mut(session) {
        if source.activity != activity {
            source.since = now();
        }
        source.activity = activity;
        source.detail = detail;
    }
}

pub(super) fn request_revision(inner: &mut Inner, id: &str) {
    let revision = inner.revision;
    if let Some(request) = inner.requests.iter_mut().find(|r| r.id == id) {
        request.revision = revision;
    }
}

pub(super) fn live(request: &Request) -> bool {
    matches!(request.state, State::Waiting | State::Pending)
}

/// Expires every open request that matches and gives each a new revision,
/// so a view that still shows it cannot answer it.
pub(super) fn expire(inner: &mut Inner, matches: impl Fn(&Request) -> bool, reason: &str) -> bool {
    let mut ids = Vec::new();
    for request in inner.requests.iter_mut().filter(|r| live(r) && matches(r)) {
        request.state = State::Expired;
        request.body = None;
        request.outcome = reason.into();
        ids.push(request.id.clone());
    }
    if ids.is_empty() {
        return false;
    }
    inner.revision += 1;
    for id in ids {
        request_revision(inner, &id);
    }
    true
}

pub(super) fn trim(inner: &mut Inner) {
    while inner.requests.iter().filter(|r| !live(r)).count() > SETTLED_LIMIT {
        let Some(index) = inner.requests.iter().position(|r| !live(r)) else {
            break;
        };
        inner.requests.remove(index);
    }
}

pub(super) fn render(inner: &Inner) -> String {
    let sources: Vec<String> = inner
        .sources
        .iter()
        .map(|(session, s)| {
            format!(
                "{{\"session\":{},\"program\":{},\"label\":{},\"activity\":{},\"since\":{},\"detail\":{}}}",
                json::quote(session),
                json::quote(s.program.id()),
                json::quote(s.program.label()),
                json::quote(s.activity.name()),
                s.since,
                json::quote(&s.detail),
            )
        })
        .collect();
    let requests: Vec<String> = inner.requests.iter().map(request_json).collect();
    format!(
        "{{\"type\":\"agents\",\"revision\":{},\"sources\":[{}],\"requests\":[{}]}}",
        inner.revision,
        sources.join(","),
        requests.join(",")
    )
}

fn request_json(r: &Request) -> String {
    let state = match r.state {
        State::Waiting => "waiting",
        State::Pending => "pending",
        State::Resolved => "resolved",
        State::Expired => "expired",
    };
    let kind = match r.draft.kind {
        Kind::Command => "command",
        Kind::Edit => "edit",
        Kind::Tool => "tool",
        Kind::Question => "question",
    };
    format!(
        "{{\"id\":{},\"session\":{},\"program\":{},\"label\":{},\"kind\":\"{kind}\",\"tool\":{},\"evidence\":{},\"scope\":{},\"revision\":{},\"state\":\"{state}\",\"outcome\":{},\"created\":{}}}",
        json::quote(&r.id),
        json::quote(&r.session),
        json::quote(r.program.id()),
        json::quote(r.program.label()),
        json::quote(&r.draft.tool),
        r.draft.evidence.to_json(),
        r.draft
            .scope
            .as_deref()
            .map(json::quote)
            .unwrap_or_else(|| "null".into()),
        r.revision,
        json::quote(&r.outcome),
        r.created,
    )
}
