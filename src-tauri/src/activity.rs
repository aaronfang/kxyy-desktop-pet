//! Bounded activity inbox for durable background-operation notifications.

use serde::{Deserialize, Serialize};

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
}
