//! Small, atomic snapshots for recoverable desktop operations.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnLifecycle {
    Running,
    Completed,
    Cancelled,
    Failed,
    Interrupted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnSnapshot {
    pub operation_id: String,
    pub generation: u64,
    pub phase: String,
    pub lifecycle: TurnLifecycle,
    pub updated_at_ms: u64,
    pub summary: String,
}

pub fn snapshot_path(root: &Path, operation_id: &str) -> Option<PathBuf> {
    let safe = operation_id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
        .take(96)
        .collect::<String>();
    (!safe.is_empty()).then(|| root.join(format!("{safe}.json")))
}

pub fn write_snapshot(path: &Path, snapshot: &TurnSnapshot) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "snapshot path has no parent"))?;
    fs::create_dir_all(parent)?;
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(snapshot)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    fs::write(&tmp, bytes)?;
    fs::rename(tmp, path)
}

pub fn read_snapshot(path: &Path) -> io::Result<TurnSnapshot> {
    let bytes = fs::read(path)?;
    serde_json::from_slice(&bytes)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

pub fn mark_interrupted(snapshot: &mut TurnSnapshot) {
    if snapshot.lifecycle == TurnLifecycle::Running {
        snapshot.lifecycle = TurnLifecycle::Interrupted;
    }
}

pub fn list_snapshots(root: &Path) -> io::Result<Vec<TurnSnapshot>> {
    let mut snapshots = Vec::new();
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(snapshots),
        Err(error) => return Err(error),
    };
    for entry in entries {
        let entry = entry?;
        if entry.path().extension().and_then(|v| v.to_str()) != Some("json") {
            continue;
        }
        if let Ok(snapshot) = read_snapshot(&entry.path()) {
            snapshots.push(snapshot);
        }
    }
    snapshots.sort_by(|left, right| right.updated_at_ms.cmp(&left.updated_at_ms));
    Ok(snapshots)
}

pub fn clear_snapshot(root: &Path, operation_id: &str) -> io::Result<bool> {
    let Some(path) = snapshot_path(root, operation_id) else {
        return Ok(false);
    };
    match fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

pub fn recover_running_snapshots(root: &Path) -> io::Result<usize> {
    let snapshots = list_snapshots(root)?;
    let mut changed = 0;
    for mut snapshot in snapshots {
        if snapshot.lifecycle != TurnLifecycle::Running {
            continue;
        }
        mark_interrupted(&mut snapshot);
        if let Some(path) = snapshot_path(root, &snapshot.operation_id) {
            write_snapshot(&path, &snapshot)?;
            changed += 1;
        }
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        std::env::temp_dir().join(format!(
            "kxyy-turn-state-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn running_snapshot_is_marked_interrupted_after_restart() {
        let mut snapshot = TurnSnapshot {
            operation_id: "chat-1".into(),
            generation: 3,
            phase: "generating".into(),
            lifecycle: TurnLifecycle::Running,
            updated_at_ms: 10,
            summary: "正在生成".into(),
        };
        mark_interrupted(&mut snapshot);
        assert_eq!(snapshot.lifecycle, TurnLifecycle::Interrupted);
    }

    #[test]
    fn snapshot_round_trip_is_atomic_and_rejects_path_traversal() {
        let root = temp_root();
        let path = snapshot_path(&root, "../chat-1").expect("sanitized path");
        assert_eq!(path.file_name().unwrap(), "chat-1.json");
        let snapshot = TurnSnapshot {
            operation_id: "chat-1".into(),
            generation: 1,
            phase: "queued".into(),
            lifecycle: TurnLifecycle::Running,
            updated_at_ms: 1,
            summary: "queued".into(),
        };
        write_snapshot(&path, &snapshot).expect("write");
        assert_eq!(read_snapshot(&path).expect("read"), snapshot);
        assert!(!path.with_extension("json.tmp").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn completed_snapshot_is_not_changed_by_restart_recovery() {
        let mut snapshot = TurnSnapshot {
            operation_id: "chat-2".into(),
            generation: 1,
            phase: "done".into(),
            lifecycle: TurnLifecycle::Completed,
            updated_at_ms: 2,
            summary: "完成".into(),
        };
        mark_interrupted(&mut snapshot);
        assert_eq!(snapshot.lifecycle, TurnLifecycle::Completed);
    }

    #[test]
    fn failed_snapshot_is_distinct_from_interrupted_snapshot() {
        let failed = TurnLifecycle::Failed;
        assert_ne!(failed, TurnLifecycle::Interrupted);
        let encoded = serde_json::to_string(&failed).unwrap();
        assert_eq!(encoded, "\"failed\"");
    }

    #[test]
    fn listing_ignores_corrupt_files_and_clear_is_idempotent() {
        let root = temp_root();
        let _ = fs::create_dir_all(&root);
        fs::write(root.join("broken.json"), b"not-json").expect("corrupt fixture");
        assert!(list_snapshots(&root).expect("list").is_empty());
        assert!(!clear_snapshot(&root, "missing").expect("clear missing"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn recovery_marks_only_running_snapshots() {
        let root = temp_root();
        let running_path = snapshot_path(&root, "running").unwrap();
        let done_path = snapshot_path(&root, "done").unwrap();
        let base = |id: &str, lifecycle| TurnSnapshot { operation_id: id.into(), generation: 1, phase: "x".into(), lifecycle, updated_at_ms: 1, summary: "x".into() };
        write_snapshot(&running_path, &base("running", TurnLifecycle::Running)).unwrap();
        write_snapshot(&done_path, &base("done", TurnLifecycle::Completed)).unwrap();
        assert_eq!(recover_running_snapshots(&root).unwrap(), 1);
        assert_eq!(read_snapshot(&running_path).unwrap().lifecycle, TurnLifecycle::Interrupted);
        assert_eq!(read_snapshot(&done_path).unwrap().lifecycle, TurnLifecycle::Completed);
        let _ = fs::remove_dir_all(root);
    }
}
