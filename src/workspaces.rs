//! Server-owned workspaces: named, ordered groups of at most four sessions.
use crate::json;
use std::collections::HashSet;

pub const PANE_LIMIT: usize = 4;
const WORKSPACE_LIMIT: usize = 16;
const NAME_LIMIT: usize = 80;

/// Validates a user-assigned name; an empty or blank name clears it.
pub fn custom_name(name: &str, kind: &str) -> Result<Option<String>, String> {
    let name_error =
        || format!("{kind} name must be at most {NAME_LIMIT} characters without controls");
    if name.chars().any(char::is_control) {
        return Err(name_error());
    }
    let name = name.trim();
    if name.chars().count() > NAME_LIMIT {
        return Err(name_error());
    }
    Ok((!name.is_empty()).then(|| name.to_owned()))
}

struct Workspace {
    id: String,
    name: Option<String>,
    sessions: Vec<String>,
}

/// Where a new session goes: an existing workspace index, or a new workspace.
#[derive(Debug)]
pub enum Placement {
    Existing(usize),
    New,
}

pub struct Workspaces {
    list: Vec<Workspace>,
    next: u64,
}

impl Default for Workspaces {
    fn default() -> Self {
        let mut workspaces = Self {
            list: Vec::new(),
            next: 1,
        };
        workspaces.push();
        workspaces
    }
}

