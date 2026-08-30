//! Bounded activity inbox for durable background-operation notifications.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const MAX_ACTIVITY_ITEMS: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityStatus {
    Unread,
    Read,
    Acted,
    Dismissed,
    Expired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityItem {
    pub id: String,
    pub category: String,
    pub operation_id: String,
    pub status: ActivityStatus,
    pub retryable: bool,
    pub summary: String,
    pub deep_link: Option<String>,
    pub created_at_ms: u64,
}

pub struct ActivityState {
    path: PathBuf,
    items: Mutex<Vec<ActivityItem>>,
}

impl ActivityState {
    pub fn open(path: PathBuf) -> Self {
        let items = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        Self { path, items: Mutex::new(items) }
    }

    pub fn list(&self) -> Vec<ActivityItem> {
        self.items.lock().unwrap().clone()
    }

    pub fn upsert(&self, item: ActivityItem) -> std::io::Result<()> {
        let mut items = self.items.lock().unwrap();
        upsert(&mut items, item);
        persist(&self.path, &items)
    }

    pub fn set_status(&self, id: &str, status: ActivityStatus) -> std::io::Result<bool> {
        let mut items = self.items.lock().unwrap();
        let Some(item) = items.iter_mut().find(|item| item.id == id) else { return Ok(false) };
        item.status = status;
        persist(&self.path, &items)?;
        Ok(true)
    }
}

fn persist(path: &Path, items: &[ActivityItem]) -> std::io::Result<()> {
    let parent = path.parent().ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "activity path has no parent"))?;
    fs::create_dir_all(parent)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec(items).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?)?;
    fs::rename(tmp, path)
}

pub fn upsert(items: &mut Vec<ActivityItem>, item: ActivityItem) {
    items.retain(|existing| existing.id != item.id);
    items.insert(0, item);
    items.truncate(MAX_ACTIVITY_ITEMS);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str) -> ActivityItem {
        ActivityItem {
            id: id.into(), category: "system".into(), operation_id: id.into(),
            status: ActivityStatus::Unread, retryable: false, summary: "ok".into(),
            deep_link: None, created_at_ms: 1,
        }
    }

    #[test]
    fn repeated_event_id_upserts_without_duplicate() {
        let mut items = vec![item("a")];
        let mut replacement = item("a");
        replacement.status = ActivityStatus::Read;
        upsert(&mut items, replacement);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].status, ActivityStatus::Read);
    }

    #[test]
    fn inbox_keeps_newest_five_hundred_items() {
        let mut items = Vec::new();
        for index in 0..(MAX_ACTIVITY_ITEMS + 1) {
            upsert(&mut items, item(&index.to_string()));
        }
        assert_eq!(items.len(), MAX_ACTIVITY_ITEMS);
        assert_eq!(items.first().unwrap().id, MAX_ACTIVITY_ITEMS.to_string());
        assert!(!items.iter().any(|entry| entry.id == "0"));
    }

    #[test]
    fn persisted_inbox_survives_reopen_and_status_update() {
        let root = std::env::temp_dir().join(format!("kxyy-activity-{}", std::process::id()));
        let path = root.join("activity.json");
        let state = ActivityState::open(path.clone());
        state.upsert(item("persisted")).unwrap();
        state.set_status("persisted", ActivityStatus::Read).unwrap();
        let reopened = ActivityState::open(path.clone());
        assert_eq!(reopened.list()[0].status, ActivityStatus::Read);
        let _ = std::fs::remove_dir_all(root);
    }
}