impl Workspaces {
    fn push(&mut self) -> String {
        let id = format!("w{}", self.next);
        self.next += 1;
        self.list.push(Workspace {
            id: id.clone(),
            name: None,
            sessions: Vec::new(),
        });
        id
    }
    fn index(&self, id: &str) -> Result<usize, String> {
        self.list
            .iter()
            .position(|workspace| workspace.id == id)
            .ok_or_else(|| "Workspace no longer exists".into())
    }
    fn full_error() -> String {
        format!("A workspace holds at most {PANE_LIMIT} terminals")
    }
    fn check_limit(&self) -> Result<(), String> {
        if self.list.len() >= WORKSPACE_LIMIT {
            return Err(format!(
                "Workspace limit reached ({WORKSPACE_LIMIT}); close a workspace first"
            ));
        }
        Ok(())
    }
    pub fn create(&mut self) -> Result<String, String> {
        self.check_limit()?;
        Ok(self.push())
    }
    /// Checks capacity before a session is spawned. Without an explicit
    /// workspace, the first one with room is used, then a new one.
    pub fn placement(&self, requested: Option<&str>) -> Result<Placement, String> {
        if let Some(id) = requested {
            let index = self.index(id)?;
            if self.list[index].sessions.len() >= PANE_LIMIT {
                return Err(Self::full_error());
            }
            return Ok(Placement::Existing(index));
        }
        if let Some(index) = self
            .list
            .iter()
            .position(|workspace| workspace.sessions.len() < PANE_LIMIT)
        {
            return Ok(Placement::Existing(index));
        }
        self.check_limit()?;
        Ok(Placement::New)
    }
    /// Adds a spawned session at a placement returned under the same lock.
    pub fn insert(&mut self, placement: Placement, session: &str) -> String {
        let index = match placement {
            Placement::Existing(index) => index,
            Placement::New => {
                self.push();
                self.list.len() - 1
            }
        };
        self.list[index].sessions.push(session.to_owned());
        self.list[index].id.clone()
    }
    pub fn remove_session(&mut self, session: &str) {
        for workspace in &mut self.list {
            workspace.sessions.retain(|id| id != session);
        }
    }
    pub fn rename(&mut self, id: &str, name: &str) -> Result<(), String> {
        let name = custom_name(name, "Workspace")?;
        let index = self.index(id)?;
        self.list[index].name = name;
        Ok(())
    }
    pub fn sessions(&self, id: &str) -> Result<&[String], String> {
        Ok(&self.list[self.index(id)?].sessions)
    }
    /// Removes a workspace and returns its sessions, which the caller stops.
    /// An empty workspace replaces the last one so a workspace always exists.
    pub fn close(&mut self, id: &str) -> Result<Vec<String>, String> {
        let index = self.index(id)?;
        let workspace = self.list.remove(index);
        if self.list.is_empty() {
            self.push();
        }
        Ok(workspace.sessions)
    }
    pub fn reorder(&mut self, ids: &[String]) -> Result<(), String> {
        let unique: HashSet<&str> = ids.iter().map(String::as_str).collect();
        if ids.len() != self.list.len()
            || unique.len() != ids.len()
            || self
                .list
                .iter()
                .any(|workspace| !unique.contains(workspace.id.as_str()))
        {
            return Err("Order must contain every current workspace ID exactly once".into());
        }
        self.list.sort_by_key(|workspace| {
            ids.iter()
                .position(|id| id == &workspace.id)
                .unwrap_or_default()
        });
        Ok(())
    }
    /// Moves a session to a pane position, within or across workspaces.
    pub fn move_session(
        &mut self,
        session: &str,
        target: &str,
        position: usize,
    ) -> Result<(), String> {
        let source = self
            .list
            .iter()
            .position(|workspace| workspace.sessions.iter().any(|id| id == session))
            .ok_or("Terminal session no longer exists")?;
        let target = self.index(target)?;
        if source != target && self.list[target].sessions.len() >= PANE_LIMIT {
            return Err(Self::full_error());
        }
        self.list[source].sessions.retain(|id| id != session);
        let sessions = &mut self.list[target].sessions;
        sessions.insert(position.min(sessions.len()), session.to_owned());
        Ok(())
    }
    /// Session IDs in workspace and pane order.
    pub fn order(&self) -> impl Iterator<Item = &str> {
        self.list
            .iter()
            .flat_map(|workspace| workspace.sessions.iter().map(String::as_str))
    }
    pub fn json(&self) -> String {
        let entries = self
            .list
            .iter()
            .map(|workspace| {
                let sessions = workspace
                    .sessions
                    .iter()
                    .map(|id| json::quote(id))
                    .collect::<Vec<_>>()
                    .join(",");
                format!(
                    "{{\"id\":{},\"name\":{},\"sessions\":[{sessions}]}}",
                    json::quote(&workspace.id),
                    workspace
                        .name
                        .as_deref()
                        .map_or_else(|| "null".into(), json::quote)
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        format!("[{entries}]")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(workspaces: &Workspaces) -> Vec<(&str, Vec<&str>)> {
        workspaces
            .list
            .iter()
            .map(|w| {
                (
                    w.id.as_str(),
                    w.sessions.iter().map(String::as_str).collect(),
                )
            })
            .collect()
    }

    #[test]
    fn placement_fills_workspaces_and_respects_the_pane_limit() {
        let mut workspaces = Workspaces::default();
        for n in 1..=5 {
            let placement = workspaces.placement(None).unwrap();
            workspaces.insert(placement, &format!("s{n}"));
        }
        assert_eq!(
            ids(&workspaces),
            [("w1", vec!["s1", "s2", "s3", "s4"]), ("w2", vec!["s5"])]
        );
        assert!(
            workspaces
                .placement(Some("w1"))
                .unwrap_err()
                .contains("at most 4")
        );
        assert!(workspaces.placement(Some("w9")).is_err());
        assert!(matches!(
            workspaces.placement(Some("w2")),
            Ok(Placement::Existing(1))
        ));
    }

    #[test]
    fn closing_returns_sessions_and_keeps_one_workspace() {
        let mut workspaces = Workspaces::default();
        let placement = workspaces.placement(Some("w1")).unwrap();
        workspaces.insert(placement, "s1");
        assert_eq!(workspaces.close("w1").unwrap(), ["s1"]);
        assert_eq!(ids(&workspaces), [("w2", vec![])]);
        assert!(workspaces.close("w1").is_err());
    }

    #[test]
    fn moves_reorders_and_names_are_validated_atomically() {
        let mut workspaces = Workspaces::default();
        let second = workspaces.create().unwrap();
        for (session, target) in [("s1", "w1"), ("s2", "w1"), ("s3", "w2")] {
            let placement = workspaces.placement(Some(target)).unwrap();
            workspaces.insert(placement, session);
        }
        workspaces.move_session("s2", "w1", 0).unwrap();
        workspaces.move_session("s3", "w1", 9).unwrap();
        assert_eq!(
            ids(&workspaces),
            [("w1", vec!["s2", "s1", "s3"]), ("w2", vec![])]
        );
        assert!(workspaces.move_session("s9", "w1", 0).is_err());
        workspaces.reorder(&[second.clone(), "w1".into()]).unwrap();
        assert_eq!(workspaces.order().collect::<Vec<_>>(), ["s2", "s1", "s3"]);
        for bad in [vec!["w1".to_owned()], vec!["w1".into(), "w1".into()]] {
            assert!(workspaces.reorder(&bad).is_err());
        }
        assert_eq!(ids(&workspaces)[0].0, "w2");
        workspaces.rename("w1", "  Agents  ").unwrap();
        assert!(workspaces.rename("w1", "a\nb").is_err());
        assert!(workspaces.json().contains("\"name\":\"Agents\""));
        workspaces.rename("w1", " ").unwrap();
        assert!(!workspaces.json().contains("Agents"));
    }
}
