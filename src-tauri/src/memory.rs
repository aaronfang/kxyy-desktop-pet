//! Memory v3：本地 SQLite 长期记忆、选择性召回和异步会话巩固。

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use chrono::NaiveDateTime;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

const SCHEMA_VERSION: i64 = 5;
const SOURCE_RETENTION_SECS: i64 = 90 * 24 * 60 * 60;
const JOB_RETENTION_SECS: i64 = 7 * 24 * 60 * 60;
// Chinese characters are close to one token in the target models; keep this
// conservative so the prompt budget remains roughly 500 tokens without a
// tokenizer dependency in the desktop bundle.
const RECALL_CHAR_BUDGET: usize = 500;
const MAX_RECALL_ITEMS: usize = 6;
const PROACTIVE_RECALL_CHAR_BUDGET: usize = 300;
const PROACTIVE_RECALL_MAX_ITEMS: usize = 3;
const MAX_LISTED_BACKUPS: usize = 100;

pub struct MemoryState {
    db_path: Option<PathBuf>,
    conn: Mutex<Option<Connection>>,
    worker_running: AtomicBool,
    database_generation: AtomicU64,
    wake_generation: Mutex<u64>,
    worker_wakeup: Condvar,
    last_error: Mutex<Option<String>>,
}

impl MemoryState {
    pub fn open(app: &AppHandle) -> Self {
        let path = app
            .path()
            .app_config_dir()
            .ok()
            .map(|dir| dir.join("memory-v3.sqlite3"));
        let mut error = None;
        let conn = path.as_ref().and_then(|path| {
            if let Some(parent) = path.parent() {
                if let Err(e) = fs::create_dir_all(parent) {
                    error = Some(format!("创建记忆目录失败：{e}"));
                    return None;
                }
            }
            match Connection::open(path).and_then(|mut c| {
                configure(&c)?;
                migrate(&mut c)?;
                maintenance(&c)?;
                Ok(c)
            }) {
                Ok(c) => Some(c),
                Err(e) => {
                    error = Some(format!("打开记忆数据库失败：{e}"));
                    None
                }
            }
        });
        Self {
            db_path: path,
            conn: Mutex::new(conn),
            worker_running: AtomicBool::new(false),
            database_generation: AtomicU64::new(0),
            wake_generation: Mutex::new(0),
            worker_wakeup: Condvar::new(),
            last_error: Mutex::new(error),
        }
    }

    fn set_error(&self, error: impl Into<String>) {
        *self.last_error.lock().unwrap() = Some(error.into());
    }

    fn clear_error(&self) {
        *self.last_error.lock().unwrap() = None;
    }
}

fn configure(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA foreign_keys=ON;
         PRAGMA busy_timeout=5000;
         PRAGMA secure_delete=ON;
         PRAGMA synchronous=NORMAL;",
    )
}

fn migrate(conn: &mut Connection) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS memory_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
         );",
    )?;
    let existing_version = tx
        .query_row(
            "SELECT value FROM memory_meta WHERE key='schema_version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);
    if existing_version > SCHEMA_VERSION {
        return Err(rusqlite::Error::InvalidParameterName(format!(
            "记忆数据库版本 {existing_version} 高于当前支持版本 {SCHEMA_VERSION}"
        )));
    }
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS memory_users (
            id TEXT PRIMARY KEY,
            card_id TEXT NOT NULL,
            normalized_name TEXT NOT NULL,
            display_name TEXT NOT NULL,
            total_sessions INTEGER NOT NULL DEFAULT 0,
            last_seen_at INTEGER,
            created_at INTEGER NOT NULL,
            UNIQUE(card_id, normalized_name)
         );
         CREATE TABLE IF NOT EXISTS memory_episodes (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES memory_users(id) ON DELETE CASCADE,
            session_id TEXT,
            summary TEXT NOT NULL,
            emotion TEXT NOT NULL DEFAULT '',
            importance REAL NOT NULL DEFAULT 0.5,
            topics_json TEXT NOT NULL DEFAULT '[]',
            entities_json TEXT NOT NULL DEFAULT '[]',
            source_excerpt TEXT,
            source_expires_at INTEGER,
            occurred_at INTEGER NOT NULL,
            pinned INTEGER NOT NULL DEFAULT 0,
            user_edited INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_memory_episodes_user_time
            ON memory_episodes(user_id, occurred_at DESC);
         CREATE TABLE IF NOT EXISTS memory_facts (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES memory_users(id) ON DELETE CASCADE,
            source_episode_id TEXT REFERENCES memory_episodes(id) ON DELETE SET NULL,
            text TEXT NOT NULL,
            predicate TEXT NOT NULL DEFAULT '',
            value TEXT NOT NULL DEFAULT '',
            confidence REAL NOT NULL DEFAULT 0.7,
            importance REAL NOT NULL DEFAULT 0.5,
            durability TEXT NOT NULL DEFAULT 'stable',
            status TEXT NOT NULL DEFAULT 'active',
            valid_from INTEGER,
            valid_to INTEGER,
            confirmation_count INTEGER NOT NULL DEFAULT 1,
            pinned INTEGER NOT NULL DEFAULT 0,
            user_edited INTEGER NOT NULL DEFAULT 0,
            first_seen_at INTEGER NOT NULL,
            last_confirmed_at INTEGER NOT NULL,
            last_recalled_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_memory_facts_user_status
            ON memory_facts(user_id, status, updated_at DESC);
         CREATE TABLE IF NOT EXISTS memory_commitments (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES memory_users(id) ON DELETE CASCADE,
            source_episode_id TEXT REFERENCES memory_episodes(id) ON DELETE SET NULL,
            text TEXT NOT NULL,
            due_at INTEGER,
            status TEXT NOT NULL DEFAULT 'pending',
            importance REAL NOT NULL DEFAULT 0.7,
            pinned INTEGER NOT NULL DEFAULT 0,
            user_edited INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            resolved_at INTEGER
         );
         CREATE INDEX IF NOT EXISTS idx_memory_commitments_user_status
            ON memory_commitments(user_id, status, updated_at DESC);
         CREATE TABLE IF NOT EXISTS memory_revisions (
            id TEXT PRIMARY KEY,
            item_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            user_id TEXT NOT NULL REFERENCES memory_users(id) ON DELETE CASCADE,
            revision_number INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'superseded',
            snapshot_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(kind, item_id, revision_number)
         );
         CREATE INDEX IF NOT EXISTS idx_memory_revisions_item
            ON memory_revisions(kind, item_id, revision_number DESC);
         CREATE TABLE IF NOT EXISTS memory_scopes (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            scope_key TEXT NOT NULL,
            user_id TEXT NOT NULL REFERENCES memory_users(id) ON DELETE CASCADE,
            card_id TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(kind, scope_key)
         );
         CREATE INDEX IF NOT EXISTS idx_memory_scopes_user
            ON memory_scopes(user_id, kind);
         CREATE TABLE IF NOT EXISTS memory_events (
            id TEXT PRIMARY KEY,
            scope_id TEXT NOT NULL REFERENCES memory_scopes(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL REFERENCES memory_users(id) ON DELETE CASCADE,
            item_kind TEXT NOT NULL,
            item_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            source_type TEXT NOT NULL,
            source_id TEXT,
            modality TEXT NOT NULL DEFAULT 'text',
            observed_at INTEGER NOT NULL,
            sensitivity TEXT NOT NULL DEFAULT 'normal',
            trust REAL NOT NULL DEFAULT 0.7,
            consent TEXT NOT NULL DEFAULT 'allowed',
            idempotency_key TEXT NOT NULL UNIQUE,
            payload_json TEXT NOT NULL DEFAULT '{}',
            created_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_memory_events_item
            ON memory_events(item_kind, item_id, created_at DESC);
         CREATE INDEX IF NOT EXISTS idx_memory_events_scope
            ON memory_events(scope_id, created_at DESC);
         CREATE TABLE IF NOT EXISTS memory_evidence (
            id TEXT PRIMARY KEY,
            event_id TEXT NOT NULL REFERENCES memory_events(id) ON DELETE CASCADE,
            item_kind TEXT NOT NULL,
            item_id TEXT NOT NULL,
            relation TEXT NOT NULL,
            source_message_ids_json TEXT NOT NULL DEFAULT '[]',
            excerpt TEXT,
            excerpt_expires_at INTEGER,
            created_at INTEGER NOT NULL,
            UNIQUE(event_id, relation, item_kind, item_id)
         );
         CREATE INDEX IF NOT EXISTS idx_memory_evidence_item
            ON memory_evidence(item_kind, item_id, created_at DESC);
         CREATE TRIGGER IF NOT EXISTS memory_events_no_update
            BEFORE UPDATE ON memory_events
            BEGIN SELECT RAISE(ABORT, 'memory_events are append-only'); END;
         CREATE TABLE IF NOT EXISTS memory_entities (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES memory_users(id) ON DELETE CASCADE,
            entity_type TEXT NOT NULL DEFAULT 'entity',
            canonical_name TEXT NOT NULL,
            normalized_name TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(user_id, entity_type, normalized_name)
         );
         CREATE INDEX IF NOT EXISTS idx_memory_entities_user
            ON memory_entities(user_id, normalized_name);
         CREATE TABLE IF NOT EXISTS memory_topics (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES memory_users(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            normalized_name TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(user_id, normalized_name)
         );
         CREATE INDEX IF NOT EXISTS idx_memory_topics_user
            ON memory_topics(user_id, normalized_name);
         CREATE TABLE IF NOT EXISTS memory_edges (
            id TEXT PRIMARY KEY,
            scope_id TEXT NOT NULL REFERENCES memory_scopes(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL REFERENCES memory_users(id) ON DELETE CASCADE,
            from_kind TEXT NOT NULL,
            from_id TEXT NOT NULL,
            to_kind TEXT NOT NULL,
            to_id TEXT NOT NULL,
            relation TEXT NOT NULL,
            source_event_id TEXT REFERENCES memory_events(id) ON DELETE SET NULL,
            confidence REAL NOT NULL DEFAULT 0.7,
            derived INTEGER NOT NULL DEFAULT 1,
            idempotency_key TEXT NOT NULL UNIQUE,
            created_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_memory_edges_from
            ON memory_edges(from_kind, from_id, created_at DESC);
         CREATE INDEX IF NOT EXISTS idx_memory_edges_to
            ON memory_edges(to_kind, to_id, created_at DESC);
         CREATE INDEX IF NOT EXISTS idx_memory_edges_scope
            ON memory_edges(scope_id, created_at DESC);
         CREATE TABLE IF NOT EXISTS memory_jobs (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES memory_users(id) ON DELETE CASCADE,
            card_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            batch_start INTEGER NOT NULL,
            batch_end INTEGER NOT NULL,
            payload_json TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt_at INTEGER NOT NULL,
            last_error TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(user_id, session_id, batch_start, batch_end)
         );
         CREATE INDEX IF NOT EXISTS idx_memory_jobs_due
            ON memory_jobs(status, next_attempt_at);
         CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(
            item_id UNINDEXED,
            kind UNINDEXED,
            card_id UNINDEXED,
            user_id UNINDEXED,
            text,
            tags,
            tokenize='trigram'
         );",
    )?;
    if existing_version == 1 {
        tx.execute_batch(
            "ALTER TABLE memory_jobs RENAME TO memory_jobs_v1;
             CREATE TABLE memory_jobs (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES memory_users(id) ON DELETE CASCADE,
                card_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                batch_start INTEGER NOT NULL,
                batch_end INTEGER NOT NULL,
                payload_json TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                attempts INTEGER NOT NULL DEFAULT 0,
                next_attempt_at INTEGER NOT NULL,
                last_error TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                UNIQUE(user_id, session_id, batch_start, batch_end)
             );
             INSERT OR IGNORE INTO memory_jobs
                SELECT * FROM memory_jobs_v1;
             DROP TABLE memory_jobs_v1;
             CREATE INDEX idx_memory_jobs_due ON memory_jobs(status, next_attempt_at);",
        )?;
    }
    if existing_version < 4 {
        backfill_v4_events(&tx)?;
    }
    if existing_version < 5 {
        backfill_v5_graph(&tx)?;
    }
    tx.execute(
        "INSERT INTO memory_meta(key, value) VALUES('schema_version', ?1)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [SCHEMA_VERSION.to_string()],
    )?;
    tx.commit()
}

fn maintenance(conn: &Connection) -> rusqlite::Result<()> {
    let now = now_ts();
    conn.execute(
        "UPDATE memory_jobs SET status='retrying',next_attempt_at=?1,
         last_error=COALESCE(last_error,'应用在巩固过程中退出，已自动重试'),updated_at=?1
         WHERE status='processing'",
        [now],
    )?;
    conn.execute(
        "UPDATE memory_episodes SET source_excerpt=NULL
         WHERE source_expires_at IS NOT NULL AND source_expires_at < ?1",
        [now],
    )?;
    conn.execute(
        "UPDATE memory_evidence SET excerpt=NULL
         WHERE excerpt_expires_at IS NOT NULL AND excerpt_expires_at < ?1",
        [now],
    )?;
    conn.execute(
        "UPDATE memory_jobs SET status='skipped', payload_json=NULL,
          last_error='待处理会话超过 7 天，已按隐私策略删除原文', updated_at=?1
         WHERE status IN ('pending','retrying') AND created_at < ?2",
        params![now, now - JOB_RETENTION_SECS],
    )?;
    conn.execute(
        "UPDATE memory_commitments SET status='expired',resolved_at=?1,updated_at=?1
         WHERE status='pending' AND due_at IS NOT NULL AND due_at < ?1",
        [now],
    )?;
    Ok(())
}

fn now_ts() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn normalize_name(name: &str) -> String {
    name.trim().to_lowercase().chars().take(80).collect()
}

fn clamp01(v: f64) -> f64 {
    if v.is_finite() {
        v.clamp(0.0, 1.0)
    } else {
        0.5
    }
}

fn truncate_chars(text: &str, max: usize) -> String {
    text.trim().chars().take(max).collect()
}

fn get_or_create_user(
    conn: &Connection,
    card_id: &str,
    nickname: &str,
) -> rusqlite::Result<String> {
    let normalized = normalize_name(nickname);
    if let Some(id) = conn
        .query_row(
            "SELECT id FROM memory_users WHERE card_id=?1 AND normalized_name=?2",
            params![card_id, normalized],
            |row| row.get(0),
        )
        .optional()?
    {
        conn.execute(
            "UPDATE memory_users SET display_name=?1 WHERE id=?2",
            params![truncate_chars(nickname, 80), id],
        )?;
        return Ok(id);
    }
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO memory_users(id,card_id,normalized_name,display_name,created_at)
         VALUES(?1,?2,?3,?4,?5)",
        params![
            id,
            card_id,
            normalized,
            truncate_chars(nickname, 80),
            now_ts()
        ],
    )?;
    Ok(id)
}

#[derive(Debug, Clone)]
struct MemoryEventInput<'a> {
    user_id: &'a str,
    card_id: &'a str,
    item_kind: &'a str,
    item_id: &'a str,
    event_type: &'a str,
    source_type: &'a str,
    source_id: Option<&'a str>,
    modality: &'a str,
    observed_at: i64,
    trust: f64,
    consent: &'a str,
    idempotency_key: &'a str,
    payload_json: &'a str,
}

fn ensure_persona_scope(
    conn: &Connection,
    user_id: &str,
    card_id: &str,
    now: i64,
) -> rusqlite::Result<String> {
    let scope_key = format!("persona-relationship:{user_id}");
    let scope_id = format!("scope-{user_id}");
    conn.execute(
        "INSERT OR IGNORE INTO memory_scopes(id,kind,scope_key,user_id,card_id,created_at)
         VALUES(?1,'persona-relationship',?2,?3,?4,?5)",
        params![scope_id, scope_key, user_id, card_id, now],
    )?;
    conn.query_row(
        "SELECT id FROM memory_scopes WHERE kind='persona-relationship' AND scope_key=?1",
        [scope_key],
        |row| row.get(0),
    )
}

fn append_event(conn: &Connection, input: &MemoryEventInput<'_>) -> rusqlite::Result<String> {
    let now = now_ts();
    let scope_id = ensure_persona_scope(conn, input.user_id, input.card_id, now)?;
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT OR IGNORE INTO memory_events(
            id,scope_id,user_id,item_kind,item_id,event_type,source_type,source_id,
            modality,observed_at,sensitivity,trust,consent,idempotency_key,payload_json,created_at
         ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'normal',?11,?12,?13,?14,?15)",
        params![
            id,
            scope_id,
            input.user_id,
            input.item_kind,
            input.item_id,
            input.event_type,
            input.source_type,
            input.source_id,
            input.modality,
            input.observed_at,
            clamp01(input.trust),
            input.consent,
            input.idempotency_key,
            input.payload_json,
            now,
        ],
    )?;
    conn.query_row(
        "SELECT id FROM memory_events WHERE idempotency_key=?1",
        [input.idempotency_key],
        |row| row.get(0),
    )
}

fn append_evidence(
    conn: &Connection,
    event_id: &str,
    item_kind: &str,
    item_id: &str,
    relation: &str,
    source_message_ids: &[String],
    excerpt: Option<&str>,
    now: i64,
) -> rusqlite::Result<()> {
    let source_ids = serde_json::to_string(source_message_ids).unwrap_or_else(|_| "[]".into());
    conn.execute(
        "INSERT OR IGNORE INTO memory_evidence(
            id,event_id,item_kind,item_id,relation,source_message_ids_json,excerpt,
            excerpt_expires_at,created_at
         ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![
            Uuid::new_v4().to_string(),
            event_id,
            item_kind,
            item_id,
            relation,
            source_ids,
            excerpt.map(|value| truncate_chars(value, 800)),
            excerpt.map(|_| now + SOURCE_RETENTION_SECS),
            now,
        ],
    )?;
    Ok(())
}

#[derive(Debug, Clone)]
struct MemoryEdgeInput<'a> {
    user_id: &'a str,
    card_id: &'a str,
    from_kind: &'a str,
    from_id: &'a str,
    to_kind: &'a str,
    to_id: &'a str,
    relation: &'a str,
    source_event_id: Option<&'a str>,
    confidence: f64,
    derived: bool,
    idempotency_key: &'a str,
}

fn normalize_node_name(name: &str) -> String {
    name.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
        .chars()
        .take(80)
        .collect()
}

fn ensure_topic(
    conn: &Connection,
    user_id: &str,
    name: &str,
    now: i64,
) -> rusqlite::Result<Option<String>> {
    let display = truncate_chars(name, 80);
    let normalized = normalize_node_name(&display);
    if display.is_empty() || normalized.is_empty() || is_sensitive(&display) {
        return Ok(None);
    }
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT OR IGNORE INTO memory_topics(id,user_id,name,normalized_name,created_at,updated_at)
         VALUES(?1,?2,?3,?4,?5,?5)",
        params![id, user_id, display, normalized, now],
    )?;
    conn.query_row(
        "SELECT id FROM memory_topics WHERE user_id=?1 AND normalized_name=?2",
        params![user_id, normalized],
        |row| row.get(0),
    )
    .optional()
}

fn ensure_entity(
    conn: &Connection,
    user_id: &str,
    name: &str,
    now: i64,
) -> rusqlite::Result<Option<String>> {
    let display = truncate_chars(name, 80);
    let normalized = normalize_node_name(&display);
    if display.is_empty() || normalized.is_empty() || is_sensitive(&display) {
        return Ok(None);
    }
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT OR IGNORE INTO memory_entities(id,user_id,entity_type,canonical_name,normalized_name,created_at,updated_at)
         VALUES(?1,?2,'entity',?3,?4,?5,?5)",
        params![id, user_id, display, normalized, now],
    )?;
    conn.query_row(
        "SELECT id FROM memory_entities WHERE user_id=?1 AND entity_type='entity' AND normalized_name=?2",
        params![user_id, normalized],
        |row| row.get(0),
    )
    .optional()
}

fn append_edge(conn: &Connection, input: &MemoryEdgeInput<'_>) -> rusqlite::Result<String> {
    let now = now_ts();
    let scope_id = ensure_persona_scope(conn, input.user_id, input.card_id, now)?;
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT OR IGNORE INTO memory_edges(
            id,scope_id,user_id,from_kind,from_id,to_kind,to_id,relation,source_event_id,
            confidence,derived,idempotency_key,created_at
         ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        params![
            id,
            scope_id,
            input.user_id,
            input.from_kind,
            input.from_id,
            input.to_kind,
            input.to_id,
            input.relation,
            input.source_event_id,
            clamp01(input.confidence),
            input.derived as i64,
            input.idempotency_key,
            now,
        ],
    )?;
    conn.query_row(
        "SELECT id FROM memory_edges WHERE idempotency_key=?1",
        [input.idempotency_key],
        |row| row.get(0),
    )
}

fn link_episode_nodes(
    conn: &Connection,
    user_id: &str,
    card_id: &str,
    episode_id: &str,
    topics: &[String],
    entities: &[String],
    source_event_id: Option<&str>,
    confidence: f64,
) -> rusqlite::Result<()> {
    for topic in topics {
        let Some(topic_id) = ensure_topic(conn, user_id, topic, now_ts())? else {
            continue;
        };
        let normalized = normalize_node_name(topic);
        append_edge(
            conn,
            &MemoryEdgeInput {
                user_id,
                card_id,
                from_kind: "episode",
                from_id: episode_id,
                to_kind: "topic",
                to_id: &topic_id,
                relation: "about",
                source_event_id,
                confidence,
                derived: true,
                idempotency_key: &format!("episode:{episode_id}:topic:{normalized}"),
            },
        )?;
    }
    for entity in entities {
        let Some(entity_id) = ensure_entity(conn, user_id, entity, now_ts())? else {
            continue;
        };
        let normalized = normalize_node_name(entity);
        append_edge(
            conn,
            &MemoryEdgeInput {
                user_id,
                card_id,
                from_kind: "episode",
                from_id: episode_id,
                to_kind: "entity",
                to_id: &entity_id,
                relation: "mentions",
                source_event_id,
                confidence,
                derived: true,
                idempotency_key: &format!("episode:{episode_id}:entity:{normalized}"),
            },
        )?;
    }
    Ok(())
}

fn link_source_episode(
    conn: &Connection,
    user_id: &str,
    card_id: &str,
    item_kind: &str,
    item_id: &str,
    episode_id: Option<&str>,
    source_event_id: Option<&str>,
    confidence: f64,
) -> rusqlite::Result<()> {
    let Some(episode_id) = episode_id else {
        return Ok(());
    };
    append_edge(
        conn,
        &MemoryEdgeInput {
            user_id,
            card_id,
            from_kind: item_kind,
            from_id: item_id,
            to_kind: "episode",
            to_id: episode_id,
            relation: "derived_from",
            source_event_id,
            confidence,
            derived: true,
            idempotency_key: &format!("{item_kind}:{item_id}:episode:{episode_id}"),
        },
    )?;
    Ok(())
}

fn backfill_v5_graph(conn: &Transaction<'_>) -> rusqlite::Result<()> {
    let users: Vec<(String, String)> = conn
        .prepare("SELECT id,card_id FROM memory_users ORDER BY created_at")?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .filter_map(Result::ok)
        .collect();
    for (user_id, card_id) in users {
        let episodes: Vec<(String, String, String)> = conn
            .prepare("SELECT id,topics_json,entities_json FROM memory_episodes WHERE user_id=?1")?
            .query_map([&user_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?
            .filter_map(Result::ok)
            .collect();
        for (episode_id, topics_json, entities_json) in episodes {
            let topics: Vec<String> = serde_json::from_str(&topics_json).unwrap_or_default();
            let entities: Vec<String> = serde_json::from_str(&entities_json).unwrap_or_default();
            let event_id: Option<String> = conn
                .query_row(
                    "SELECT id FROM memory_events WHERE user_id=?1 AND item_kind='episode' AND item_id=?2 ORDER BY created_at DESC LIMIT 1",
                    params![user_id, episode_id],
                    |row| row.get(0),
                )
                .optional()?;
            link_episode_nodes(
                &conn,
                &user_id,
                &card_id,
                &episode_id,
                &topics,
                &entities,
                event_id.as_deref(),
                0.7,
            )?;
        }
        let facts: Vec<(String, Option<String>)> = conn
            .prepare("SELECT id,source_episode_id FROM memory_facts WHERE user_id=?1")?
            .query_map([&user_id], |row| Ok((row.get(0)?, row.get(1)?)))?
            .filter_map(Result::ok)
            .collect();
        for (fact_id, episode_id) in facts {
            let event_id: Option<String> = conn
                .query_row(
                    "SELECT id FROM memory_events WHERE user_id=?1 AND item_kind='fact' AND item_id=?2 ORDER BY created_at DESC LIMIT 1",
                    params![user_id, fact_id],
                    |row| row.get(0),
                )
                .optional()?;
            link_source_episode(
                &conn,
                &user_id,
                &card_id,
                "fact",
                &fact_id,
                episode_id.as_deref(),
                event_id.as_deref(),
                0.7,
            )?;
        }
        let commitments: Vec<(String, Option<String>)> = conn
            .prepare("SELECT id,source_episode_id FROM memory_commitments WHERE user_id=?1")?
            .query_map([&user_id], |row| Ok((row.get(0)?, row.get(1)?)))?
            .filter_map(Result::ok)
            .collect();
        for (commitment_id, episode_id) in commitments {
            let event_id: Option<String> = conn
                .query_row(
                    "SELECT id FROM memory_events WHERE user_id=?1 AND item_kind='commitment' AND item_id=?2 ORDER BY created_at DESC LIMIT 1",
                    params![user_id, commitment_id],
                    |row| row.get(0),
                )
                .optional()?;
            link_source_episode(
                &conn,
                &user_id,
                &card_id,
                "commitment",
                &commitment_id,
                episode_id.as_deref(),
                event_id.as_deref(),
                0.7,
            )?;
        }
    }
    Ok(())
}

fn backfill_v4_events(conn: &Transaction<'_>) -> rusqlite::Result<()> {
    let users: Vec<(String, String)> = conn
        .prepare("SELECT id,card_id FROM memory_users ORDER BY created_at")?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .filter_map(Result::ok)
        .collect();
    for (user_id, card_id) in users {
        for kind in ["episode", "fact", "commitment"] {
            let table = kind_table(kind)
                .map_err(|_| rusqlite::Error::InvalidParameterName("invalid memory kind".into()))?;
            let ids: Vec<(String, i64)> = conn
                .prepare(&format!(
                    "SELECT id,updated_at FROM {table} WHERE user_id=?1"
                ))?
                .query_map([&user_id], |row| Ok((row.get(0)?, row.get(1)?)))?
                .filter_map(Result::ok)
                .collect();
            for (item_id, observed_at) in ids {
                let Some((_, _, snapshot)) = load_revision_state(conn, kind, &item_id)? else {
                    continue;
                };
                let event_type = format!("{kind}.backfilled");
                let idempotency = format!("schema-v4-backfill:{kind}:{item_id}");
                append_event(
                    conn,
                    &MemoryEventInput {
                        user_id: &user_id,
                        card_id: &card_id,
                        item_kind: kind,
                        item_id: &item_id,
                        event_type: &event_type,
                        source_type: "schema-migration",
                        source_id: None,
                        modality: "text",
                        observed_at,
                        trust: 0.7,
                        consent: "legacy",
                        idempotency_key: &idempotency,
                        payload_json: &snapshot,
                    },
                )?;
            }
        }
    }
    Ok(())
}

fn find_user(conn: &Connection, card_id: &str, nickname: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT id FROM memory_users WHERE card_id=?1 AND normalized_name=?2",
        params![card_id, normalize_name(nickname)],
        |row| row.get(0),
    )
    .optional()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub image_caption: String,
    #[serde(default)]
    pub do_not_remember: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEnqueueRequest {
    pub card_id: String,
    pub nickname: String,
    pub session_id: String,
    pub batch_start: i64,
    pub batch_end: i64,
    pub messages: Vec<MemoryMessage>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEnqueueResponse {
    pub accepted: bool,
    pub duplicate: bool,
    pub job_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRecallRequest {
    pub card_id: String,
    pub nickname: String,
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub image_caption: String,
    #[serde(default)]
    pub max_items: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRecallItem {
    pub id: String,
    pub kind: String,
    pub text: String,
    pub occurred_at: Option<i64>,
    pub confidence: f64,
    pub score: f64,
    pub uncertain: bool,
    pub pinned: bool,
    pub predicate: Option<String>,
    pub value: Option<String>,
    pub conflict_key: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRecallResponse {
    pub items: Vec<MemoryRecallItem>,
    pub total_chars: usize,
    pub elapsed_ms: u128,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStatusResponse {
    pub available: bool,
    pub schema_version: i64,
    pub pending_jobs: i64,
    pub skipped_jobs: i64,
    pub database_bytes: u64,
    pub event_count: i64,
    pub last_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryIntegrityResponse {
    pub ok: bool,
    pub schema_version: i64,
    pub checked_at: i64,
    pub foreign_key_errors: usize,
    pub integrity_result: String,
    pub counts: MemoryIntegrityCounts,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryIntegrityCounts {
    pub users: i64,
    pub episodes: i64,
    pub facts: i64,
    pub commitments: i64,
    pub events: i64,
    pub evidence: i64,
    pub edges: i64,
    pub topics: i64,
    pub entities: i64,
    pub search_rows: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryExportRequest {
    pub card_id: String,
    #[serde(default)]
    pub nickname: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryExportResponse {
    pub format_version: i64,
    pub exported_at: i64,
    pub file_name: String,
    pub card_id: String,
    pub user_count: usize,
    pub item_count: usize,
    pub event_count: usize,
    pub edge_count: usize,
    pub json: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryBackupRequest {
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryBackupResponse {
    pub path: String,
    pub bytes: u64,
    pub schema_version: i64,
    pub integrity_result: String,
    pub foreign_key_errors: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryBackupEntry {
    pub path: String,
    pub file_name: String,
    pub bytes: u64,
    pub created_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRestoreResponse {
    pub restored_from: String,
    pub safety_backup_path: String,
    pub schema_version: i64,
    pub integrity_result: String,
    pub foreign_key_errors: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRebuildResponse {
    pub schema_version: i64,
    pub rebuilt_search_rows: i64,
    pub rebuilt_edges: i64,
    pub rebuilt_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryExportUser {
    id: String,
    nickname: String,
    total_sessions: i64,
    last_seen_at: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryExportItem {
    id: String,
    kind: String,
    user_id: String,
    text: String,
    status: String,
    confidence: f64,
    importance: f64,
    pinned: bool,
    occurred_at: Option<i64>,
    updated_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryExportEvent {
    id: String,
    user_id: String,
    item_kind: String,
    item_id: String,
    event_type: String,
    source_type: String,
    source_id: Option<String>,
    observed_at: i64,
    trust: f64,
    consent: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryExportNode {
    id: String,
    kind: String,
    user_id: String,
    name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryExportEdge {
    id: String,
    user_id: String,
    from_kind: String,
    from_id: String,
    to_kind: String,
    to_id: String,
    relation: String,
    source_event_id: Option<String>,
    confidence: f64,
    derived: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryTimelineQuery {
    pub card_id: String,
    pub kind: String,
    pub id: String,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryTimelineEvidence {
    pub relation: String,
    pub source_message_ids: Vec<String>,
    pub excerpt: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryTimelineItem {
    pub id: String,
    pub event_type: String,
    pub source_type: String,
    pub source_id: Option<String>,
    pub modality: String,
    pub observed_at: i64,
    pub trust: f64,
    pub consent: String,
    pub summary: String,
    pub evidence: Vec<MemoryTimelineEvidence>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEdgeItem {
    pub id: String,
    pub from_kind: String,
    pub from_id: String,
    pub from_label: String,
    pub to_kind: String,
    pub to_id: String,
    pub to_label: String,
    pub relation: String,
    pub source_event_id: Option<String>,
    pub confidence: f64,
    pub derived: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEdgesQuery {
    pub card_id: String,
    pub kind: String,
    pub id: String,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryGraphQuery {
    pub card_id: String,
    #[serde(default)]
    pub nickname: String,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub search: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub since: Option<i64>,
    #[serde(default)]
    pub until: Option<i64>,
    #[serde(default)]
    pub min_confidence: Option<f64>,
    #[serde(default)]
    pub depth: Option<usize>,
    #[serde(default)]
    pub max_nodes: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryGraphNode {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub text: String,
    pub status: String,
    pub confidence: f64,
    pub importance: f64,
    pub pinned: bool,
    pub occurred_at: Option<i64>,
    pub user_id: String,
    pub source_event_ids: Vec<String>,
    pub revision: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryGraphEdge {
    pub id: String,
    pub from_kind: String,
    pub from_id: String,
    pub to_kind: String,
    pub to_id: String,
    pub relation: String,
    pub explanation: String,
    pub source_event_id: Option<String>,
    pub confidence: f64,
    pub derived: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryGraphResponse {
    pub nodes: Vec<MemoryGraphNode>,
    pub edges: Vec<MemoryGraphEdge>,
    pub truncated: bool,
    pub depth: usize,
    pub max_nodes: usize,
    pub total_candidates: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryTimelineResponse {
    pub item_kind: String,
    pub item_id: String,
    pub events: Vec<MemoryTimelineItem>,
    pub edges: Vec<MemoryEdgeItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryListQuery {
    pub card_id: String,
    #[serde(default)]
    pub nickname: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub search: String,
    #[serde(default)]
    pub page: Option<usize>,
    #[serde(default)]
    pub page_size: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryListItem {
    pub id: String,
    pub kind: String,
    pub nickname: String,
    pub text: String,
    pub status: String,
    pub confidence: f64,
    pub importance: f64,
    pub pinned: bool,
    pub occurred_at: Option<i64>,
    pub source_excerpt: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryListResponse {
    pub items: Vec<MemoryListItem>,
    pub total: usize,
    pub page: usize,
    pub page_size: usize,
    pub counts: MemoryTypeCounts,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryTypeCounts {
    pub facts: usize,
    pub episodes: usize,
    pub commitments: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryUpdateRequest {
    pub kind: String,
    pub id: String,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub pinned: Option<bool>,
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDeleteRequest {
    pub items: Vec<MemoryItemRef>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryItemRef {
    pub kind: String,
    pub id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryClearRequest {
    pub card_id: String,
    #[serde(default)]
    pub nickname: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryLegacyRequest {
    pub card_id: String,
    pub memories: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryMutationResponse {
    pub ok: bool,
    pub affected: usize,
}

#[tauri::command]
pub fn memory_status(state: State<'_, MemoryState>) -> MemoryStatusResponse {
    let guard = state.conn.lock().unwrap();
    let (pending, skipped, event_count) = guard
        .as_ref()
        .map(|conn| {
            let pending = conn
                .query_row(
                    "SELECT COUNT(*) FROM memory_jobs WHERE status IN ('pending','retrying','processing')",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            let skipped = conn
                .query_row(
                    "SELECT COUNT(*) FROM memory_jobs WHERE status='skipped'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            let events = conn
                .query_row("SELECT COUNT(*) FROM memory_events", [], |r| r.get(0))
                .unwrap_or(0);
            (pending, skipped, events)
        })
        .unwrap_or((0, 0, 0));
    let database_bytes = state
        .db_path
        .as_ref()
        .and_then(|p| fs::metadata(p).ok())
        .map(|m| m.len())
        .unwrap_or(0);
    MemoryStatusResponse {
        available: guard.is_some(),
        schema_version: if guard.is_some() { SCHEMA_VERSION } else { 0 },
        pending_jobs: pending,
        skipped_jobs: skipped,
        database_bytes,
        event_count,
        last_error: state.last_error.lock().unwrap().clone(),
    }
}

fn scalar_count(conn: &Connection, sql: &str) -> rusqlite::Result<i64> {
    conn.query_row(sql, [], |row| row.get(0))
}

fn integrity_check(conn: &Connection) -> Result<MemoryIntegrityResponse, String> {
    let checked_at = now_ts();
    let schema_version = conn
        .query_row(
            "SELECT value FROM memory_meta WHERE key='schema_version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    if schema_version != SCHEMA_VERSION {
        errors.push(format!(
            "schema version {schema_version} 与当前支持版本 {SCHEMA_VERSION} 不一致"
        ));
    }
    let integrity_result = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
        .unwrap_or_else(|error| format!("执行 integrity_check 失败：{error}"));
    if integrity_result != "ok" {
        errors.push(format!("SQLite integrity_check：{integrity_result}"));
    }
    let foreign_key_errors = conn
        .prepare("PRAGMA foreign_key_check")
        .and_then(|mut stmt| stmt.query_map([], |_| Ok(())).map(|rows| rows.count()))
        .unwrap_or(0);
    if foreign_key_errors > 0 {
        errors.push(format!("发现 {foreign_key_errors} 条外键错误"));
    }
    let counts = MemoryIntegrityCounts {
        users: scalar_count(conn, "SELECT COUNT(*) FROM memory_users").unwrap_or(0),
        episodes: scalar_count(conn, "SELECT COUNT(*) FROM memory_episodes").unwrap_or(0),
        facts: scalar_count(conn, "SELECT COUNT(*) FROM memory_facts").unwrap_or(0),
        commitments: scalar_count(conn, "SELECT COUNT(*) FROM memory_commitments").unwrap_or(0),
        events: scalar_count(conn, "SELECT COUNT(*) FROM memory_events").unwrap_or(0),
        evidence: scalar_count(conn, "SELECT COUNT(*) FROM memory_evidence").unwrap_or(0),
        edges: scalar_count(conn, "SELECT COUNT(*) FROM memory_edges").unwrap_or(0),
        topics: scalar_count(conn, "SELECT COUNT(*) FROM memory_topics").unwrap_or(0),
        entities: scalar_count(conn, "SELECT COUNT(*) FROM memory_entities").unwrap_or(0),
        search_rows: scalar_count(conn, "SELECT COUNT(*) FROM memory_search").unwrap_or(0),
    };
    let expected_search = counts.episodes + counts.facts + counts.commitments;
    if expected_search != counts.search_rows {
        errors.push(format!(
            "FTS 行数 {search_rows} 与记忆条目数 {expected_search} 不一致",
            search_rows = counts.search_rows
        ));
    }
    let missing_nodes = scalar_count(
        conn,
        "SELECT COUNT(*) FROM memory_edges e
         WHERE (e.to_kind='topic' AND NOT EXISTS(SELECT 1 FROM memory_topics t WHERE t.id=e.to_id AND t.user_id=e.user_id))
            OR (e.to_kind='entity' AND NOT EXISTS(SELECT 1 FROM memory_entities n WHERE n.id=e.to_id AND n.user_id=e.user_id))",
    )
    .unwrap_or(0);
    if missing_nodes > 0 {
        errors.push(format!(
            "发现 {missing_nodes} 条关系边指向不存在的 topic/entity"
        ));
    }
    let orphan_item_edges = scalar_count(
        conn,
        "SELECT COUNT(*) FROM memory_edges e
         WHERE (e.from_kind IN ('episode','fact','commitment') AND NOT EXISTS(
             SELECT 1 FROM memory_episodes x WHERE e.from_kind='episode' AND x.id=e.from_id
             UNION ALL SELECT 1 FROM memory_facts x WHERE e.from_kind='fact' AND x.id=e.from_id
             UNION ALL SELECT 1 FROM memory_commitments x WHERE e.from_kind='commitment' AND x.id=e.from_id
         ))",
    )
    .unwrap_or(0);
    if orphan_item_edges > 0 {
        errors.push(format!("发现 {orphan_item_edges} 条关系边起点不存在"));
    }
    if counts.evidence > counts.events {
        warnings.push("证据记录数超过事件数，请检查是否存在重复来源".into());
    }
    Ok(MemoryIntegrityResponse {
        ok: errors.is_empty(),
        schema_version,
        checked_at,
        foreign_key_errors,
        integrity_result,
        counts,
        errors,
        warnings,
    })
}

#[tauri::command]
pub fn memory_integrity_check(
    state: State<'_, MemoryState>,
) -> Result<MemoryIntegrityResponse, String> {
    let guard = state.conn.lock().unwrap();
    let conn = guard
        .as_ref()
        .ok_or_else(|| "记忆数据库不可用".to_string())?;
    integrity_check(conn)
}

fn export_safe_text(text: &str) -> String {
    if is_sensitive(text) {
        "[敏感内容已省略]".into()
    } else {
        truncate_chars(text, 1000)
    }
}

fn export_memory(
    conn: &Connection,
    request: &MemoryExportRequest,
) -> Result<MemoryExportResponse, String> {
    let user_filter = if request.nickname.trim().is_empty() {
        None
    } else {
        find_user(conn, &request.card_id, &request.nickname).map_err(|e| e.to_string())?
    };
    let include_user = |user_id: &str| user_filter.as_ref().is_none_or(|id| id == user_id);
    let mut users = Vec::new();
    let mut user_stmt = conn
        .prepare(
            "SELECT id,display_name,total_sessions,last_seen_at FROM memory_users WHERE card_id=?1 ORDER BY created_at",
        )
        .map_err(|e| e.to_string())?;
    for row in user_stmt
        .query_map([&request.card_id], |row| {
            Ok(MemoryExportUser {
                id: row.get(0)?,
                nickname: export_safe_text(&row.get::<_, String>(1)?),
                total_sessions: row.get(2)?,
                last_seen_at: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
    {
        let user = row.map_err(|e| e.to_string())?;
        if include_user(&user.id) {
            users.push(user);
        }
    }
    let mut items = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT f.id,f.user_id,f.text,f.status,f.confidence,f.importance,f.pinned,f.valid_from,f.updated_at
                 FROM memory_facts f JOIN memory_users u ON u.id=f.user_id WHERE u.card_id=?1",
            )
            .map_err(|e| e.to_string())?;
        for row in stmt
            .query_map([&request.card_id], |row| {
                Ok(MemoryExportItem {
                    id: row.get(0)?,
                    kind: "fact".into(),
                    user_id: row.get(1)?,
                    text: export_safe_text(&row.get::<_, String>(2)?),
                    status: row.get(3)?,
                    confidence: row.get(4)?,
                    importance: row.get(5)?,
                    pinned: row.get::<_, i64>(6)? != 0,
                    occurred_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            })
            .map_err(|e| e.to_string())?
        {
            let item = row.map_err(|e| e.to_string())?;
            if include_user(&item.user_id) {
                items.push(item);
            }
        }
    }
    {
        let mut stmt = conn
            .prepare(
                "SELECT e.id,e.user_id,e.summary,'active',1.0,e.importance,e.pinned,e.occurred_at,e.updated_at
                 FROM memory_episodes e JOIN memory_users u ON u.id=e.user_id WHERE u.card_id=?1",
            )
            .map_err(|e| e.to_string())?;
        for row in stmt
            .query_map([&request.card_id], |row| {
                Ok(MemoryExportItem {
                    id: row.get(0)?,
                    kind: "episode".into(),
                    user_id: row.get(1)?,
                    text: export_safe_text(&row.get::<_, String>(2)?),
                    status: row.get(3)?,
                    confidence: row.get(4)?,
                    importance: row.get(5)?,
                    pinned: row.get::<_, i64>(6)? != 0,
                    occurred_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            })
            .map_err(|e| e.to_string())?
        {
            let item = row.map_err(|e| e.to_string())?;
            if include_user(&item.user_id) {
                items.push(item);
            }
        }
    }
    {
        let mut stmt = conn
            .prepare(
                "SELECT c.id,c.user_id,c.text,c.status,1.0,c.importance,c.pinned,c.due_at,c.updated_at
                 FROM memory_commitments c JOIN memory_users u ON u.id=c.user_id WHERE u.card_id=?1",
            )
            .map_err(|e| e.to_string())?;
        for row in stmt
            .query_map([&request.card_id], |row| {
                Ok(MemoryExportItem {
                    id: row.get(0)?,
                    kind: "commitment".into(),
                    user_id: row.get(1)?,
                    text: export_safe_text(&row.get::<_, String>(2)?),
                    status: row.get(3)?,
                    confidence: row.get(4)?,
                    importance: row.get(5)?,
                    pinned: row.get::<_, i64>(6)? != 0,
                    occurred_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            })
            .map_err(|e| e.to_string())?
        {
            let item = row.map_err(|e| e.to_string())?;
            if include_user(&item.user_id) {
                items.push(item);
            }
        }
    }
    let mut events = Vec::new();
    let mut event_stmt = conn
        .prepare(
            "SELECT e.id,e.user_id,e.item_kind,e.item_id,e.event_type,e.source_type,e.source_id,
                    e.observed_at,e.trust,e.consent
             FROM memory_events e JOIN memory_users u ON u.id=e.user_id WHERE u.card_id=?1 ORDER BY e.created_at",
        )
        .map_err(|e| e.to_string())?;
    for row in event_stmt
        .query_map([&request.card_id], |row| {
            Ok(MemoryExportEvent {
                id: row.get(0)?,
                user_id: row.get(1)?,
                item_kind: row.get(2)?,
                item_id: row.get(3)?,
                event_type: row.get(4)?,
                source_type: row.get(5)?,
                source_id: row.get(6)?,
                observed_at: row.get(7)?,
                trust: row.get(8)?,
                consent: row.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?
    {
        let event = row.map_err(|e| e.to_string())?;
        if include_user(&event.user_id) {
            events.push(event);
        }
    }
    let mut nodes = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT id,'topic',user_id,name FROM memory_topics WHERE user_id IN (SELECT id FROM memory_users WHERE card_id=?1)
             UNION ALL SELECT id,'entity',user_id,canonical_name FROM memory_entities WHERE user_id IN (SELECT id FROM memory_users WHERE card_id=?1)",
        ).map_err(|e| e.to_string())?;
        for row in stmt
            .query_map([&request.card_id], |row| {
                Ok(MemoryExportNode {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    user_id: row.get(2)?,
                    name: export_safe_text(&row.get::<_, String>(3)?),
                })
            })
            .map_err(|e| e.to_string())?
        {
            let node = row.map_err(|e| e.to_string())?;
            if include_user(&node.user_id) && node.name != "[敏感内容已省略]" {
                nodes.push(node);
            }
        }
    }
    let mut edges = Vec::new();
    let mut edge_stmt = conn.prepare(
        "SELECT e.id,e.user_id,e.from_kind,e.from_id,e.to_kind,e.to_id,e.relation,e.source_event_id,e.confidence,e.derived
         FROM memory_edges e JOIN memory_users u ON u.id=e.user_id WHERE u.card_id=?1 ORDER BY e.created_at",
    ).map_err(|e| e.to_string())?;
    for row in edge_stmt
        .query_map([&request.card_id], |row| {
            Ok(MemoryExportEdge {
                id: row.get(0)?,
                user_id: row.get(1)?,
                from_kind: row.get(2)?,
                from_id: row.get(3)?,
                to_kind: row.get(4)?,
                to_id: row.get(5)?,
                relation: row.get(6)?,
                source_event_id: row.get(7)?,
                confidence: row.get(8)?,
                derived: row.get::<_, i64>(9)? != 0,
            })
        })
        .map_err(|e| e.to_string())?
    {
        let edge = row.map_err(|e| e.to_string())?;
        if include_user(&edge.user_id) {
            edges.push(edge);
        }
    }
    let exported_at = now_ts();
    let user_count = users.len();
    let item_count = items.len();
    let event_count = events.len();
    let edge_count = edges.len();
    let payload = serde_json::json!({
        "formatVersion": 1,
        "exportedAt": exported_at,
        "cardId": request.card_id,
        "users": users,
        "items": items,
        "events": events,
        "nodes": nodes,
        "edges": edges,
        "privacy": "来源原文、事件 payload 和证据片段未导出；敏感字段已省略。",
    });
    let json = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    let file_name = format!("memory-export-{}-{}.json", request.card_id, exported_at);
    Ok(MemoryExportResponse {
        format_version: 1,
        exported_at,
        file_name,
        card_id: request.card_id.clone(),
        user_count,
        item_count,
        event_count,
        edge_count,
        json,
    })
}

#[tauri::command]
pub fn memory_export(
    state: State<'_, MemoryState>,
    request: MemoryExportRequest,
) -> Result<MemoryExportResponse, String> {
    let guard = state.conn.lock().unwrap();
    let conn = guard
        .as_ref()
        .ok_or_else(|| "记忆数据库不可用".to_string())?;
    export_memory(conn, &request)
}

fn backup_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位记忆备份目录：{e}"))?
        .join("memory-backups");
    fs::create_dir_all(&dir).map_err(|e| format!("创建备份目录失败：{e}"))?;
    Ok(dir)
}

fn verify_backup_file(path: &Path) -> Result<MemoryBackupResponse, String> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("打开备份失败：{e}"))?;
    let required_tables = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type IN ('table','view')
               AND name IN ('memory_meta','memory_users','memory_jobs','memory_episodes',
                            'memory_facts','memory_commitments','memory_search')",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| format!("检查备份结构失败：{e}"))?;
    if required_tables != 7 {
        return Err("所选文件不是受支持的 Memory 数据库备份".into());
    }
    let integrity_result = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
        .map_err(|e| format!("备份完整性检查失败：{e}"))?;
    let foreign_key_errors = conn
        .prepare("PRAGMA foreign_key_check")
        .and_then(|mut stmt| stmt.query_map([], |_| Ok(())).map(|rows| rows.count()))
        .map_err(|e| format!("备份外键检查失败：{e}"))?;
    let schema_version = conn
        .query_row(
            "SELECT value FROM memory_meta WHERE key='schema_version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    let bytes = fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
    Ok(MemoryBackupResponse {
        path: path.display().to_string(),
        bytes,
        schema_version,
        integrity_result,
        foreign_key_errors,
    })
}

fn create_backup_file(
    app: &AppHandle,
    conn: &mut Connection,
    prefix: &str,
) -> Result<MemoryBackupResponse, String> {
    maintenance(conn).map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .map_err(|e| e.to_string())?;
    let dir = backup_dir(app)?;
    let path = dir.join(format!("{prefix}-{}-{}.sqlite3", now_ts(), Uuid::new_v4()));
    conn.execute("VACUUM INTO ?1", [path.to_string_lossy().as_ref()])
        .map_err(|e| format!("创建备份失败：{e}"))?;
    match verify_backup_file(&path) {
        Ok(response) => Ok(response),
        Err(error) => {
            let _ = fs::remove_file(&path);
            Err(error)
        }
    }
}

fn validated_backup_path(app: &AppHandle, requested: &str) -> Result<PathBuf, String> {
    let dir = backup_dir(app)?
        .canonicalize()
        .map_err(|e| format!("无法读取记忆备份目录：{e}"))?;
    let path = PathBuf::from(requested)
        .canonicalize()
        .map_err(|e| format!("找不到所选备份：{e}"))?;
    if path.parent() != Some(dir.as_path())
        || path.extension().and_then(|v| v.to_str()) != Some("sqlite3")
    {
        return Err("只能使用应用记忆备份目录中的 SQLite 备份".into());
    }
    Ok(path)
}

#[tauri::command]
pub fn memory_list_backups(app: AppHandle) -> Result<Vec<MemoryBackupEntry>, String> {
    let dir = backup_dir(&app)?;
    let mut entries = Vec::new();
    for item in fs::read_dir(&dir).map_err(|e| format!("读取记忆备份目录失败：{e}"))? {
        let item = item.map_err(|e| format!("读取记忆备份失败：{e}"))?;
        let path = item.path();
        if path.extension().and_then(|value| value.to_str()) != Some("sqlite3") {
            continue;
        }
        let file_type = item
            .file_type()
            .map_err(|e| format!("读取备份类型失败：{e}"))?;
        if !file_type.is_file() || file_type.is_symlink() {
            continue;
        }
        let metadata = item
            .metadata()
            .map_err(|e| format!("读取备份信息失败：{e}"))?;
        if !metadata.is_file() {
            continue;
        }
        let created_at = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs() as i64)
            .unwrap_or(0);
        entries.push(MemoryBackupEntry {
            path: path.display().to_string(),
            file_name: item.file_name().to_string_lossy().into_owned(),
            bytes: metadata.len(),
            created_at,
        });
    }
    entries.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| b.file_name.cmp(&a.file_name))
    });
    entries.truncate(MAX_LISTED_BACKUPS);
    Ok(entries)
}

#[tauri::command]
pub fn memory_backup(
    app: AppHandle,
    state: State<'_, MemoryState>,
) -> Result<MemoryBackupResponse, String> {
    let mut guard = state.conn.lock().unwrap();
    let conn = guard
        .as_mut()
        .ok_or_else(|| "记忆数据库不可用".to_string())?;
    create_backup_file(&app, conn, "memory-v5")
}

#[tauri::command]
pub fn memory_verify_backup(
    app: AppHandle,
    request: MemoryBackupRequest,
) -> Result<MemoryBackupResponse, String> {
    let path = validated_backup_path(&app, &request.path)?;
    verify_backup_file(&path)
}

fn copy_database(source_path: &Path, destination: &mut Connection) -> Result<(), String> {
    let source = Connection::open_with_flags(source_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("打开备份失败：{e}"))?;
    let backup = rusqlite::backup::Backup::new(&source, destination)
        .map_err(|e| format!("准备恢复备份失败：{e}"))?;
    backup
        .run_to_completion(128, Duration::from_millis(5), None)
        .map_err(|e| format!("恢复备份失败：{e}"))
}

fn finish_restored_database(conn: &mut Connection) -> Result<MemoryIntegrityResponse, String> {
    configure(conn).map_err(|e| format!("恢复数据库配置失败：{e}"))?;
    migrate(conn).map_err(|e| format!("迁移恢复数据库失败：{e}"))?;
    maintenance(conn).map_err(|e| format!("维护恢复数据库失败：{e}"))?;
    let result = integrity_check(conn)?;
    if !result.ok {
        return Err(format!(
            "恢复后的数据库未通过完整性检查：{}",
            result.errors.join("；")
        ));
    }
    Ok(result)
}

#[tauri::command]
pub fn memory_restore_backup(
    app: AppHandle,
    state: State<'_, MemoryState>,
    request: MemoryBackupRequest,
) -> Result<MemoryRestoreResponse, String> {
    let source_path = validated_backup_path(&app, &request.path)?;
    let verified = verify_backup_file(&source_path)?;
    if verified.integrity_result != "ok" || verified.foreign_key_errors != 0 {
        return Err("所选备份未通过完整性或外键检查，已拒绝恢复".into());
    }
    if verified.schema_version <= 0 || verified.schema_version > SCHEMA_VERSION {
        return Err(format!(
            "备份数据库版本 {} 不受当前应用支持",
            verified.schema_version
        ));
    }

    let mut guard = state.conn.lock().unwrap();
    let conn = guard
        .as_mut()
        .ok_or_else(|| "记忆数据库不可用".to_string())?;
    let safety = create_backup_file(&app, conn, "memory-pre-restore")?;
    state.database_generation.fetch_add(1, Ordering::SeqCst);
    let restored = copy_database(&source_path, conn).and_then(|_| finish_restored_database(conn));
    let integrity = match restored {
        Ok(result) => result,
        Err(restore_error) => {
            let rollback_path = PathBuf::from(&safety.path);
            let rollback =
                copy_database(&rollback_path, conn).and_then(|_| finish_restored_database(conn));
            let error = match rollback {
                Ok(_) => format!("{restore_error}；已自动恢复操作前的数据库"),
                Err(rollback_error) => format!(
                    "{restore_error}；自动回滚也失败：{rollback_error}。操作前备份保留在 {}",
                    safety.path
                ),
            };
            drop(guard);
            trigger_worker(&app);
            return Err(error);
        }
    };
    let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    state.clear_error();
    let response = MemoryRestoreResponse {
        restored_from: source_path.display().to_string(),
        safety_backup_path: safety.path,
        schema_version: integrity.schema_version,
        integrity_result: integrity.integrity_result,
        foreign_key_errors: integrity.foreign_key_errors,
    };
    drop(guard);
    trigger_worker(&app);
    Ok(response)
}

fn rebuild_search_index(tx: &Transaction<'_>) -> rusqlite::Result<()> {
    let facts: Vec<(String, String, String, String, String)> = tx
        .prepare(
            "SELECT f.id,f.user_id,u.card_id,f.text,f.predicate||' '||f.value
             FROM memory_facts f JOIN memory_users u ON u.id=f.user_id
             WHERE f.status IN ('active','disputed') AND (f.valid_to IS NULL OR f.valid_to >= ?1)",
        )?
        .query_map([now_ts()], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })?
        .filter_map(Result::ok)
        .collect();
    for (id, user_id, card_id, text, tags) in facts {
        index_item(tx, &id, "fact", &card_id, &user_id, &text, &tags)?;
    }
    let episodes: Vec<(String, String, String, String, String)> = tx
        .prepare(
            "SELECT e.id,e.user_id,u.card_id,e.summary,e.topics_json||' '||e.entities_json
             FROM memory_episodes e JOIN memory_users u ON u.id=e.user_id",
        )?
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })?
        .filter_map(Result::ok)
        .collect();
    for (id, user_id, card_id, text, tags) in episodes {
        index_item(tx, &id, "episode", &card_id, &user_id, &text, &tags)?;
    }
    let commitments: Vec<(String, String, String, String)> = tx
        .prepare(
            "SELECT c.id,c.user_id,u.card_id,c.text
             FROM memory_commitments c JOIN memory_users u ON u.id=c.user_id
             WHERE c.status='pending' AND (c.due_at IS NULL OR c.due_at >= ?1)",
        )?
        .query_map([now_ts()], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?
        .filter_map(Result::ok)
        .collect();
    for (id, user_id, card_id, text) in commitments {
        index_item(
            tx,
            &id,
            "commitment",
            &card_id,
            &user_id,
            &text,
            "约定 承诺 待办",
        )?;
    }
    Ok(())
}

fn rebuild_derived(conn: &mut Connection) -> Result<MemoryRebuildResponse, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM memory_search", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM memory_edges", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM memory_topics", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM memory_entities", [])
        .map_err(|e| e.to_string())?;
    rebuild_search_index(&tx).map_err(|e| e.to_string())?;
    backfill_v5_graph(&tx).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    let rebuilt_search_rows = scalar_count(conn, "SELECT COUNT(*) FROM memory_search").unwrap_or(0);
    let rebuilt_edges = scalar_count(conn, "SELECT COUNT(*) FROM memory_edges").unwrap_or(0);
    Ok(MemoryRebuildResponse {
        schema_version: SCHEMA_VERSION,
        rebuilt_search_rows,
        rebuilt_edges,
        rebuilt_at: now_ts(),
    })
}

#[tauri::command]
pub fn memory_rebuild_derived(
    state: State<'_, MemoryState>,
) -> Result<MemoryRebuildResponse, String> {
    let mut guard = state.conn.lock().unwrap();
    let conn = guard
        .as_mut()
        .ok_or_else(|| "记忆数据库不可用".to_string())?;
    rebuild_derived(conn)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRebuildEventsRequest {
    pub card_id: String,
    #[serde(default)]
    pub nickname: Option<String>,
}

/// Rebuild the user-facing materialized memory tables from the append-only
/// event log. The event rows are never changed or deleted; all derived tables
/// are replaced inside one transaction and rebuilt indexes/edges afterwards.
#[tauri::command]
pub fn memory_rebuild_from_events(
    state: State<'_, MemoryState>,
    request: MemoryRebuildEventsRequest,
) -> Result<MemoryRebuildResponse, String> {
    let mut guard = state.conn.lock().unwrap();
    let conn = guard
        .as_mut()
        .ok_or_else(|| "记忆数据库不可用".to_string())?;
    rebuild_from_events(conn, &request)
}

fn rebuild_from_events(
    conn: &mut Connection,
    request: &MemoryRebuildEventsRequest,
) -> Result<MemoryRebuildResponse, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let users: Vec<String> = {
        let mut stmt = tx
            .prepare("SELECT id FROM memory_users WHERE card_id=?1 AND (?2 IS NULL OR normalized_name=lower(trim(?2)))")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![request.card_id, request.nickname.as_deref()], |r| {
                r.get(0)
            })
            .map_err(|e| e.to_string())?;
        rows.filter_map(Result::ok).collect()
    };
    if users.is_empty() {
        return Err("找不到要重建的记忆范围".into());
    }
    let placeholders = std::iter::repeat("?")
        .take(users.len())
        .collect::<Vec<_>>()
        .join(",");
    let in_params = |sql: &str| sql.replace("{0}", &placeholders);
    for sql in [
        in_params("DELETE FROM memory_edges WHERE user_id IN ({0})"),
        in_params("DELETE FROM memory_search WHERE user_id IN ({0})"),
        in_params("DELETE FROM memory_topics WHERE user_id IN ({0})"),
        in_params("DELETE FROM memory_entities WHERE user_id IN ({0})"),
        in_params("DELETE FROM memory_facts WHERE user_id IN ({0})"),
        in_params("DELETE FROM memory_episodes WHERE user_id IN ({0})"),
        in_params("DELETE FROM memory_commitments WHERE user_id IN ({0})"),
    ] {
        let mut stmt = tx.prepare(&sql).map_err(|e| e.to_string())?;
        let mut values = Vec::with_capacity(users.len());
        for user in &users {
            values.push(user.as_str());
        }
        stmt.execute(rusqlite::params_from_iter(values))
            .map_err(|e| e.to_string())?;
    }
    let event_sql = format!(
        "SELECT user_id,item_kind,item_id,event_type,source_id,observed_at,trust,payload_json FROM memory_events WHERE user_id IN ({placeholders}) ORDER BY created_at ASC,rowid ASC"
    );
    let mut events = tx.prepare(&event_sql).map_err(|e| e.to_string())?;
    let event_values: Vec<&str> = users.iter().map(String::as_str).collect();
    let rows = events
        .query_map(rusqlite::params_from_iter(event_values), |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, f64>(6)?,
                r.get::<_, String>(7)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (user_id, kind, id, event_type, source_id, observed_at, trust, payload) =
            row.map_err(|e| e.to_string())?;
        let value: Value =
            serde_json::from_str(&payload).map_err(|e| format!("事件 {id} payload 无效：{e}"))?;
        let snapshot = value.get("snapshot").unwrap_or(&value);
        match kind.as_str() {
            "episode" => replay_episode(
                &tx,
                &user_id,
                &id,
                source_id.as_deref(),
                observed_at,
                trust,
                snapshot,
                &event_type,
            )
            .map_err(|e| e.to_string())?,
            "fact" => replay_fact(
                &tx,
                &user_id,
                &id,
                observed_at,
                trust,
                snapshot,
                &event_type,
            )
            .map_err(|e| e.to_string())?,
            "commitment" => {
                replay_commitment(&tx, &user_id, &id, observed_at, snapshot, &event_type)
                    .map_err(|e| e.to_string())?
            }
            _ => {}
        }
    }
    drop(events);
    rebuild_search_index(&tx).map_err(|e| e.to_string())?;
    backfill_v5_graph(&tx).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(MemoryRebuildResponse {
        schema_version: SCHEMA_VERSION,
        rebuilt_search_rows: scalar_count(conn, "SELECT COUNT(*) FROM memory_search").unwrap_or(0),
        rebuilt_edges: scalar_count(conn, "SELECT COUNT(*) FROM memory_edges").unwrap_or(0),
        rebuilt_at: now_ts(),
    })
}

fn replay_episode(
    tx: &Transaction<'_>,
    user_id: &str,
    id: &str,
    session_id: Option<&str>,
    observed_at: i64,
    trust: f64,
    p: &Value,
    event_type: &str,
) -> rusqlite::Result<()> {
    if event_type.ends_with("superseded") || event_type.ends_with("deleted") {
        return Ok(());
    }
    let summary = p.get("summary").and_then(Value::as_str).unwrap_or("");
    if summary.trim().is_empty() {
        return Ok(());
    }
    let topics = p
        .get("topics")
        .cloned()
        .unwrap_or_else(|| Value::Array(vec![]));
    let entities = p
        .get("entities")
        .cloned()
        .unwrap_or_else(|| Value::Array(vec![]));
    tx.execute("INSERT INTO memory_episodes(id,user_id,session_id,summary,emotion,importance,topics_json,entities_json,occurred_at,created_at,updated_at,pinned,user_edited) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?9,?9,?10,?11) ON CONFLICT(id) DO UPDATE SET summary=excluded.summary,emotion=excluded.emotion,importance=excluded.importance,topics_json=excluded.topics_json,entities_json=excluded.entities_json,updated_at=excluded.updated_at,pinned=excluded.pinned,user_edited=excluded.user_edited", params![id,user_id,session_id,truncate_chars(summary,1000),p.get("emotion").and_then(Value::as_str).unwrap_or(""),clamp01(p.get("importance").and_then(Value::as_f64).unwrap_or(trust)),serde_json::to_string(&topics).unwrap_or("[]".into()),serde_json::to_string(&entities).unwrap_or("[]".into()),observed_at,p.get("pinned").and_then(Value::as_bool).unwrap_or(false) as i64,p.get("userEdited").and_then(Value::as_bool).unwrap_or(false) as i64])?;
    Ok(())
}

fn replay_fact(
    tx: &Transaction<'_>,
    user_id: &str,
    id: &str,
    observed_at: i64,
    trust: f64,
    p: &Value,
    event_type: &str,
) -> rusqlite::Result<()> {
    if event_type.ends_with("superseded") {
        tx.execute(
            "UPDATE memory_facts SET status='superseded',valid_to=?2,updated_at=?2 WHERE id=?1",
            params![id, observed_at],
        )?;
        return Ok(());
    }
    if event_type.ends_with("deleted") {
        tx.execute("DELETE FROM memory_facts WHERE id=?1", [id])?;
        return Ok(());
    }
    let text = p.get("text").and_then(Value::as_str).unwrap_or("");
    if text.trim().is_empty() {
        return Ok(());
    }
    let status = p
        .get("status")
        .and_then(Value::as_str)
        .or_else(|| event_type.ends_with("disputed").then_some("disputed"))
        .unwrap_or("active");
    tx.execute("INSERT INTO memory_facts(id,user_id,source_episode_id,text,predicate,value,confidence,importance,durability,status,valid_from,valid_to,confirmation_count,pinned,user_edited,first_seen_at,last_confirmed_at,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,1,?13,?14,?15,?15,?15,?15) ON CONFLICT(id) DO UPDATE SET source_episode_id=excluded.source_episode_id,text=excluded.text,predicate=excluded.predicate,value=excluded.value,confidence=excluded.confidence,importance=excluded.importance,durability=excluded.durability,status=excluded.status,valid_from=excluded.valid_from,valid_to=excluded.valid_to,pinned=excluded.pinned,user_edited=excluded.user_edited,updated_at=excluded.updated_at,last_confirmed_at=excluded.last_confirmed_at", params![id,user_id,p.get("sourceEpisodeId").and_then(Value::as_str),truncate_chars(text,600),p.get("predicate").and_then(Value::as_str).unwrap_or(text),p.get("value").and_then(Value::as_str).unwrap_or(text),clamp01(p.get("confidence").and_then(Value::as_f64).unwrap_or(trust)),clamp01(p.get("importance").and_then(Value::as_f64).unwrap_or(0.5)),p.get("durability").and_then(Value::as_str).unwrap_or("stable"),status,p.get("validFrom").and_then(Value::as_i64),p.get("validTo").and_then(Value::as_i64),p.get("pinned").and_then(Value::as_bool).unwrap_or(false) as i64,p.get("userEdited").and_then(Value::as_bool).unwrap_or(false) as i64,observed_at])?;
    Ok(())
}

fn replay_commitment(
    tx: &Transaction<'_>,
    user_id: &str,
    id: &str,
    observed_at: i64,
    p: &Value,
    event_type: &str,
) -> rusqlite::Result<()> {
    if event_type.ends_with("deleted") {
        tx.execute("DELETE FROM memory_commitments WHERE id=?1", [id])?;
        return Ok(());
    }
    let text = p.get("text").and_then(Value::as_str).unwrap_or("");
    if text.trim().is_empty() {
        if event_type.ends_with("status_changed") {
            if let Some(status) = p.get("status").and_then(Value::as_str) {
                tx.execute(
                    "UPDATE memory_commitments SET status=?2,resolved_at=?3,updated_at=?3 WHERE id=?1",
                    params![id, status, (status != "pending").then_some(observed_at)],
                )?;
            }
        }
        return Ok(());
    }
    let status = p.get("status").and_then(Value::as_str).unwrap_or(
        if event_type.ends_with("status_changed") {
            "fulfilled"
        } else {
            "pending"
        },
    );
    tx.execute("INSERT INTO memory_commitments(id,user_id,source_episode_id,text,due_at,status,importance,pinned,user_edited,created_at,updated_at,resolved_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10,?11) ON CONFLICT(id) DO UPDATE SET source_episode_id=excluded.source_episode_id,text=excluded.text,due_at=excluded.due_at,status=excluded.status,importance=excluded.importance,pinned=excluded.pinned,user_edited=excluded.user_edited,updated_at=excluded.updated_at,resolved_at=excluded.resolved_at", params![id,user_id,p.get("sourceEpisodeId").and_then(Value::as_str),truncate_chars(text,600),p.get("dueAt").and_then(Value::as_i64),status,clamp01(p.get("importance").and_then(Value::as_f64).unwrap_or(0.7)),p.get("pinned").and_then(Value::as_bool).unwrap_or(false) as i64,p.get("userEdited").and_then(Value::as_bool).unwrap_or(false) as i64,observed_at,(status != "pending").then_some(observed_at)])?;
    Ok(())
}

#[tauri::command]
pub fn memory_timeline(
    state: State<'_, MemoryState>,
    query: MemoryTimelineQuery,
) -> Result<MemoryTimelineResponse, String> {
    let guard = state.conn.lock().unwrap();
    let conn = guard
        .as_ref()
        .ok_or_else(|| "记忆数据库不可用".to_string())?;
    timeline(conn, &query)
}

fn timeline(
    conn: &Connection,
    query: &MemoryTimelineQuery,
) -> Result<MemoryTimelineResponse, String> {
    if !matches!(
        query.kind.as_str(),
        "fact" | "episode" | "commitment" | "entity" | "topic"
    ) {
        return Err("不支持的图节点类型".into());
    }
    let limit = query.limit.unwrap_or(20).clamp(1, 50) as i64;
    let mut stmt = conn
        .prepare(
            "SELECT e.id,e.event_type,e.source_type,e.source_id,e.modality,e.observed_at,
                    e.trust,e.consent,e.payload_json
             FROM memory_events e JOIN memory_users u ON u.id=e.user_id
             WHERE u.card_id=?1 AND e.item_kind=?2 AND e.item_id=?3
             ORDER BY e.created_at DESC LIMIT ?4",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![query.card_id, query.kind, query.id, limit], |row| {
            let payload: String = row.get(8)?;
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, f64>(6)?,
                row.get::<_, String>(7)?,
                payload,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut events = Vec::new();
    for row in rows {
        let (
            id,
            event_type,
            source_type,
            source_id,
            modality,
            observed_at,
            trust,
            consent,
            payload,
        ) = row.map_err(|e| e.to_string())?;
        let evidence = conn
            .prepare(
                "SELECT relation,source_message_ids_json,excerpt
                 FROM memory_evidence WHERE event_id=?1 ORDER BY created_at",
            )
            .and_then(|mut evidence_stmt| {
                evidence_stmt
                    .query_map([&id], |e| {
                        let ids: String = e.get(1)?;
                        Ok(MemoryTimelineEvidence {
                            relation: e.get(0)?,
                            source_message_ids: serde_json::from_str(&ids).unwrap_or_default(),
                            excerpt: e.get(2)?,
                        })
                    })
                    .map(|rows| rows.filter_map(Result::ok).collect::<Vec<_>>())
            })
            .map_err(|e| e.to_string())?;
        events.push(MemoryTimelineItem {
            id,
            event_type: event_type.clone(),
            source_type,
            source_id,
            modality,
            observed_at,
            trust,
            consent,
            summary: timeline_summary(&event_type, &payload),
            evidence,
        });
    }
    let edges = query_edges(conn, &query.card_id, &query.kind, &query.id, limit as usize)?;
    Ok(MemoryTimelineResponse {
        item_kind: query.kind.clone(),
        item_id: query.id.clone(),
        events,
        edges,
    })
}

fn query_edges(
    conn: &Connection,
    card_id: &str,
    kind: &str,
    id: &str,
    limit: usize,
) -> Result<Vec<MemoryEdgeItem>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT e.id,e.from_kind,e.from_id,
                    COALESCE(CASE e.from_kind
                        WHEN 'topic' THEN (SELECT t.name FROM memory_topics t WHERE t.id=e.from_id AND t.user_id=e.user_id)
                        WHEN 'entity' THEN (SELECT n.canonical_name FROM memory_entities n WHERE n.id=e.from_id AND n.user_id=e.user_id)
                        ELSE e.from_id END,e.from_id) AS from_label,
                    e.to_kind,e.to_id,
                    COALESCE(CASE e.to_kind
                        WHEN 'topic' THEN (SELECT t.name FROM memory_topics t WHERE t.id=e.to_id AND t.user_id=e.user_id)
                        WHEN 'entity' THEN (SELECT n.canonical_name FROM memory_entities n WHERE n.id=e.to_id AND n.user_id=e.user_id)
                        ELSE e.to_id END,e.to_id) AS to_label,
                    e.relation,e.source_event_id,e.confidence,e.derived
             FROM memory_edges e JOIN memory_users u ON u.id=e.user_id
             WHERE u.card_id=?1 AND ((e.from_kind=?2 AND e.from_id=?3)
                OR (e.to_kind=?2 AND e.to_id=?3))
             ORDER BY e.created_at DESC LIMIT ?4",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(
            params![card_id, kind, id, limit.clamp(1, 100) as i64],
            |row| {
                Ok(MemoryEdgeItem {
                    id: row.get(0)?,
                    from_kind: row.get(1)?,
                    from_id: row.get(2)?,
                    from_label: row.get(3)?,
                    to_kind: row.get(4)?,
                    to_id: row.get(5)?,
                    to_label: row.get(6)?,
                    relation: row.get(7)?,
                    source_event_id: row.get(8)?,
                    confidence: row.get(9)?,
                    derived: row.get::<_, i64>(10)? != 0,
                })
            },
        )
        .map_err(|e| e.to_string())?;
    rows.map(|row| row.map_err(|e| e.to_string())).collect()
}

#[tauri::command]
pub fn memory_edges(
    state: State<'_, MemoryState>,
    query: MemoryEdgesQuery,
) -> Result<Vec<MemoryEdgeItem>, String> {
    let guard = state.conn.lock().unwrap();
    let conn = guard
        .as_ref()
        .ok_or_else(|| "记忆数据库不可用".to_string())?;
    if !matches!(
        query.kind.as_str(),
        "fact" | "episode" | "commitment" | "entity" | "topic"
    ) {
        return Err("不支持的图节点类型".into());
    }
    query_edges(
        conn,
        &query.card_id,
        &query.kind,
        &query.id,
        query.limit.unwrap_or(50),
    )
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct GraphNodeKey {
    kind: String,
    id: String,
}

fn graph_relation_explanation(relation: &str) -> &'static str {
    match relation {
        "about" => "该记忆关于这个主题",
        "mentions" => "该经历提到了这个实体",
        "derived_from" => "该节点由此事件归纳而来",
        "supersedes" => "该事实替代了旧事实",
        _ => "该关系来自记忆来源事件",
    }
}

fn graph_event_ids(
    conn: &Connection,
    user_id: &str,
    kind: &str,
    id: &str,
) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM memory_events
         WHERE user_id=?1 AND item_kind=?2 AND item_id=?3
         ORDER BY created_at DESC LIMIT 8",
    )?;
    let ids = stmt
        .query_map(params![user_id, kind, id], |row| row.get(0))?
        .filter_map(Result::ok)
        .collect();
    Ok(ids)
}

fn graph_revision(conn: &Connection, kind: &str, id: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COALESCE(MAX(revision_number),0)+1 FROM memory_revisions
         WHERE kind=?1 AND item_id=?2",
        params![kind, id],
        |row| row.get(0),
    )
}

fn graph_user_filter(
    conn: &Connection,
    query: &MemoryGraphQuery,
) -> Result<Vec<(String, String)>, String> {
    if !query.scope.is_empty() && !matches!(query.scope.as_str(), "card" | "user") {
        return Err("不支持的记忆图范围".into());
    }
    if !query.nickname.trim().is_empty() {
        let user = find_user(conn, &query.card_id, &query.nickname).map_err(|e| e.to_string())?;
        return Ok(user
            .map(|id| vec![(id, query.nickname.trim().to_string())])
            .unwrap_or_default());
    }
    let mut stmt = conn
        .prepare("SELECT id,display_name FROM memory_users WHERE card_id=?1 ORDER BY created_at")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([&query.card_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

fn graph_node_matches(node: &MemoryGraphNode, query: &MemoryGraphQuery, now: i64) -> bool {
    if !query.kind.trim().is_empty() && query.kind != node.kind {
        return false;
    }
    if !query.status.trim().is_empty() && query.status != node.status {
        return false;
    }
    if let Some(min) = query.min_confidence {
        if node.confidence < min.clamp(0.0, 1.0) {
            return false;
        }
    }
    if let Some(since) = query.since {
        if node.occurred_at.unwrap_or(now) < since {
            return false;
        }
    }
    if let Some(until) = query.until {
        if node.occurred_at.unwrap_or(now) > until {
            return false;
        }
    }
    let needle = query.search.trim().to_lowercase();
    needle.is_empty()
        || node.label.to_lowercase().contains(&needle)
        || node.text.to_lowercase().contains(&needle)
}

fn graph_node_is_live(
    kind: &str,
    status: &str,
    valid_to: Option<i64>,
    due_at: Option<i64>,
    now: i64,
) -> bool {
    match kind {
        "fact" => matches!(status, "active" | "disputed") && valid_to.is_none_or(|at| at > now),
        "commitment" => status == "pending" && due_at.is_none_or(|at| at >= now),
        "episode" | "user" | "topic" | "entity" => true,
        _ => false,
    }
}

fn graph(conn: &Connection, query: &MemoryGraphQuery) -> Result<MemoryGraphResponse, String> {
    let depth = query.depth.unwrap_or(1).clamp(1, 2);
    let max_nodes = query.max_nodes.unwrap_or(200).clamp(1, 200);
    let users = graph_user_filter(conn, query)?;
    if users.is_empty() {
        return Ok(MemoryGraphResponse {
            nodes: vec![],
            edges: vec![],
            truncated: false,
            depth,
            max_nodes,
            total_candidates: 0,
        });
    }
    let user_ids: HashSet<String> = users.iter().map(|(id, _)| id.clone()).collect();
    let now = now_ts();
    let mut nodes = HashMap::<GraphNodeKey, MemoryGraphNode>::new();
    let mut add_node = |node: MemoryGraphNode| {
        nodes.insert(
            GraphNodeKey {
                kind: node.kind.clone(),
                id: node.id.clone(),
            },
            node,
        );
    };
    for (id, name) in &users {
        add_node(MemoryGraphNode {
            id: id.clone(),
            kind: "user".into(),
            label: name.clone(),
            text: name.clone(),
            status: "active".into(),
            confidence: 1.0,
            importance: 0.5,
            pinned: false,
            occurred_at: None,
            user_id: id.clone(),
            source_event_ids: vec![],
            revision: None,
        });
    }
    let user_ids_vec: Vec<String> = user_ids.iter().cloned().collect();
    for user_id in &user_ids_vec {
        let mut stmt = conn
            .prepare(
                "SELECT id,summary,importance,occurred_at,pinned,updated_at,source_excerpt
             FROM memory_episodes WHERE user_id=?1 ORDER BY pinned DESC,updated_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([user_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, f64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, Option<String>>(6)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows.filter_map(Result::ok) {
            let (id, summary, importance, occurred_at, pinned, updated_at, source_excerpt) = row;
            let _ = updated_at;
            let mut node = MemoryGraphNode {
                id: id.clone(),
                kind: "episode".into(),
                label: summary.clone(),
                text: source_excerpt.unwrap_or(summary.clone()),
                status: "active".into(),
                confidence: 1.0,
                importance,
                pinned: pinned != 0,
                occurred_at: Some(occurred_at),
                user_id: user_id.clone(),
                source_event_ids: graph_event_ids(conn, user_id, "episode", &id)
                    .map_err(|e| e.to_string())?,
                revision: Some(graph_revision(conn, "episode", &id).map_err(|e| e.to_string())?),
            };
            if node.text.is_empty() {
                node.text = node.label.clone();
            }
            if graph_node_is_live("episode", &node.status, None, None, now) {
                add_node(node);
            }
        }
        let mut stmt = conn
            .prepare(
                "SELECT id,text,status,confidence,importance,pinned,valid_from,valid_to,updated_at
             FROM memory_facts WHERE user_id=?1 ORDER BY pinned DESC,updated_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([user_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, f64>(3)?,
                    r.get::<_, f64>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, Option<i64>>(6)?,
                    r.get::<_, Option<i64>>(7)?,
                    r.get::<_, i64>(8)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows.filter_map(Result::ok) {
            let (id, text, status, confidence, importance, pinned, valid_from, valid_to, _) = row;
            if !graph_node_is_live("fact", &status, valid_to, None, now) {
                continue;
            }
            add_node(MemoryGraphNode {
                id: id.clone(),
                kind: "fact".into(),
                label: text.clone(),
                text,
                status,
                confidence,
                importance,
                pinned: pinned != 0,
                occurred_at: valid_from,
                user_id: user_id.clone(),
                source_event_ids: graph_event_ids(conn, user_id, "fact", &id)
                    .map_err(|e| e.to_string())?,
                revision: Some(graph_revision(conn, "fact", &id).map_err(|e| e.to_string())?),
            });
        }
        let mut stmt = conn
            .prepare(
                "SELECT id,text,status,importance,pinned,due_at,updated_at
             FROM memory_commitments WHERE user_id=?1 ORDER BY pinned DESC,updated_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([user_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, f64>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, Option<i64>>(5)?,
                    r.get::<_, i64>(6)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows.filter_map(Result::ok) {
            let (id, text, status, importance, pinned, due_at, _) = row;
            if !graph_node_is_live("commitment", &status, None, due_at, now) {
                continue;
            }
            add_node(MemoryGraphNode {
                id: id.clone(),
                kind: "commitment".into(),
                label: text.clone(),
                text,
                status,
                confidence: 1.0,
                importance,
                pinned: pinned != 0,
                occurred_at: due_at,
                user_id: user_id.clone(),
                source_event_ids: graph_event_ids(conn, user_id, "commitment", &id)
                    .map_err(|e| e.to_string())?,
                revision: Some(graph_revision(conn, "commitment", &id).map_err(|e| e.to_string())?),
            });
        }
        for (table, kind, label_column) in [
            ("memory_topics", "topic", "name"),
            ("memory_entities", "entity", "canonical_name"),
        ] {
            let mut stmt = conn.prepare(&format!("SELECT id,{label_column},updated_at FROM {table} WHERE user_id=?1 ORDER BY updated_at DESC")).map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([user_id], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            for row in rows.filter_map(Result::ok) {
                let (id, label, updated_at) = row;
                add_node(MemoryGraphNode {
                    id,
                    kind: kind.into(),
                    label: label.clone(),
                    text: label,
                    status: "active".into(),
                    confidence: 1.0,
                    importance: 0.3,
                    pinned: false,
                    occurred_at: Some(updated_at),
                    user_id: user_id.clone(),
                    source_event_ids: vec![],
                    revision: None,
                });
            }
        }
    }
    let all_edges = query_graph_edges(conn, &query.card_id, &user_ids)?;
    let roots: HashSet<GraphNodeKey> = nodes
        .values()
        .filter(|n| graph_node_matches(n, query, now))
        .map(|n| GraphNodeKey {
            kind: n.kind.clone(),
            id: n.id.clone(),
        })
        .collect();
    let mut selected = roots.clone();
    let mut frontier = roots;
    for _ in 0..depth {
        let mut next = HashSet::new();
        for edge in &all_edges {
            let from = GraphNodeKey {
                kind: edge.from_kind.clone(),
                id: edge.from_id.clone(),
            };
            let to = GraphNodeKey {
                kind: edge.to_kind.clone(),
                id: edge.to_id.clone(),
            };
            if frontier.contains(&from) && nodes.contains_key(&to) {
                next.insert(to.clone());
            }
            if frontier.contains(&to) && nodes.contains_key(&from) {
                next.insert(from);
            }
        }
        next.retain(|key| !selected.contains(key));
        selected.extend(next.iter().cloned());
        frontier = next;
        if frontier.is_empty() {
            break;
        }
    }
    let total_candidates = selected.len();
    let mut ordered: Vec<MemoryGraphNode> = selected
        .into_iter()
        .filter_map(|key| nodes.remove(&key))
        .collect();
    ordered.sort_by(|a, b| {
        b.pinned
            .cmp(&a.pinned)
            .then(b.importance.total_cmp(&a.importance))
            .then(b.occurred_at.cmp(&a.occurred_at))
    });
    let truncated = ordered.len() > max_nodes;
    ordered.truncate(max_nodes);
    let allowed: HashSet<GraphNodeKey> = ordered
        .iter()
        .map(|n| GraphNodeKey {
            kind: n.kind.clone(),
            id: n.id.clone(),
        })
        .collect();
    let edges = all_edges
        .into_iter()
        .filter(|e| {
            allowed.contains(&GraphNodeKey {
                kind: e.from_kind.clone(),
                id: e.from_id.clone(),
            }) && allowed.contains(&GraphNodeKey {
                kind: e.to_kind.clone(),
                id: e.to_id.clone(),
            })
        })
        .collect();
    Ok(MemoryGraphResponse {
        nodes: ordered,
        edges,
        truncated,
        depth,
        max_nodes,
        total_candidates,
    })
}

fn query_graph_edges(
    conn: &Connection,
    card_id: &str,
    user_ids: &HashSet<String>,
) -> Result<Vec<MemoryGraphEdge>, String> {
    let mut stmt = conn.prepare("SELECT e.id,e.user_id,e.from_kind,e.from_id,e.to_kind,e.to_id,e.relation,e.source_event_id,e.confidence,e.derived FROM memory_edges e JOIN memory_users u ON u.id=e.user_id WHERE u.card_id=?1 ORDER BY e.created_at DESC").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([card_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, Option<String>>(7)?,
                r.get::<_, f64>(8)?,
                r.get::<_, i64>(9)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    Ok(rows
        .filter_map(Result::ok)
        .filter(|(_, user_id, ..)| user_ids.contains(user_id))
        .map(
            |(
                id,
                _,
                from_kind,
                from_id,
                to_kind,
                to_id,
                relation,
                source_event_id,
                confidence,
                derived,
            )| MemoryGraphEdge {
                id,
                from_kind,
                from_id,
                to_kind,
                to_id,
                explanation: graph_relation_explanation(&relation).into(),
                relation,
                source_event_id,
                confidence,
                derived: derived != 0,
            },
        )
        .collect())
}

#[tauri::command]
pub fn memory_graph(
    state: State<'_, MemoryState>,
    query: MemoryGraphQuery,
) -> Result<MemoryGraphResponse, String> {
    let guard = state.conn.lock().unwrap();
    let conn = guard
        .as_ref()
        .ok_or_else(|| "记忆数据库不可用".to_string())?;
    graph(conn, &query)
}

fn timeline_summary(event_type: &str, payload: &str) -> String {
    let value: Value = serde_json::from_str(payload).unwrap_or(Value::Null);
    let text = value
        .get("text")
        .or_else(|| value.get("summary"))
        .or_else(|| {
            value
                .get("snapshot")
                .and_then(|snapshot| snapshot.get("text"))
        })
        .or_else(|| {
            value
                .get("snapshot")
                .and_then(|snapshot| snapshot.get("summary"))
        })
        .and_then(Value::as_str)
        .unwrap_or("");
    let label = match event_type {
        value if value.ends_with(".backfilled") => "从已有记忆建立事件",
        value if value.ends_with(".created") => "创建记忆",
        value if value.ends_with(".confirmed") => "再次确认",
        value if value.ends_with(".corrected") => "用户纠正",
        value if value.ends_with(".disputed") => "标记为待确认",
        value if value.ends_with(".superseded") => "被新事实替代",
        value if value.ends_with(".edited") => "用户编辑",
        value if value.ends_with(".status_changed") => "状态变化",
        value if value.ends_with(".pinned") => "置顶状态变化",
        _ => "记忆事件",
    };
    if text.is_empty() {
        label.to_string()
    } else {
        format!("{label}：{}", truncate_chars(text, 240))
    }
}

#[tauri::command]
pub fn memory_enqueue_session(
    app: AppHandle,
    state: State<'_, MemoryState>,
    request: MemoryEnqueueRequest,
) -> Result<MemoryEnqueueResponse, String> {
    let response = {
        let mut guard = state.conn.lock().unwrap();
        let conn = guard
            .as_mut()
            .ok_or_else(|| "记忆数据库不可用".to_string())?;
        enqueue_session(conn, request)?
    };
    trigger_worker(&app);
    Ok(response)
}

fn enqueue_session(
    conn: &mut Connection,
    request: MemoryEnqueueRequest,
) -> Result<MemoryEnqueueResponse, String> {
    if request.nickname.trim().is_empty() || request.messages.is_empty() {
        return Ok(MemoryEnqueueResponse {
            accepted: false,
            duplicate: false,
            job_id: String::new(),
        });
    }
    let messages: Vec<_> = request
        .messages
        .into_iter()
        .filter(|m| {
            !m.do_not_remember
                && !m.content.trim().is_empty()
                && !is_sensitive(&m.content)
                && !is_sensitive(&m.image_caption)
        })
        .map(|mut m| {
            m.content = truncate_chars(&m.content, 5800);
            m.image_caption = truncate_chars(&m.image_caption, 200);
            m
        })
        .take(200)
        .collect();
    if messages.is_empty() {
        return Ok(MemoryEnqueueResponse {
            accepted: false,
            duplicate: false,
            job_id: String::new(),
        });
    }
    if request.batch_end <= request.batch_start
        || (request.batch_end - request.batch_start) < messages.len() as i64
    {
        return Err("记忆批次边界无效".into());
    }
    let now = now_ts();
    let user_id =
        get_or_create_user(conn, &request.card_id, &request.nickname).map_err(|e| e.to_string())?;
    let chunks = chunk_memory_messages(messages);
    let boundaries = chunk_boundaries(request.batch_start, request.batch_end, &chunks);
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut first_job_id = String::new();
    let mut changed_total = 0usize;
    for (chunk, (start, end)) in chunks.into_iter().zip(boundaries) {
        let job_id = Uuid::new_v4().to_string();
        if first_job_id.is_empty() {
            first_job_id = job_id.clone();
        }
        let payload = serde_json::to_string(&chunk).map_err(|e| e.to_string())?;
        changed_total += tx
            .execute(
                "INSERT OR IGNORE INTO memory_jobs(
                id,user_id,card_id,session_id,batch_start,batch_end,payload_json,
                status,attempts,next_attempt_at,created_at,updated_at
             ) VALUES(?1,?2,?3,?4,?5,?6,?7,'pending',0,?8,?8,?8)",
                params![
                    job_id,
                    user_id,
                    request.card_id,
                    request.session_id,
                    start,
                    end,
                    payload,
                    now
                ],
            )
            .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(MemoryEnqueueResponse {
        accepted: true,
        duplicate: changed_total == 0,
        job_id: first_job_id,
    })
}

fn chunk_memory_messages(messages: Vec<MemoryMessage>) -> Vec<Vec<MemoryMessage>> {
    let mut chunks: Vec<Vec<MemoryMessage>> = Vec::new();
    let mut current = Vec::new();
    let mut current_chars = 0usize;
    for message in messages {
        let len = message.content.chars().count() + message.image_caption.chars().count();
        if !current.is_empty() && (current.len() >= 20 || current_chars + len > 6000) {
            chunks.push(std::mem::take(&mut current));
            current_chars = 0;
        }
        current_chars += len;
        current.push(message);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

fn chunk_boundaries(
    batch_start: i64,
    batch_end: i64,
    chunks: &[Vec<MemoryMessage>],
) -> Vec<(i64, i64)> {
    let mut start = batch_start;
    chunks
        .iter()
        .enumerate()
        .map(|(index, chunk)| {
            let end = if index + 1 == chunks.len() {
                batch_end
            } else {
                start + chunk.len() as i64
            };
            let boundary = (start, end);
            start = end;
            boundary
        })
        .collect()
}

#[derive(Debug, Clone)]
struct Candidate {
    id: String,
    kind: String,
    text: String,
    tags: String,
    status: String,
    confidence: f64,
    importance: f64,
    pinned: bool,
    occurred_at: Option<i64>,
    updated_at: i64,
    predicate: Option<String>,
    value: Option<String>,
}

#[tauri::command]
pub fn memory_recall(
    state: State<'_, MemoryState>,
    request: MemoryRecallRequest,
) -> Result<MemoryRecallResponse, String> {
    let mut guard = state.conn.lock().unwrap();
    let conn = guard
        .as_mut()
        .ok_or_else(|| "记忆数据库不可用".to_string())?;
    recall_memory(conn, &request)
}

fn recall_memory(
    conn: &mut Connection,
    request: &MemoryRecallRequest,
) -> Result<MemoryRecallResponse, String> {
    let started = Instant::now();
    let query = format!("{} {}", request.query, request.image_caption)
        .trim()
        .to_string();
    let proactive_topic = request.reason.trim().eq_ignore_ascii_case("proactive-topic");
    if request.nickname.trim().is_empty() {
        return Ok(MemoryRecallResponse {
            items: vec![],
            total_chars: 0,
            elapsed_ms: started.elapsed().as_millis(),
        });
    }
    let Some(user_id) =
        find_user(conn, &request.card_id, &request.nickname).map_err(|e| e.to_string())?
    else {
        return Ok(MemoryRecallResponse {
            items: vec![],
            total_chars: 0,
            elapsed_ms: started.elapsed().as_millis(),
        });
    };
    let mut candidates = load_recent_candidates(conn, &user_id).map_err(|e| e.to_string())?;
    let has_query = !query.is_empty();
    if has_query {
        for candidate in search_candidates(conn, &request.card_id, &user_id, &query)
            .map_err(|e| e.to_string())?
        {
            if !candidates
                .iter()
                .any(|c| c.kind == candidate.kind && c.id == candidate.id)
            {
                candidates.push(candidate);
            }
        }
    }

    let qgrams = grams(&query);
    let now = now_ts();
    // “明天有点紧张”这类承接句没有显式实体。只允许最近一条高重要度经历
    // 作为上下文桥梁，避免所有近期高重要度事实或待办在无关话题中被强行注入。
    let contextual_fallback = if is_contextual_followup_query(&query) {
        candidates
            .iter()
            .filter(|candidate| {
                let occurred_at = candidate.occurred_at.unwrap_or(candidate.updated_at);
                let age = now - occurred_at;
                candidate.kind == "episode"
                    && candidate.importance >= 0.8
                    && (0..=7 * 86_400).contains(&age)
            })
            .max_by_key(|candidate| candidate.occurred_at.unwrap_or(candidate.updated_at))
            .map(|candidate| candidate.id.clone())
    } else {
        None
    };
    let mut scored: Vec<(Candidate, f64)> = candidates
        .into_iter()
        .filter_map(|c| {
            if c.status == "superseded" || c.status == "forgotten" || c.status == "expired" {
                return None;
            }
            if is_sensitive(&c.text) {
                return None;
            }
            let lexical = if has_query {
                jaccard(&qgrams, &grams(&format!("{} {}", c.text, c.tags)))
            } else {
                0.0
            };
            let age_days = (now - c.occurred_at.unwrap_or(c.updated_at)).max(0) as f64 / 86_400.0;
            let proactive_episode = proactive_topic
                && !has_query
                && c.kind == "episode"
                && age_days <= 30.0;
            let half_life = if c.kind == "episode" { 30.0 } else { 180.0 };
            let recency = 0.5_f64.powf(age_days / half_life);
            let special = if c.pinned || c.kind == "commitment" {
                1.0
            } else {
                0.0
            };
            let score = 0.60 * lexical
                + 0.12 * recency
                + 0.12 * clamp01(c.importance)
                + 0.08 * clamp01(c.confidence)
                + 0.08 * special;
            let is_contextual_fallback = contextual_fallback.as_deref() == Some(c.id.as_str());
            // 无当前话题时，通话启动仍可预加载置顶记忆和未完成约定；
            // 普通动态事实/经历必须等到有查询词才参与，避免开场注入噪声。
            if lexical < 0.02
                && !c.pinned
                && !(c.kind == "commitment" && !has_query)
                && !proactive_episode
                && !is_contextual_fallback
            {
                return None;
            }
            if c.status == "disputed" && lexical < 0.18 {
                return None;
            }
            (score >= 0.18).then_some((c, score))
        })
        .collect();
    scored.sort_by(|a, b| b.1.total_cmp(&a.1));

    let requested_limit = request
        .max_items
        .unwrap_or(MAX_RECALL_ITEMS)
        .clamp(1, MAX_RECALL_ITEMS);
    let limit = if proactive_topic && !has_query {
        requested_limit.min(PROACTIVE_RECALL_MAX_ITEMS)
    } else {
        requested_limit
    };
    let char_budget = if proactive_topic && !has_query {
        PROACTIVE_RECALL_CHAR_BUDGET
    } else {
        RECALL_CHAR_BUDGET
    };
    let mut selected = Vec::new();
    let mut chars = 0usize;
    let mut pinned_count = 0usize;
    let mut dynamic_count = 0usize;
    for (candidate, score) in scored {
        if candidate.pinned && pinned_count >= 2 {
            continue;
        }
        if !candidate.pinned && dynamic_count >= 4 {
            continue;
        }
        if selected
            .iter()
            .any(|i: &MemoryRecallItem| jaccard(&grams(&i.text), &grams(&candidate.text)) >= 0.78)
        {
            continue;
        }
        let len = candidate.text.chars().count();
        if chars + len > char_budget || selected.len() >= limit {
            continue;
        }
        if candidate.pinned {
            pinned_count += 1;
        } else {
            dynamic_count += 1;
        }
        chars += len;
        selected.push(MemoryRecallItem {
            id: candidate.id,
            kind: candidate.kind,
            text: candidate.text,
            occurred_at: candidate.occurred_at,
            confidence: candidate.confidence,
            score,
            uncertain: candidate.status == "disputed" || candidate.confidence < 0.65,
            pinned: candidate.pinned,
            conflict_key: candidate.predicate.clone(),
            predicate: candidate.predicate,
            value: candidate.value,
        });
    }
    let recalled_at = now_ts();
    for item in &selected {
        if item.kind == "fact" {
            let _ = conn.execute(
                "UPDATE memory_facts SET last_recalled_at=?1 WHERE id=?2",
                params![recalled_at, item.id],
            );
        }
    }
    Ok(MemoryRecallResponse {
        items: selected,
        total_chars: chars,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

fn is_contextual_followup_query(query: &str) -> bool {
    const CUES: &[&str] = &[
        "这件事",
        "那个",
        "紧张",
        "担心",
        "焦虑",
        "害怕",
        "难过",
        "开心",
        "期待",
        "压力",
        "睡不着",
        "怎么办",
        "快到了",
        "要开始了",
    ];
    CUES.iter().any(|cue| query.contains(cue))
}

fn load_recent_candidates(conn: &Connection, user_id: &str) -> rusqlite::Result<Vec<Candidate>> {
    let mut out = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT id,text,predicate,value,predicate||' '||value,status,confidence,importance,pinned,
                    valid_from,updated_at
             FROM memory_facts
             WHERE user_id=?1 AND status IN ('active','disputed')
               AND (valid_to IS NULL OR valid_to >= ?2)
             ORDER BY pinned DESC, updated_at DESC LIMIT 50",
        )?;
        let rows = stmt.query_map(params![user_id, now_ts()], |r| {
            Ok(Candidate {
                id: r.get(0)?,
                kind: "fact".into(),
                text: r.get(1)?,
                predicate: r.get(2)?,
                value: r.get(3)?,
                tags: r.get(4)?,
                status: r.get(5)?,
                confidence: r.get(6)?,
                importance: r.get(7)?,
                pinned: r.get::<_, i64>(8)? != 0,
                occurred_at: r.get(9)?,
                updated_at: r.get(10)?,
            })
        })?;
        out.extend(rows.filter_map(Result::ok));
    }
    {
        let mut stmt = conn.prepare(
            "SELECT id,summary,topics_json||' '||entities_json,'active',1.0,importance,pinned,
                    occurred_at,updated_at
             FROM memory_episodes WHERE user_id=?1
             ORDER BY pinned DESC, occurred_at DESC LIMIT 30",
        )?;
        let rows = stmt.query_map([user_id], |r| {
            Ok(Candidate {
                id: r.get(0)?,
                kind: "episode".into(),
                text: r.get(1)?,
                tags: r.get(2)?,
                status: r.get(3)?,
                confidence: r.get(4)?,
                importance: r.get(5)?,
                pinned: r.get::<_, i64>(6)? != 0,
                occurred_at: r.get(7)?,
                updated_at: r.get(8)?,
                predicate: None,
                value: None,
            })
        })?;
        out.extend(rows.filter_map(Result::ok));
    }
    {
        let mut stmt = conn.prepare(
            "SELECT id,text,'约定 承诺',status,1.0,importance,pinned,due_at,updated_at
             FROM memory_commitments WHERE user_id=?1 AND status='pending'
             ORDER BY pinned DESC, COALESCE(due_at,updated_at) ASC LIMIT 20",
        )?;
        let rows = stmt.query_map([user_id], |r| {
            Ok(Candidate {
                id: r.get(0)?,
                kind: "commitment".into(),
                text: r.get(1)?,
                tags: r.get(2)?,
                status: r.get(3)?,
                confidence: r.get(4)?,
                importance: r.get(5)?,
                pinned: r.get::<_, i64>(6)? != 0,
                occurred_at: r.get(7)?,
                updated_at: r.get(8)?,
                predicate: None,
                value: None,
            })
        })?;
        out.extend(rows.filter_map(Result::ok));
    }
    Ok(out)
}

fn search_candidates(
    conn: &Connection,
    card_id: &str,
    user_id: &str,
    query: &str,
) -> rusqlite::Result<Vec<Candidate>> {
    let Some(match_query) = fts_query(query) else {
        return Ok(vec![]);
    };
    let mut stmt = conn.prepare(
        "SELECT item_id,kind FROM memory_search
         WHERE memory_search MATCH ?1 AND card_id=?2 AND user_id=?3
         ORDER BY bm25(memory_search) LIMIT 50",
    )?;
    let ids: Vec<(String, String)> = stmt
        .query_map(params![match_query, card_id, user_id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?
        .filter_map(Result::ok)
        .collect();
    let recent = load_recent_candidates(conn, user_id)?;
    let mut map: HashMap<(String, String), Candidate> = recent
        .into_iter()
        .map(|c| ((c.kind.clone(), c.id.clone()), c))
        .collect();
    let mut out = Vec::new();
    for (id, kind) in ids {
        if let Some(candidate) = map.remove(&(kind.clone(), id.clone())) {
            out.push(candidate);
        } else if let Some(candidate) = load_candidate_by_id(conn, &kind, &id)? {
            out.push(candidate);
        }
    }
    Ok(out)
}

fn load_candidate_by_id(
    conn: &Connection,
    kind: &str,
    id: &str,
) -> rusqlite::Result<Option<Candidate>> {
    match kind {
        "fact" => conn.query_row(
            "SELECT id,text,predicate,value,predicate||' '||value,status,confidence,importance,pinned,valid_from,updated_at
             FROM memory_facts WHERE id=?1 AND status IN ('active','disputed') AND (valid_to IS NULL OR valid_to>=?2)",
            params![id,now_ts()], |r| Ok(Candidate { id:r.get(0)?,kind:"fact".into(),text:r.get(1)?,predicate:r.get(2)?,value:r.get(3)?,tags:r.get(4)?,status:r.get(5)?,confidence:r.get(6)?,importance:r.get(7)?,pinned:r.get::<_,i64>(8)?!=0,occurred_at:r.get(9)?,updated_at:r.get(10)?, })
        ).optional(),
        "episode" => conn.query_row(
            "SELECT id,summary,topics_json||' '||entities_json,'active',1.0,importance,pinned,occurred_at,updated_at FROM memory_episodes WHERE id=?1",
            [id], |r| Ok(Candidate { id:r.get(0)?,kind:"episode".into(),text:r.get(1)?,tags:r.get(2)?,status:r.get(3)?,confidence:r.get(4)?,importance:r.get(5)?,pinned:r.get::<_,i64>(6)?!=0,occurred_at:r.get(7)?,updated_at:r.get(8)?,predicate:None,value:None })
        ).optional(),
        "commitment" => conn.query_row(
            "SELECT id,text,'约定 承诺',status,1.0,importance,pinned,due_at,updated_at FROM memory_commitments WHERE id=?1 AND status='pending'",
            [id], |r| Ok(Candidate { id:r.get(0)?,kind:"commitment".into(),text:r.get(1)?,tags:r.get(2)?,status:r.get(3)?,confidence:r.get(4)?,importance:r.get(5)?,pinned:r.get::<_,i64>(6)?!=0,occurred_at:r.get(7)?,updated_at:r.get(8)?,predicate:None,value:None })
        ).optional(),
        _ => Ok(None),
    }
}

fn fts_query(text: &str) -> Option<String> {
    let clean: String = text
        .chars()
        .filter(|c| c.is_alphanumeric() || ('\u{4e00}'..='\u{9fff}').contains(c))
        .take(120)
        .collect();
    let chars: Vec<char> = clean.chars().collect();
    if chars.len() < 3 {
        return None;
    }
    let mut terms = Vec::new();
    for window in chars.windows(3).take(24) {
        terms.push(format!("\"{}\"", window.iter().collect::<String>()));
    }
    Some(terms.join(" OR "))
}

fn grams(text: &str) -> HashSet<String> {
    let chars: Vec<char> = text
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || ('\u{4e00}'..='\u{9fff}').contains(c))
        .collect();
    let width = if chars.len() >= 3 { 2 } else { 1 };
    chars.windows(width).map(|w| w.iter().collect()).collect()
}

fn jaccard(a: &HashSet<String>, b: &HashSet<String>) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let intersection = a.intersection(b).count() as f64;
    let union = a.union(b).count() as f64;
    if union == 0.0 {
        0.0
    } else {
        intersection / union
    }
}

#[tauri::command]
pub fn memory_list(
    state: State<'_, MemoryState>,
    query: MemoryListQuery,
) -> Result<MemoryListResponse, String> {
    let guard = state.conn.lock().unwrap();
    let conn = guard
        .as_ref()
        .ok_or_else(|| "记忆数据库不可用".to_string())?;
    let mut items = Vec::new();
    let user_filter = if query.nickname.trim().is_empty() {
        None
    } else {
        let found = find_user(conn, &query.card_id, &query.nickname).map_err(|e| e.to_string())?;
        if found.is_none() {
            return Ok(MemoryListResponse {
                items: vec![],
                total: 0,
                page: 1,
                page_size: query.page_size.unwrap_or(30).clamp(1, 100),
                counts: MemoryTypeCounts::default(),
            });
        }
        found
    };
    let mut users = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT id,display_name FROM memory_users WHERE card_id=?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&query.card_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        users.extend(rows.filter_map(Result::ok));
    }
    {
        let mut stmt = conn
            .prepare(
                "SELECT f.id,f.user_id,f.text,f.status,f.confidence,f.importance,f.pinned,
                    f.valid_from,f.updated_at,e.source_excerpt
             FROM memory_facts f LEFT JOIN memory_episodes e ON e.id=f.source_episode_id
             JOIN memory_users u ON u.id=f.user_id WHERE u.card_id=?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&query.card_id], |r| {
                Ok((
                    r.get::<_, String>(1)?,
                    MemoryListItem {
                        id: r.get(0)?,
                        kind: "fact".into(),
                        nickname: String::new(),
                        text: r.get(2)?,
                        status: r.get(3)?,
                        confidence: r.get(4)?,
                        importance: r.get(5)?,
                        pinned: r.get::<_, i64>(6)? != 0,
                        occurred_at: r.get(7)?,
                        updated_at: r.get(8)?,
                        source_excerpt: r.get(9)?,
                    },
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows.filter_map(Result::ok) {
            if user_filter.as_ref().is_none_or(|id| id == &row.0) {
                let mut item = row.1;
                item.nickname = users.get(&row.0).cloned().unwrap_or_default();
                items.push(item);
            }
        }
    }
    {
        let mut stmt = conn
            .prepare(
                "SELECT e.id,e.user_id,e.summary,'active',1.0,e.importance,e.pinned,
                    e.occurred_at,e.updated_at,e.source_excerpt
             FROM memory_episodes e JOIN memory_users u ON u.id=e.user_id WHERE u.card_id=?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&query.card_id], |r| {
                Ok((
                    r.get::<_, String>(1)?,
                    MemoryListItem {
                        id: r.get(0)?,
                        kind: "episode".into(),
                        nickname: String::new(),
                        text: r.get(2)?,
                        status: r.get(3)?,
                        confidence: r.get(4)?,
                        importance: r.get(5)?,
                        pinned: r.get::<_, i64>(6)? != 0,
                        occurred_at: r.get(7)?,
                        updated_at: r.get(8)?,
                        source_excerpt: r.get(9)?,
                    },
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows.filter_map(Result::ok) {
            if user_filter.as_ref().is_none_or(|id| id == &row.0) {
                let mut item = row.1;
                item.nickname = users.get(&row.0).cloned().unwrap_or_default();
                items.push(item);
            }
        }
    }
    {
        let mut stmt = conn
            .prepare(
                "SELECT c.id,c.user_id,c.text,c.status,1.0,c.importance,c.pinned,
                    c.due_at,c.updated_at,e.source_excerpt
             FROM memory_commitments c
             LEFT JOIN memory_episodes e ON e.id=c.source_episode_id
             JOIN memory_users u ON u.id=c.user_id WHERE u.card_id=?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&query.card_id], |r| {
                Ok((
                    r.get::<_, String>(1)?,
                    MemoryListItem {
                        id: r.get(0)?,
                        kind: "commitment".into(),
                        nickname: String::new(),
                        text: r.get(2)?,
                        status: r.get(3)?,
                        confidence: r.get(4)?,
                        importance: r.get(5)?,
                        pinned: r.get::<_, i64>(6)? != 0,
                        occurred_at: r.get(7)?,
                        updated_at: r.get(8)?,
                        source_excerpt: r.get(9)?,
                    },
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows.filter_map(Result::ok) {
            if user_filter.as_ref().is_none_or(|id| id == &row.0) {
                let mut item = row.1;
                item.nickname = users.get(&row.0).cloned().unwrap_or_default();
                items.push(item);
            }
        }
    }
    let counts = MemoryTypeCounts {
        facts: items.iter().filter(|i| i.kind == "fact").count(),
        episodes: items.iter().filter(|i| i.kind == "episode").count(),
        commitments: items.iter().filter(|i| i.kind == "commitment").count(),
    };
    let search = query.search.trim().to_lowercase();
    items.retain(|i| {
        (query.kind.is_empty() || i.kind == query.kind)
            && (query.status.is_empty() || i.status == query.status)
            && (search.is_empty()
                || i.text.to_lowercase().contains(&search)
                || i.nickname.to_lowercase().contains(&search))
    });
    items.sort_by(|a, b| {
        b.pinned
            .cmp(&a.pinned)
            .then(b.updated_at.cmp(&a.updated_at))
    });
    let total = items.len();
    let page = query.page.unwrap_or(1).max(1);
    let page_size = query.page_size.unwrap_or(30).clamp(1, 100);
    let start = (page - 1).saturating_mul(page_size).min(total);
    let end = (start + page_size).min(total);
    Ok(MemoryListResponse {
        items: items[start..end].to_vec(),
        total,
        page,
        page_size,
        counts,
    })
}

#[tauri::command]
pub fn memory_update(
    state: State<'_, MemoryState>,
    request: MemoryUpdateRequest,
) -> Result<MemoryMutationResponse, String> {
    let mut guard = state.conn.lock().unwrap();
    let conn = guard
        .as_mut()
        .ok_or_else(|| "记忆数据库不可用".to_string())?;
    update_memory(conn, &request)
}

fn update_memory(
    conn: &mut Connection,
    request: &MemoryUpdateRequest,
) -> Result<MemoryMutationResponse, String> {
    let now = now_ts();
    let table = kind_table(&request.kind)?;
    let text_column = if request.kind == "episode" {
        "summary"
    } else {
        "text"
    };
    let revision_state =
        load_revision_state(conn, &request.kind, &request.id).map_err(|e| e.to_string())?;
    let Some((user_id, current_text, snapshot)) = revision_state else {
        return Err("记忆不存在或已删除".into());
    };
    let edited_text = request.text.as_ref().map(|text| truncate_chars(text, 1000));
    if edited_text.as_ref().is_some_and(String::is_empty) {
        return Err("记忆内容不能为空".into());
    }
    if let Some(status) = request.status.as_ref() {
        let allowed = match request.kind.as_str() {
            "fact" => matches!(status.as_str(), "active" | "disputed" | "forgotten"),
            "commitment" => matches!(
                status.as_str(),
                "pending" | "fulfilled" | "cancelled" | "expired"
            ),
            "episode" => false,
            _ => false,
        };
        if !allowed {
            return Err("不支持的记忆状态".into());
        }
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    if let Some(text) = edited_text.as_ref() {
        if text.is_empty() {
            return Err("记忆内容不能为空".into());
        }
        if is_sensitive(text) {
            return Err("记忆内容包含敏感信息，未保存".into());
        }
        if text != &current_text {
            record_revision(&tx, &request.kind, &request.id, &user_id, &snapshot, now)
                .map_err(|e| e.to_string())?;
        }
        tx.execute(
            &format!("UPDATE {table} SET {text_column}=?1,user_edited=1,updated_at=?2 WHERE id=?3"),
            params![text, now, request.id],
        )
        .map_err(|e| e.to_string())?;
        if request.kind == "fact" {
            tx.execute(
                "UPDATE memory_facts SET confidence=1.0 WHERE id=?1",
                [&request.id],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    if let Some(pinned) = request.pinned {
        tx.execute(
            &format!("UPDATE {table} SET pinned=?1 WHERE id=?2"),
            params![pinned as i64, request.id],
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(status) = request.status.as_ref() {
        tx.execute(
            &format!("UPDATE {table} SET status=?1,updated_at=?2 WHERE id=?3"),
            params![status, now, request.id],
        )
        .map_err(|e| e.to_string())?;
        if request.kind == "commitment" && status != "pending" {
            tx.execute(
                "UPDATE memory_commitments SET resolved_at=?1 WHERE id=?2",
                params![now, request.id],
            )
            .map_err(|e| e.to_string())?;
        } else if request.kind == "commitment" {
            tx.execute(
                "UPDATE memory_commitments SET resolved_at=NULL WHERE id=?1",
                [&request.id],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    rebuild_search_item(&tx, &request.kind, &request.id).map_err(|e| e.to_string())?;
    let card_id: String = tx
        .query_row(
            "SELECT card_id FROM memory_users WHERE id=?1",
            [&user_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let (_, _, after_snapshot) = load_revision_state(&tx, &request.kind, &request.id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "记忆更新后无法读取当前版本".to_string())?;
    let event_type = if request.text.is_some() {
        format!("{}.edited", request.kind)
    } else if request.status.is_some() {
        format!("{}.status_changed", request.kind)
    } else {
        format!("{}.pinned", request.kind)
    };
    let event_payload = serde_json::json!({
        "snapshot": serde_json::from_str::<Value>(&after_snapshot).unwrap_or(Value::Null),
        "textChanged": request.text.is_some(),
        "status": request.status.clone(),
        "pinned": request.pinned,
    })
    .to_string();
    let event_id = append_event(
        &tx,
        &MemoryEventInput {
            user_id: &user_id,
            card_id: &card_id,
            item_kind: &request.kind,
            item_id: &request.id,
            event_type: &event_type,
            source_type: "user-edit",
            source_id: None,
            modality: "text",
            observed_at: now,
            trust: 1.0,
            consent: "explicit",
            idempotency_key: &format!("user-edit:{}:{}", request.id, Uuid::new_v4()),
            payload_json: &event_payload,
        },
    )
    .map_err(|e| e.to_string())?;
    append_evidence(
        &tx,
        &event_id,
        &request.kind,
        &request.id,
        "user_override",
        &[],
        None,
        now,
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(MemoryMutationResponse {
        ok: true,
        affected: 1,
    })
}

fn load_revision_state(
    conn: &Connection,
    kind: &str,
    id: &str,
) -> rusqlite::Result<Option<(String, String, String)>> {
    match kind {
        "fact" => conn
            .query_row(
                "SELECT user_id,text,predicate,value,confidence,importance,durability,status,
                        valid_from,valid_to,pinned,user_edited,updated_at
                 FROM memory_facts WHERE id=?1",
                [id],
                |r| {
                    let user_id: String = r.get(0)?;
                    let text: String = r.get(1)?;
                    let snapshot = serde_json::json!({
                        "text": text.clone(),
                        "predicate": r.get::<_, String>(2)?,
                        "value": r.get::<_, String>(3)?,
                        "confidence": r.get::<_, f64>(4)?,
                        "importance": r.get::<_, f64>(5)?,
                        "durability": r.get::<_, String>(6)?,
                        "status": r.get::<_, String>(7)?,
                        "validFrom": r.get::<_, Option<i64>>(8)?,
                        "validTo": r.get::<_, Option<i64>>(9)?,
                        "pinned": r.get::<_, i64>(10)? != 0,
                        "userEdited": r.get::<_, i64>(11)? != 0,
                        "updatedAt": r.get::<_, i64>(12)?,
                    })
                    .to_string();
                    Ok((user_id, text, snapshot))
                },
            )
            .optional(),
        "episode" => conn
            .query_row(
                "SELECT user_id,summary,emotion,importance,topics_json,entities_json,
                        occurred_at,pinned,user_edited,updated_at
                 FROM memory_episodes WHERE id=?1",
                [id],
                |r| {
                    let user_id: String = r.get(0)?;
                    let text: String = r.get(1)?;
                    let snapshot = serde_json::json!({
                        "summary": text.clone(),
                        "emotion": r.get::<_, String>(2)?,
                        "importance": r.get::<_, f64>(3)?,
                        "topics": r.get::<_, String>(4)?,
                        "entities": r.get::<_, String>(5)?,
                        "occurredAt": r.get::<_, i64>(6)?,
                        "pinned": r.get::<_, i64>(7)? != 0,
                        "userEdited": r.get::<_, i64>(8)? != 0,
                        "updatedAt": r.get::<_, i64>(9)?,
                    })
                    .to_string();
                    Ok((user_id, text, snapshot))
                },
            )
            .optional(),
        "commitment" => conn
            .query_row(
                "SELECT user_id,text,due_at,status,importance,pinned,user_edited,
                        created_at,updated_at,resolved_at
                 FROM memory_commitments WHERE id=?1",
                [id],
                |r| {
                    let user_id: String = r.get(0)?;
                    let text: String = r.get(1)?;
                    let snapshot = serde_json::json!({
                        "text": text.clone(),
                        "dueAt": r.get::<_, Option<i64>>(2)?,
                        "status": r.get::<_, String>(3)?,
                        "importance": r.get::<_, f64>(4)?,
                        "pinned": r.get::<_, i64>(5)? != 0,
                        "userEdited": r.get::<_, i64>(6)? != 0,
                        "createdAt": r.get::<_, i64>(7)?,
                        "updatedAt": r.get::<_, i64>(8)?,
                        "resolvedAt": r.get::<_, Option<i64>>(9)?,
                    })
                    .to_string();
                    Ok((user_id, text, snapshot))
                },
            )
            .optional(),
        _ => Err(rusqlite::Error::InvalidParameterName(
            "不支持的记忆类型".into(),
        )),
    }
}

fn record_revision(
    conn: &Connection,
    kind: &str,
    item_id: &str,
    user_id: &str,
    snapshot: &str,
    now: i64,
) -> rusqlite::Result<()> {
    let revision_number: i64 = conn.query_row(
        "SELECT COALESCE(MAX(revision_number),0)+1 FROM memory_revisions
         WHERE kind=?1 AND item_id=?2",
        params![kind, item_id],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO memory_revisions(id,item_id,kind,user_id,revision_number,status,snapshot_json,created_at)
         VALUES(?1,?2,?3,?4,?5,'superseded',?6,?7)",
        params![
            Uuid::new_v4().to_string(),
            item_id,
            kind,
            user_id,
            revision_number,
            snapshot,
            now
        ],
    )?;
    Ok(())
}

#[tauri::command]
pub fn memory_delete(
    state: State<'_, MemoryState>,
    request: MemoryDeleteRequest,
) -> Result<MemoryMutationResponse, String> {
    let mut guard = state.conn.lock().unwrap();
    let conn = guard
        .as_mut()
        .ok_or_else(|| "记忆数据库不可用".to_string())?;
    delete_memory(conn, &request)
}

fn delete_memory(
    conn: &mut Connection,
    request: &MemoryDeleteRequest,
) -> Result<MemoryMutationResponse, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut affected = 0;
    for item in request.items.iter().take(200) {
        let table = kind_table(&item.kind)?;
        tx.execute(
            "DELETE FROM memory_edges
             WHERE (from_kind=?1 AND from_id=?2) OR (to_kind=?1 AND to_id=?2)",
            params![item.kind, item.id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM memory_events WHERE item_kind=?1 AND item_id=?2",
            params![item.kind, item.id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM memory_search WHERE item_id=?1 AND kind=?2",
            params![item.id, item.kind],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM memory_revisions WHERE item_id=?1 AND kind=?2",
            params![item.id, item.kind],
        )
        .map_err(|e| e.to_string())?;
        affected += tx
            .execute(&format!("DELETE FROM {table} WHERE id=?1"), [&item.id])
            .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    Ok(MemoryMutationResponse { ok: true, affected })
}

#[tauri::command]
pub fn memory_clear_scope(
    state: State<'_, MemoryState>,
    request: MemoryClearRequest,
) -> Result<MemoryMutationResponse, String> {
    let mut guard = state.conn.lock().unwrap();
    let conn = guard
        .as_mut()
        .ok_or_else(|| "记忆数据库不可用".to_string())?;
    clear_scope(conn, &request)
}

fn clear_scope(
    conn: &mut Connection,
    request: &MemoryClearRequest,
) -> Result<MemoryMutationResponse, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let affected = if request.nickname.trim().is_empty() {
        tx.execute(
            "DELETE FROM memory_search WHERE card_id=?1",
            [&request.card_id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM memory_users WHERE card_id=?1",
            [&request.card_id],
        )
        .map_err(|e| e.to_string())?
    } else if let Some(user_id) =
        find_user(&tx, &request.card_id, &request.nickname).map_err(|e| e.to_string())?
    {
        tx.execute("DELETE FROM memory_search WHERE user_id=?1", [&user_id])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM memory_users WHERE id=?1", [&user_id])
            .map_err(|e| e.to_string())?
    } else {
        0
    };
    tx.commit().map_err(|e| e.to_string())?;
    let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    Ok(MemoryMutationResponse { ok: true, affected })
}

fn kind_table(kind: &str) -> Result<&'static str, String> {
    match kind {
        "fact" => Ok("memory_facts"),
        "episode" => Ok("memory_episodes"),
        "commitment" => Ok("memory_commitments"),
        _ => Err("不支持的记忆类型".into()),
    }
}

#[tauri::command]
pub fn memory_import_legacy(
    state: State<'_, MemoryState>,
    request: MemoryLegacyRequest,
) -> Result<MemoryMutationResponse, String> {
    let mut guard = state.conn.lock().unwrap();
    let conn = guard
        .as_mut()
        .ok_or_else(|| "记忆数据库不可用".to_string())?;
    import_legacy(conn, &request)
}

fn import_legacy(
    conn: &mut Connection,
    request: &MemoryLegacyRequest,
) -> Result<MemoryMutationResponse, String> {
    let marker = format!("legacy_imported:{}", request.card_id);
    let imported: Option<String> = conn
        .query_row(
            "SELECT value FROM memory_meta WHERE key=?1",
            [&marker],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if imported.is_some() {
        return Ok(MemoryMutationResponse {
            ok: true,
            affected: 0,
        });
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut affected = 0usize;
    if let Some(all) = request.memories.as_object() {
        for (fallback_name, raw) in all {
            let nickname = raw
                .get("nickname")
                .and_then(Value::as_str)
                .unwrap_or(fallback_name);
            let user_id =
                get_or_create_user(&tx, &request.card_id, nickname).map_err(|e| e.to_string())?;
            let now = now_ts();
            let topics: Vec<String> = raw
                .get("topics_recent")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(|topic| truncate_chars(topic, 40))
                .filter(|topic| !topic.is_empty() && !is_sensitive(topic))
                .take(12)
                .collect();
            let topics_json = serde_json::to_string(&topics).unwrap_or_else(|_| "[]".into());
            let topic_tags = if topics.is_empty() {
                "legacy".to_string()
            } else {
                format!("legacy {}", topics.join(" "))
            };
            let sessions = raw
                .get("sessions")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let mut imported_sessions = 0usize;
            for session in &sessions {
                let summary = session.get("summary").and_then(Value::as_str).unwrap_or("");
                if summary.trim().is_empty() || is_sensitive(summary) {
                    continue;
                }
                let id = Uuid::new_v4().to_string();
                let occurred_at = parse_legacy_ts(session.get("ts")).unwrap_or(now);
                let session_id = session.get("id").and_then(|value| {
                    value
                        .as_str()
                        .map(str::to_string)
                        .or_else(|| value.as_i64().map(|id| id.to_string()))
                });
                tx.execute(
                    "INSERT INTO memory_episodes(id,user_id,session_id,summary,importance,topics_json,
                     occurred_at,created_at,updated_at) VALUES(?1,?2,?3,?4,0.5,?5,?6,?6,?6)",
                    params![
                        id,
                        user_id,
                        session_id,
                        truncate_chars(summary, 1000),
                        topics_json,
                        occurred_at
                    ],
                )
                .map_err(|e| e.to_string())?;
                let payload = serde_json::json!({
                    "summary": truncate_chars(summary, 1000),
                    "topics": topics.clone(),
                    "occurredAt": occurred_at,
                })
                .to_string();
                let event_id = append_event(
                    &tx,
                    &MemoryEventInput {
                        user_id: &user_id,
                        card_id: &request.card_id,
                        item_kind: "episode",
                        item_id: &id,
                        event_type: "episode.imported",
                        source_type: "legacy-import",
                        source_id: session_id.as_deref(),
                        modality: "text",
                        observed_at: occurred_at,
                        trust: 0.7,
                        consent: "legacy",
                        idempotency_key: &format!("legacy-import:episode:{id}"),
                        payload_json: &payload,
                    },
                )
                .map_err(|e| e.to_string())?;
                append_evidence(
                    &tx,
                    &event_id,
                    "episode",
                    &id,
                    "legacy_record",
                    &[],
                    None,
                    now,
                )
                .map_err(|e| e.to_string())?;
                link_episode_nodes(
                    &tx,
                    &user_id,
                    &request.card_id,
                    &id,
                    &topics,
                    &[],
                    Some(&event_id),
                    0.7,
                )
                .map_err(|e| e.to_string())?;
                index_item(
                    &tx,
                    &id,
                    "episode",
                    &request.card_id,
                    &user_id,
                    summary,
                    &topic_tags,
                )
                .map_err(|e| e.to_string())?;
                affected += 1;
                imported_sessions += 1;
            }
            if imported_sessions == 0 && !topics.is_empty() {
                let id = Uuid::new_v4().to_string();
                let occurred_at = parse_legacy_ts(raw.get("updated_at")).unwrap_or(now);
                let summary =
                    truncate_chars(&format!("旧版记录的近期话题：{}", topics.join("、")), 1000);
                tx.execute(
                    "INSERT INTO memory_episodes(id,user_id,summary,importance,topics_json,
                     occurred_at,created_at,updated_at) VALUES(?1,?2,?3,0.4,?4,?5,?5,?5)",
                    params![id, user_id, summary, topics_json, occurred_at],
                )
                .map_err(|e| e.to_string())?;
                let payload = serde_json::json!({
                    "summary": summary.clone(),
                    "topics": topics.clone(),
                    "occurredAt": occurred_at,
                })
                .to_string();
                let event_id = append_event(
                    &tx,
                    &MemoryEventInput {
                        user_id: &user_id,
                        card_id: &request.card_id,
                        item_kind: "episode",
                        item_id: &id,
                        event_type: "episode.imported",
                        source_type: "legacy-import",
                        source_id: None,
                        modality: "text",
                        observed_at: occurred_at,
                        trust: 0.7,
                        consent: "legacy",
                        idempotency_key: &format!("legacy-import:episode:{id}"),
                        payload_json: &payload,
                    },
                )
                .map_err(|e| e.to_string())?;
                append_evidence(
                    &tx,
                    &event_id,
                    "episode",
                    &id,
                    "legacy_record",
                    &[],
                    None,
                    now,
                )
                .map_err(|e| e.to_string())?;
                link_episode_nodes(
                    &tx,
                    &user_id,
                    &request.card_id,
                    &id,
                    &topics,
                    &[],
                    Some(&event_id),
                    0.7,
                )
                .map_err(|e| e.to_string())?;
                index_item(
                    &tx,
                    &id,
                    "episode",
                    &request.card_id,
                    &user_id,
                    &summary,
                    &topic_tags,
                )
                .map_err(|e| e.to_string())?;
                affected += 1;
            }
            for fact in raw
                .get("facts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let text = fact
                    .as_str()
                    .or_else(|| fact.get("text").and_then(Value::as_str))
                    .unwrap_or("");
                if text.trim().is_empty() || is_sensitive(text) {
                    continue;
                }
                let fact_id = insert_fact(
                    &tx,
                    &request.card_id,
                    &user_id,
                    None,
                    &ExtractedFact {
                        text: text.into(),
                        predicate: text.into(),
                        value: text.into(),
                        durability: "stable".into(),
                        evidence: "assertion".into(),
                        confidence: 0.7,
                        importance: 0.5,
                        valid_from: None,
                    },
                    now,
                )
                .map_err(|e| e.to_string())?;
                if let Some(fact_id) = fact_id {
                    let payload =
                        serde_json::json!({ "text": truncate_chars(text, 600), "confidence": 0.7 })
                            .to_string();
                    let event_id = append_event(
                        &tx,
                        &MemoryEventInput {
                            user_id: &user_id,
                            card_id: &request.card_id,
                            item_kind: "fact",
                            item_id: &fact_id,
                            event_type: "fact.imported",
                            source_type: "legacy-import",
                            source_id: None,
                            modality: "text",
                            observed_at: now,
                            trust: 0.7,
                            consent: "legacy",
                            idempotency_key: &format!("legacy-import:fact:{fact_id}"),
                            payload_json: &payload,
                        },
                    )
                    .map_err(|e| e.to_string())?;
                    append_evidence(
                        &tx,
                        &event_id,
                        "fact",
                        &fact_id,
                        "legacy_record",
                        &[],
                        None,
                        now,
                    )
                    .map_err(|e| e.to_string())?;
                }
                affected += 1;
            }
            for promise in raw
                .get("promises")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let text = promise
                    .as_str()
                    .or_else(|| promise.get("text").and_then(Value::as_str))
                    .unwrap_or("");
                if text.trim().is_empty() || is_sensitive(text) {
                    continue;
                }
                let commitment_id =
                    insert_commitment(&tx, &request.card_id, &user_id, None, text, None, 0.7, now)
                        .map_err(|e| e.to_string())?;
                if let Some(commitment_id) = commitment_id {
                    let payload =
                        serde_json::json!({ "text": truncate_chars(text, 600), "importance": 0.7 })
                            .to_string();
                    let event_id = append_event(
                        &tx,
                        &MemoryEventInput {
                            user_id: &user_id,
                            card_id: &request.card_id,
                            item_kind: "commitment",
                            item_id: &commitment_id,
                            event_type: "commitment.imported",
                            source_type: "legacy-import",
                            source_id: None,
                            modality: "text",
                            observed_at: now,
                            trust: 0.7,
                            consent: "legacy",
                            idempotency_key: &format!("legacy-import:commitment:{commitment_id}"),
                            payload_json: &payload,
                        },
                    )
                    .map_err(|e| e.to_string())?;
                    append_evidence(
                        &tx,
                        &event_id,
                        "commitment",
                        &commitment_id,
                        "legacy_record",
                        &[],
                        None,
                        now,
                    )
                    .map_err(|e| e.to_string())?;
                }
                affected += 1;
            }
            tx.execute(
                "UPDATE memory_users SET total_sessions=MAX(total_sessions,?1),last_seen_at=?2 WHERE id=?3",
                params![imported_sessions as i64, now, user_id],
            ).map_err(|e| e.to_string())?;
        }
    }
    tx.execute(
        "INSERT INTO memory_meta(key,value) VALUES(?1,'1') ON CONFLICT(key) DO UPDATE SET value='1'",
        [&marker],
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(MemoryMutationResponse { ok: true, affected })
}

fn parse_legacy_ts(value: Option<&Value>) -> Option<i64> {
    let text = value?.as_str()?.trim();
    if text.is_empty() {
        return None;
    }
    if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(text) {
        return Some(parsed.timestamp());
    }
    ["%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"]
        .iter()
        .find_map(|format| NaiveDateTime::parse_from_str(text, format).ok())
        .map(|parsed| parsed.and_utc().timestamp())
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Extraction {
    episode: ExtractedEpisode,
    facts: Vec<ExtractedFact>,
    commitments: Vec<ExtractedCommitment>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ExtractedEpisode {
    summary: String,
    emotion: String,
    importance: f64,
    topics: Vec<String>,
    entities: Vec<String>,
    source_message_ids: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ExtractedFact {
    text: String,
    predicate: String,
    value: String,
    durability: String,
    evidence: String,
    confidence: f64,
    importance: f64,
    valid_from: Option<i64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ExtractedCommitment {
    text: String,
    due_at: Option<i64>,
    importance: f64,
}

#[derive(Debug)]
struct PendingJob {
    id: String,
    user_id: String,
    card_id: String,
    session_id: String,
    payload: String,
    attempts: i64,
    created_at: i64,
}

pub fn trigger_worker(app: &AppHandle) {
    let state = app.state::<MemoryState>();
    {
        let mut generation = state.wake_generation.lock().unwrap();
        *generation = generation.wrapping_add(1);
        state.worker_wakeup.notify_all();
    }
    if state.worker_running.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || worker_loop(app));
}

/// 用户刚恢复 Key / 本地模型时，不必继续等待旧的指数退避截止时间。
pub fn retry_pending_now(app: &AppHandle) {
    let state = app.state::<MemoryState>();
    {
        let mut guard = state.conn.lock().unwrap();
        if let Some(conn) = guard.as_mut() {
            let now = now_ts();
            let _ = conn.execute(
                "UPDATE memory_jobs SET next_attempt_at=?1,updated_at=?1
                 WHERE status='retrying'",
                [now],
            );
        }
    }
    trigger_worker(app);
}

fn worker_loop(app: AppHandle) {
    loop {
        let observed_generation = {
            let state = app.state::<MemoryState>();
            let generation = *state.wake_generation.lock().unwrap();
            generation
        };
        let (database_available, job_result, database_generation) = {
            let state = app.state::<MemoryState>();
            let mut guard = state.conn.lock().unwrap();
            let available = guard.is_some();
            let result = guard.as_mut().map(take_due_job);
            let database_generation = state.database_generation.load(Ordering::SeqCst);
            (available, result, database_generation)
        };
        if !database_available {
            break;
        }
        let job = match job_result.expect("available memory database must have a connection") {
            Ok(job) => job,
            Err(error) => {
                let state = app.state::<MemoryState>();
                state.set_error(format!("读取待巩固任务失败，将自动重试：{error}"));
                wait_for_worker_wakeup(&state, observed_generation, 1);
                continue;
            }
        };
        let Some(job) = job else {
            let next_due_result = {
                let state = app.state::<MemoryState>();
                let guard = state.conn.lock().unwrap();
                guard.as_ref().map(|conn| {
                    conn.query_row(
                        "SELECT MIN(next_attempt_at) FROM memory_jobs WHERE status IN ('pending','retrying')",
                        [], |r| r.get::<_, Option<i64>>(0),
                    )
                })
            };
            let next_due = match next_due_result {
                Some(Ok(next_due)) => next_due,
                Some(Err(error)) => {
                    let state = app.state::<MemoryState>();
                    state.set_error(format!("读取记忆重试时间失败，将自动重试：{error}"));
                    wait_for_worker_wakeup(&state, observed_generation, 1);
                    continue;
                }
                None => break,
            };
            if let Some(next_due) = next_due {
                let wait = (next_due - now_ts()).clamp(1, 60) as u64;
                let state = app.state::<MemoryState>();
                wait_for_worker_wakeup(&state, observed_generation, wait);
                continue;
            }
            break;
        };
        let result = process_job(&app, &job);
        let state = app.state::<MemoryState>();
        let mut guard = state.conn.lock().unwrap();
        if state.database_generation.load(Ordering::SeqCst) != database_generation {
            continue;
        }
        if let Some(conn) = guard.as_mut() {
            match result {
                Ok(extraction) => {
                    if let Err(e) = apply_extraction(conn, &job, extraction) {
                        let msg = format!("写入巩固结果失败：{e}");
                        state.set_error(&msg);
                        let _ = retry_job(conn, &job, &msg);
                    } else {
                        state.clear_error();
                    }
                }
                Err(e) => {
                    state.set_error(&e);
                    let _ = retry_job(conn, &job, &e);
                }
            }
        }
    }
    let state = app.state::<MemoryState>();
    state.worker_running.store(false, Ordering::SeqCst);
    let has_due = {
        let guard = state.conn.lock().unwrap();
        guard.as_ref().is_some_and(|conn| {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM memory_jobs
                 WHERE status IN ('pending','retrying') AND next_attempt_at<=?1)",
                [now_ts()],
                |r| r.get::<_, bool>(0),
            )
            .unwrap_or(false)
        })
    };
    if has_due {
        trigger_worker(&app);
    }
}

fn wait_for_worker_wakeup(state: &MemoryState, observed_generation: u64, seconds: u64) {
    let generation = state.wake_generation.lock().unwrap();
    if *generation == observed_generation {
        let _ = state
            .worker_wakeup
            .wait_timeout(generation, std::time::Duration::from_secs(seconds));
    }
}

fn take_due_job(conn: &mut Connection) -> rusqlite::Result<Option<PendingJob>> {
    maintenance(conn)?;
    let now = now_ts();
    let tx = conn.transaction()?;
    let job = tx
        .query_row(
            "SELECT id,user_id,card_id,session_id,payload_json,attempts,created_at
         FROM memory_jobs WHERE status IN ('pending','retrying') AND next_attempt_at<=?1
         ORDER BY created_at LIMIT 1",
            [now],
            |r| {
                Ok(PendingJob {
                    id: r.get(0)?,
                    user_id: r.get(1)?,
                    card_id: r.get(2)?,
                    session_id: r.get(3)?,
                    payload: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    attempts: r.get(5)?,
                    created_at: r.get(6)?,
                })
            },
        )
        .optional()?;
    if let Some(job) = &job {
        tx.execute(
            "UPDATE memory_jobs SET status='processing',updated_at=?1 WHERE id=?2",
            params![now, job.id],
        )?;
    }
    tx.commit()?;
    Ok(job)
}

fn process_job(app: &AppHandle, job: &PendingJob) -> Result<Extraction, String> {
    let messages: Vec<MemoryMessage> =
        serde_json::from_str(&job.payload).map_err(|e| format!("读取待巩固会话失败：{e}"))?;
    let formatted = messages
        .iter()
        .map(|m| {
            let role = if m.role == "user" { "用户" } else { "角色" };
            let image = if m.image_caption.trim().is_empty() {
                String::new()
            } else {
                format!(" [图片:{}]", m.image_caption)
            };
            format!(
                "[id={}] {role}: {}{image}",
                m.id,
                truncate_chars(&m.content, 1800)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let system = r#"你是桌宠的长期记忆整理器。只提取关于当前用户、双方共同经历和角色明确承诺的内容。
不要提取角色人设规则、普通寒暄、API Key、密码、token、支付信息、证件号或精确住址。
短期状态用 temporary；长期偏好用 stable；用户明确要求长期记住的稳定身份事实才用 permanent。
correction/preferenceChange 只在用户明确纠正或说明发生变化时使用。
sourceMessageIds 必须逐字使用输入中真实存在的 id。所有字段允许为空，不要硬凑。
严格只输出 JSON：
{"episode":{"summary":"","emotion":"","importance":0.5,"topics":[],"entities":[],"sourceMessageIds":[]},"facts":[{"text":"","predicate":"","value":"","durability":"temporary|stable|permanent","evidence":"assertion|confirmation|correction|preferenceChange","confidence":0.7,"importance":0.5,"validFrom":null}],"commitments":[{"text":"","dueAt":null,"importance":0.7}]}"#;
    let provider = crate::api::ApiMemoryCompletionProvider::new(app.clone());
    let raw = crate::memory_core::MemoryCompletionProvider::complete_memory_batch(
        &provider,
        crate::memory_core::MemoryCompletionRequest {
            system: system.to_string(),
            input: formatted,
            max_output_tokens: Some(1400),
        },
    )
    .map_err(|e| e.to_string())?
    .json;
    let json = extract_json_object(&raw).ok_or_else(|| "记忆整理结果不是 JSON".to_string())?;
    serde_json::from_str(json).map_err(|e| format!("解析记忆整理结果失败：{e}"))
}

fn extract_json_object(text: &str) -> Option<&str> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    (end >= start).then_some(&text[start..=end])
}

fn retry_job(conn: &Connection, job: &PendingJob, error: &str) -> rusqlite::Result<()> {
    let attempts = job.attempts + 1;
    let delays = [60, 600, 3600, 21_600];
    let delay = delays[(attempts.saturating_sub(1) as usize).min(delays.len() - 1)];
    let expired = now_ts() - job.created_at > JOB_RETENTION_SECS;
    conn.execute(
        "UPDATE memory_jobs SET status=?1,attempts=?2,next_attempt_at=?3,last_error=?4,
         payload_json=CASE WHEN ?5 THEN NULL ELSE payload_json END,updated_at=?6 WHERE id=?7",
        params![
            if expired { "skipped" } else { "retrying" },
            attempts,
            now_ts() + delay,
            truncate_chars(error, 500),
            expired,
            now_ts(),
            job.id
        ],
    )?;
    Ok(())
}

fn apply_extraction(
    conn: &mut Connection,
    job: &PendingJob,
    extraction: Extraction,
) -> rusqlite::Result<()> {
    let messages: Vec<MemoryMessage> = serde_json::from_str(&job.payload).unwrap_or_default();
    let now = now_ts();
    let tx = conn.transaction()?;
    let mut episode_id = None;
    let summary = truncate_chars(&extraction.episode.summary, 1000);
    if !summary.is_empty() && !is_sensitive(&summary) {
        let ids: HashSet<_> = extraction.episode.source_message_ids.iter().collect();
        let source_message_ids: Vec<String> = messages
            .iter()
            .filter(|message| ids.contains(&message.id) && !is_sensitive(&message.content))
            .map(|message| message.id.clone())
            .collect();
        let excerpt = messages
            .iter()
            .filter(|m| ids.contains(&m.id) && !is_sensitive(&m.content))
            .take(4)
            .map(|m| {
                format!(
                    "{}：{}",
                    if m.role == "user" { "用户" } else { "角色" },
                    truncate_chars(&m.content, 300)
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let id = Uuid::new_v4().to_string();
        let topics: Vec<_> = extraction
            .episode
            .topics
            .iter()
            .map(|s| truncate_chars(s, 40))
            .filter(|s| !s.is_empty() && !is_sensitive(s))
            .take(12)
            .collect();
        let entities: Vec<_> = extraction
            .episode
            .entities
            .iter()
            .map(|s| truncate_chars(s, 40))
            .filter(|s| !s.is_empty() && !is_sensitive(s))
            .take(16)
            .collect();
        let topics_json = serde_json::to_string(&topics).unwrap_or_else(|_| "[]".into());
        let entities_json = serde_json::to_string(&entities).unwrap_or_else(|_| "[]".into());
        tx.execute(
            "INSERT INTO memory_episodes(id,user_id,session_id,summary,emotion,importance,
             topics_json,entities_json,source_excerpt,source_expires_at,occurred_at,created_at,updated_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11,?11)",
            params![id, job.user_id, job.session_id, summary, truncate_chars(&extraction.episode.emotion, 60),
                clamp01(extraction.episode.importance), topics_json, entities_json,
                if excerpt.is_empty() { None } else { Some(truncate_chars(&excerpt, 800)) },
                now + SOURCE_RETENTION_SECS, now],
        )?;
        let episode_payload = serde_json::json!({
            "summary": summary.clone(),
            "emotion": truncate_chars(&extraction.episode.emotion, 60),
            "importance": clamp01(extraction.episode.importance),
            "topics": topics.clone(),
            "entities": entities.clone(),
            "sourceMessageIds": source_message_ids.clone(),
        })
        .to_string();
        let event_id = append_event(
            &tx,
            &MemoryEventInput {
                user_id: &job.user_id,
                card_id: &job.card_id,
                item_kind: "episode",
                item_id: &id,
                event_type: "episode.created",
                source_type: "chat-consolidation",
                source_id: Some(&job.id),
                modality: "text",
                observed_at: now,
                trust: extraction.episode.importance,
                consent: "allowed",
                idempotency_key: &format!("consolidation:{}:episode", job.id),
                payload_json: &episode_payload,
            },
        )?;
        append_evidence(
            &tx,
            &event_id,
            "episode",
            &id,
            "derived_from",
            &source_message_ids,
            (!excerpt.is_empty()).then_some(excerpt.as_str()),
            now,
        )?;
        link_episode_nodes(
            &tx,
            &job.user_id,
            &job.card_id,
            &id,
            &topics,
            &entities,
            Some(&event_id),
            extraction.episode.importance,
        )?;
        index_item(
            &tx,
            &id,
            "episode",
            &job.card_id,
            &job.user_id,
            &summary,
            &format!("{} {}", topics.join(" "), entities.join(" ")),
        )?;
        episode_id = Some(id);
    }
    for (fact_index, fact) in extraction.facts.iter().take(30).enumerate() {
        if fact.text.trim().is_empty() || is_sensitive(&fact.text) {
            continue;
        }
        let text = truncate_chars(&fact.text, 600);
        let (predicate, value) = fact_keys(fact, &text);
        let same_before: Option<String> = tx
            .query_row(
                "SELECT id FROM memory_facts
                 WHERE user_id=?1 AND predicate=?2 AND value=?3 AND status='active' LIMIT 1",
                params![job.user_id, predicate, value],
                |row| row.get(0),
            )
            .optional()?;
        let superseded_ids: Vec<String> =
            if matches!(fact.evidence.as_str(), "correction" | "preferenceChange") {
                tx.prepare(
                    "SELECT id FROM memory_facts
                 WHERE user_id=?1 AND predicate=?2 AND status='active'",
                )?
                .query_map(params![job.user_id, predicate], |row| row.get(0))?
                .filter_map(Result::ok)
                .collect()
            } else {
                Vec::new()
            };
        let fact_id = insert_fact(
            &tx,
            &job.card_id,
            &job.user_id,
            episode_id.as_deref(),
            fact,
            now,
        )?;
        let Some(fact_id) = fact_id else { continue };
        let fact_status: String = tx.query_row(
            "SELECT status FROM memory_facts WHERE id=?1",
            [&fact_id],
            |row| row.get(0),
        )?;
        let event_type = if matches!(fact.evidence.as_str(), "correction" | "preferenceChange") {
            "fact.corrected"
        } else if same_before.is_some() {
            "fact.confirmed"
        } else if fact_status == "disputed" {
            "fact.disputed"
        } else {
            "fact.created"
        };
        let fact_payload = serde_json::json!({
            "text": text.clone(),
            "predicate": predicate.clone(),
            "value": value.clone(),
            "durability": fact.durability.clone(),
            "evidence": fact.evidence.clone(),
            "confidence": clamp01(fact.confidence),
            "importance": clamp01(fact.importance),
            "sourceEpisodeId": episode_id.clone(),
        })
        .to_string();
        let event_id = append_event(
            &tx,
            &MemoryEventInput {
                user_id: &job.user_id,
                card_id: &job.card_id,
                item_kind: "fact",
                item_id: &fact_id,
                event_type,
                source_type: "chat-consolidation",
                source_id: Some(&job.id),
                modality: "text",
                observed_at: now,
                trust: fact.confidence,
                consent: "allowed",
                idempotency_key: &format!("consolidation:{}:fact:{fact_index}", job.id),
                payload_json: &fact_payload,
            },
        )?;
        let relation = if matches!(fact.evidence.as_str(), "correction" | "preferenceChange") {
            "supersedes"
        } else if fact_status == "disputed" {
            "contradicts"
        } else {
            "supports"
        };
        append_evidence(&tx, &event_id, "fact", &fact_id, relation, &[], None, now)?;
        link_source_episode(
            &tx,
            &job.user_id,
            &job.card_id,
            "fact",
            &fact_id,
            episode_id.as_deref(),
            Some(&event_id),
            fact.confidence,
        )?;
        for old_id in superseded_ids {
            let old_payload = serde_json::json!({ "supersededBy": fact_id }).to_string();
            let old_event_id = append_event(
                &tx,
                &MemoryEventInput {
                    user_id: &job.user_id,
                    card_id: &job.card_id,
                    item_kind: "fact",
                    item_id: &old_id,
                    event_type: "fact.superseded",
                    source_type: "chat-consolidation",
                    source_id: Some(&job.id),
                    modality: "text",
                    observed_at: now,
                    trust: fact.confidence,
                    consent: "allowed",
                    idempotency_key: &format!(
                        "consolidation:{}:fact:{fact_index}:supersede:{old_id}",
                        job.id
                    ),
                    payload_json: &old_payload,
                },
            )?;
            append_evidence(
                &tx,
                &old_event_id,
                "fact",
                &old_id,
                "superseded_by",
                &[],
                None,
                now,
            )?;
            append_edge(
                &tx,
                &MemoryEdgeInput {
                    user_id: &job.user_id,
                    card_id: &job.card_id,
                    from_kind: "fact",
                    from_id: &fact_id,
                    to_kind: "fact",
                    to_id: &old_id,
                    relation: "supersedes",
                    source_event_id: Some(&event_id),
                    confidence: fact.confidence,
                    derived: true,
                    idempotency_key: &format!("fact:{fact_id}:supersedes:{old_id}"),
                },
            )?;
        }
    }
    for (commitment_index, commitment) in extraction.commitments.iter().take(12).enumerate() {
        if commitment.text.trim().is_empty() || is_sensitive(&commitment.text) {
            continue;
        }
        let commitment_id = insert_commitment(
            &tx,
            &job.card_id,
            &job.user_id,
            episode_id.as_deref(),
            &commitment.text,
            commitment.due_at,
            commitment.importance,
            now,
        )?;
        let Some(commitment_id) = commitment_id else {
            continue;
        };
        let commitment_payload = serde_json::json!({
            "text": truncate_chars(&commitment.text, 600),
            "dueAt": commitment.due_at,
            "importance": clamp01(commitment.importance),
            "sourceEpisodeId": episode_id.clone(),
        })
        .to_string();
        let event_id = append_event(
            &tx,
            &MemoryEventInput {
                user_id: &job.user_id,
                card_id: &job.card_id,
                item_kind: "commitment",
                item_id: &commitment_id,
                event_type: "commitment.created",
                source_type: "chat-consolidation",
                source_id: Some(&job.id),
                modality: "text",
                observed_at: now,
                trust: commitment.importance,
                consent: "allowed",
                idempotency_key: &format!("consolidation:{}:commitment:{commitment_index}", job.id),
                payload_json: &commitment_payload,
            },
        )?;
        append_evidence(
            &tx,
            &event_id,
            "commitment",
            &commitment_id,
            "promised_during",
            &[],
            None,
            now,
        )?;
        link_source_episode(
            &tx,
            &job.user_id,
            &job.card_id,
            "commitment",
            &commitment_id,
            episode_id.as_deref(),
            Some(&event_id),
            commitment.importance,
        )?;
    }
    let resolved_commitments =
        resolve_commitments_from_messages(&tx, &job.user_id, &messages, now)?;
    for (resolution_index, (commitment_id, status)) in resolved_commitments.iter().enumerate() {
        let payload = serde_json::json!({ "status": status }).to_string();
        let event_id = append_event(
            &tx,
            &MemoryEventInput {
                user_id: &job.user_id,
                card_id: &job.card_id,
                item_kind: "commitment",
                item_id: commitment_id,
                event_type: "commitment.status_changed",
                source_type: "chat-consolidation",
                source_id: Some(&job.id),
                modality: "text",
                observed_at: now,
                trust: 0.9,
                consent: "allowed",
                idempotency_key: &format!(
                    "consolidation:{}:commitment-resolve:{resolution_index}",
                    job.id
                ),
                payload_json: &payload,
            },
        )?;
        append_evidence(
            &tx,
            &event_id,
            "commitment",
            commitment_id,
            "fulfilled_or_cancelled_by",
            &[],
            None,
            now,
        )?;
    }
    let session_already_counted: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM memory_jobs WHERE user_id=?1 AND session_id=?2 AND status='done')",
        params![job.user_id, job.session_id], |r| r.get(0),
    )?;
    tx.execute(
        "UPDATE memory_users SET total_sessions=total_sessions+?1,last_seen_at=?2 WHERE id=?3",
        params![
            if session_already_counted { 0 } else { 1 },
            now,
            job.user_id
        ],
    )?;
    tx.execute(
        "UPDATE memory_jobs SET status='done',payload_json=NULL,last_error=NULL,updated_at=?1 WHERE id=?2",
        params![now, job.id],
    )?;
    tx.commit()
}

fn insert_fact(
    tx: &Transaction<'_>,
    card_id: &str,
    user_id: &str,
    episode_id: Option<&str>,
    fact: &ExtractedFact,
    now: i64,
) -> rusqlite::Result<Option<String>> {
    let text = truncate_chars(&fact.text, 600);
    let (predicate, value) = fact_keys(fact, &text);
    if text.is_empty() || is_sensitive(&text) || is_sensitive(&predicate) || is_sensitive(&value) {
        return Ok(None);
    }
    let same: Option<(String, i64, f64)> = tx
        .query_row(
            "SELECT id,confirmation_count,confidence FROM memory_facts
         WHERE user_id=?1 AND predicate=?2 AND value=?3 AND status='active' LIMIT 1",
            params![user_id, predicate, value],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    if let Some((id, count, confidence)) = same {
        tx.execute(
            "UPDATE memory_facts SET confirmation_count=?1,confidence=?2,last_confirmed_at=?3,
             updated_at=?3,source_episode_id=COALESCE(?4,source_episode_id) WHERE id=?5",
            params![
                count + 1,
                confidence.max(clamp01(fact.confidence)),
                now,
                episode_id,
                id
            ],
        )?;
        rebuild_search_item(tx, "fact", &id)?;
        return Ok(Some(id));
    }
    let change = matches!(fact.evidence.as_str(), "correction" | "preferenceChange");
    let conflict: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM memory_facts WHERE user_id=?1 AND predicate=?2 AND status='active')",
        params![user_id, predicate], |r| r.get(0),
    )?;
    if change {
        tx.execute(
            "UPDATE memory_facts SET status='superseded',valid_to=?1,updated_at=?1
             WHERE user_id=?2 AND predicate=?3 AND status='active'",
            params![now, user_id, predicate],
        )?;
        tx.execute(
            "DELETE FROM memory_search WHERE kind='fact' AND item_id IN (
                SELECT id FROM memory_facts WHERE user_id=?1 AND predicate=?2 AND status='superseded'
             )",
            params![user_id, predicate],
        )?;
    }
    let durability = match fact.durability.as_str() {
        "temporary" | "permanent" => fact.durability.as_str(),
        _ => "stable",
    };
    let valid_to = (durability == "temporary").then_some(now + 7 * 86_400);
    let status = if conflict && !change {
        "disputed"
    } else {
        "active"
    };
    let id = Uuid::new_v4().to_string();
    tx.execute(
        "INSERT INTO memory_facts(id,user_id,source_episode_id,text,predicate,value,confidence,
         importance,durability,status,valid_from,valid_to,first_seen_at,last_confirmed_at,created_at,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?13,?13,?13)",
        params![id,user_id,episode_id,text,predicate,value,clamp01(fact.confidence),
            clamp01(fact.importance),durability,status,fact.valid_from.or(Some(now)),valid_to,now],
    )?;
    index_item(
        tx,
        &id,
        "fact",
        card_id,
        user_id,
        &text,
        &format!("{} {}", predicate, value),
    )?;
    Ok(Some(id))
}

fn fact_keys(fact: &ExtractedFact, text: &str) -> (String, String) {
    let predicate = truncate_chars(
        if fact.predicate.trim().is_empty() {
            text
        } else {
            &fact.predicate
        },
        120,
    )
    .to_lowercase();
    let value = truncate_chars(
        if fact.value.trim().is_empty() {
            text
        } else {
            &fact.value
        },
        300,
    )
    .to_lowercase();
    (predicate, value)
}

fn insert_commitment(
    tx: &Transaction<'_>,
    card_id: &str,
    user_id: &str,
    episode_id: Option<&str>,
    text: &str,
    due_at: Option<i64>,
    importance: f64,
    now: i64,
) -> rusqlite::Result<Option<String>> {
    let text = truncate_chars(text, 600);
    if text.is_empty() || is_sensitive(&text) {
        return Ok(None);
    }
    let existing: Option<String> = {
        let mut stmt = tx.prepare(
            "SELECT id,text FROM memory_commitments
             WHERE user_id=?1 AND status='pending' ORDER BY updated_at DESC LIMIT 50",
        )?;
        let rows = stmt.query_map([user_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        let found = rows
            .filter_map(Result::ok)
            .find(|(_, old_text)| {
                old_text == &text || jaccard(&grams(old_text), &grams(&text)) >= 0.78
            })
            .map(|(id, _)| id);
        found
    };
    if let Some(id) = existing {
        tx.execute(
            "UPDATE memory_commitments SET due_at=COALESCE(?1,due_at),importance=MAX(importance,?2),
             source_episode_id=COALESCE(?3,source_episode_id),updated_at=?4 WHERE id=?5",
            params![due_at,clamp01(importance),episode_id,now,id],
        )?;
        rebuild_search_item(tx, "commitment", &id)?;
        return Ok(Some(id));
    }
    let id = Uuid::new_v4().to_string();
    tx.execute(
        "INSERT INTO memory_commitments(id,user_id,source_episode_id,text,due_at,status,
         importance,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'pending',?6,?7,?7)",
        params![
            id,
            user_id,
            episode_id,
            text,
            due_at,
            clamp01(importance),
            now
        ],
    )?;
    index_item(
        tx,
        &id,
        "commitment",
        card_id,
        user_id,
        &text,
        "约定 承诺 待办",
    )?;
    Ok(Some(id))
}

fn resolve_commitments_from_messages(
    conn: &Connection,
    user_id: &str,
    messages: &[MemoryMessage],
    now: i64,
) -> rusqlite::Result<Vec<(String, String)>> {
    let mut resolutions = Vec::new();
    for message in messages.iter().filter(|message| message.role == "user") {
        let text = message.content.trim();
        let status = if ["不用提醒", "别提醒", "取消提醒", "不需要提醒"]
            .iter()
            .any(|marker| text.contains(marker))
        {
            Some("cancelled")
        } else if ["已经完成", "完成了", "搞定了", "办完了", "做完了"]
            .iter()
            .any(|marker| text.contains(marker))
        {
            Some("fulfilled")
        } else {
            None
        };
        if let Some(status) = status {
            resolutions.push((text.to_string(), status));
        }
    }
    if resolutions.is_empty() {
        return Ok(Vec::new());
    }
    let pending: Vec<(String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT id,text FROM memory_commitments
             WHERE user_id=?1 AND status='pending' ORDER BY updated_at DESC LIMIT 50",
        )?;
        let pending = stmt
            .query_map([user_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .filter_map(Result::ok)
            .collect();
        pending
    };
    let mut changed = Vec::new();
    for (message, status) in resolutions {
        let message_grams = grams(&message);
        for (id, commitment) in &pending {
            if jaccard(&message_grams, &grams(commitment)) < 0.08 {
                continue;
            }
            let affected = conn.execute(
                "UPDATE memory_commitments SET status=?1,resolved_at=?2,updated_at=?2
                 WHERE id=?3 AND status='pending'",
                params![status, now, id],
            )?;
            if affected > 0 {
                changed.push((id.clone(), status.to_string()));
            }
        }
    }
    Ok(changed)
}

fn index_item(
    conn: &Connection,
    id: &str,
    kind: &str,
    card_id: &str,
    user_id: &str,
    text: &str,
    tags: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM memory_search WHERE item_id=?1 AND kind=?2",
        params![id, kind],
    )?;
    conn.execute(
        "INSERT INTO memory_search(item_id,kind,card_id,user_id,text,tags) VALUES(?1,?2,?3,?4,?5,?6)",
        params![id,kind,card_id,user_id,text,tags],
    )?;
    Ok(())
}

fn rebuild_search_item(conn: &Connection, kind: &str, id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM memory_search WHERE item_id=?1 AND kind=?2",
        params![id, kind],
    )?;
    let row: Option<(String,String,String,String)> = match kind {
        "fact" => conn.query_row(
            "SELECT u.card_id,f.user_id,f.text,f.predicate||' '||f.value FROM memory_facts f JOIN memory_users u ON u.id=f.user_id WHERE f.id=?1",
            [id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)),
        ).optional()?,
        "episode" => conn.query_row(
            "SELECT u.card_id,e.user_id,e.summary,e.topics_json||' '||e.entities_json FROM memory_episodes e JOIN memory_users u ON u.id=e.user_id WHERE e.id=?1",
            [id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)),
        ).optional()?,
        "commitment" => conn.query_row(
            "SELECT u.card_id,c.user_id,c.text,'约定 承诺 待办' FROM memory_commitments c JOIN memory_users u ON u.id=c.user_id WHERE c.id=?1",
            [id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)),
        ).optional()?,
        _ => None,
    };
    if let Some((card_id, user_id, text, tags)) = row {
        index_item(conn, id, kind, &card_id, &user_id, &text, &tags)?;
    }
    Ok(())
}

fn is_sensitive(text: &str) -> bool {
    let lower = text.to_lowercase();
    let suspicious = [
        "api key",
        "apikey",
        "password",
        "密码",
        "token",
        "access key",
        "accesskey",
        "银行卡",
        "信用卡",
        "身份证号",
        "护照号",
        "cvv",
        "-----begin private key",
    ];
    if suspicious.iter().any(|needle| lower.contains(needle)) {
        return true;
    }
    let long_digits = lower
        .chars()
        .fold((0usize, false), |(run, found), c| {
            if found {
                (run, true)
            } else if c.is_ascii_digit() {
                (run + 1, run + 1 >= 14)
            } else {
                (0, false)
            }
        })
        .1;
    long_digits
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        configure(&conn).unwrap();
        migrate(&mut conn).unwrap();
        conn
    }

    fn fact(text: &str, predicate: &str, value: &str, evidence: &str) -> ExtractedFact {
        ExtractedFact {
            text: text.into(),
            predicate: predicate.into(),
            value: value.into(),
            durability: "stable".into(),
            evidence: evidence.into(),
            confidence: 0.8,
            importance: 0.6,
            valid_from: None,
        }
    }

    #[test]
    fn schema_and_chinese_fts_are_available() {
        let conn = test_db();
        let user = get_or_create_user(&conn, "card", "小明").unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        insert_fact(
            &tx,
            "card",
            &user,
            None,
            &fact(
                "用户下周参加产品经理面试",
                "近期安排",
                "产品经理面试",
                "assertion",
            ),
            now_ts(),
        )
        .unwrap();
        tx.commit().unwrap();
        let found = search_candidates(&conn, "card", &user, "产品经理面试").unwrap();
        assert_eq!(found.len(), 1);
        assert!(found[0].text.contains("面试"));
    }

    #[test]
    fn recall_exposes_structured_fact_conflict_fields() {
        let mut conn = test_db();
        let user = get_or_create_user(&conn, "card", "小明").unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        insert_fact(
            &tx,
            "card",
            &user,
            None,
            &fact("用户喜欢辣", "饮食偏好", "喜欢辣", "assertion"),
            now_ts(),
        )
        .unwrap();
        tx.commit().unwrap();
        let response = recall_memory(
            &mut conn,
            &MemoryRecallRequest {
                card_id: "card".into(),
                nickname: "小明".into(),
                query: "喜欢辣".into(),
                reason: String::new(),
                image_caption: String::new(),
                max_items: Some(6),
            },
        )
        .unwrap();
        let item = response
            .items
            .iter()
            .find(|item| item.kind == "fact")
            .unwrap();
        assert_eq!(item.predicate.as_deref(), Some("饮食偏好"));
        assert_eq!(item.value.as_deref(), Some("喜欢辣"));
        assert_eq!(item.conflict_key.as_deref(), Some("饮食偏好"));
    }

    #[test]
    fn recall_in_memory_p95_stays_under_budget() {
        let mut conn = test_db();
        let user = get_or_create_user(&conn, "card", "小明").unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        for index in 0..20 {
            insert_fact(
                &tx,
                "card",
                &user,
                None,
                &fact(
                    &format!("用户偏好测试项{index}"),
                    "偏好",
                    &format!("测试项{index}"),
                    "assertion",
                ),
                now_ts(),
            )
            .unwrap();
        }
        tx.commit().unwrap();
        let mut elapsed = Vec::new();
        for _ in 0..100 {
            let started = Instant::now();
            let response = recall_memory(
                &mut conn,
                &MemoryRecallRequest {
                    card_id: "card".into(),
                    nickname: "小明".into(),
                    query: "测试项".into(),
                    reason: String::new(),
                    image_caption: String::new(),
                    max_items: Some(6),
                },
            )
            .unwrap();
            elapsed.push(started.elapsed().as_millis());
            assert!(response.total_chars <= RECALL_CHAR_BUDGET);
            assert!(response.items.len() <= MAX_RECALL_ITEMS);
        }
        elapsed.sort_unstable();
        assert!(elapsed[94] < 30, "recall p95 too slow: {}ms", elapsed[94]);
    }

    #[test]
    fn event_replay_restores_materialized_items_without_changing_log() {
        let mut conn = test_db();
        let user = get_or_create_user(&conn, "card", "小明").unwrap();
        let before = scalar_count(&conn, "SELECT COUNT(*) FROM memory_events").unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        let episode_id = "episode-replay";
        tx.execute("INSERT INTO memory_episodes(id,user_id,summary,importance,topics_json,entities_json,occurred_at,created_at,updated_at) VALUES(?1,?2,'面试经历',0.9,'[\"面试\"]','[]',100,100,100)", params![episode_id, &user]).unwrap();
        append_event(&tx, &MemoryEventInput { user_id: &user, card_id: "card", item_kind: "episode", item_id: episode_id, event_type: "episode.created", source_type: "test", source_id: None, modality: "text", observed_at: 100, trust: 0.9, consent: "allowed", idempotency_key: "replay-episode", payload_json: r#"{"summary":"面试经历","importance":0.9,"topics":["面试"],"entities":[]}"# }).unwrap();
        tx.execute("INSERT INTO memory_facts(id,user_id,text,predicate,value,confidence,importance,durability,status,valid_from,first_seen_at,last_confirmed_at,created_at,updated_at) VALUES('fact-replay',?1,'用户准备面试','安排','面试',0.8,0.7,'stable','active',100,100,100,100,100)", [&user]).unwrap();
        append_event(&tx, &MemoryEventInput { user_id: &user, card_id: "card", item_kind: "fact", item_id: "fact-replay", event_type: "fact.created", source_type: "test", source_id: None, modality: "text", observed_at: 100, trust: 0.8, consent: "allowed", idempotency_key: "replay-fact", payload_json: r#"{"text":"用户准备面试","predicate":"安排","value":"面试","confidence":0.8,"importance":0.7,"durability":"stable","sourceEpisodeId":"episode-replay"}"# }).unwrap();
        tx.execute("INSERT INTO memory_commitments(id,user_id,text,status,importance,created_at,updated_at) VALUES('commitment-replay',?1,'元元下次提醒面试','pending',0.8,100,100)", [&user]).unwrap();
        append_event(
            &tx,
            &MemoryEventInput {
                user_id: &user,
                card_id: "card",
                item_kind: "commitment",
                item_id: "commitment-replay",
                event_type: "commitment.created",
                source_type: "test",
                source_id: None,
                modality: "text",
                observed_at: 100,
                trust: 0.8,
                consent: "allowed",
                idempotency_key: "replay-commitment",
                payload_json: r#"{"text":"元元下次提醒面试","importance":0.8}"#,
            },
        )
        .unwrap();
        append_event(
            &tx,
            &MemoryEventInput {
                user_id: &user,
                card_id: "card",
                item_kind: "commitment",
                item_id: "commitment-replay",
                event_type: "commitment.status_changed",
                source_type: "test",
                source_id: None,
                modality: "text",
                observed_at: 101,
                trust: 0.9,
                consent: "allowed",
                idempotency_key: "replay-commitment-status",
                payload_json: r#"{"status":"fulfilled"}"#,
            },
        )
        .unwrap();
        append_event(
            &tx,
            &MemoryEventInput {
                user_id: &user,
                card_id: "card",
                item_kind: "fact",
                item_id: "fact-old",
                event_type: "fact.created",
                source_type: "test",
                source_id: None,
                modality: "text",
                observed_at: 90,
                trust: 0.7,
                consent: "allowed",
                idempotency_key: "replay-fact-old",
                payload_json: r#"{"text":"用户喜欢辣","predicate":"饮食偏好","value":"喜欢辣","confidence":0.7,"importance":0.5,"durability":"stable"}"#,
            },
        )
        .unwrap();
        append_event(
            &tx,
            &MemoryEventInput {
                user_id: &user,
                card_id: "card",
                item_kind: "fact",
                item_id: "fact-old",
                event_type: "fact.superseded",
                source_type: "test",
                source_id: None,
                modality: "text",
                observed_at: 102,
                trust: 0.9,
                consent: "allowed",
                idempotency_key: "replay-fact-old-superseded",
                payload_json: r#"{"supersededBy":"fact-replay"}"#,
            },
        )
        .unwrap();
        tx.commit().unwrap();
        let events = scalar_count(&conn, "SELECT COUNT(*) FROM memory_events").unwrap();
        assert_eq!(events, before + 6);
        conn.execute("DELETE FROM memory_facts", []).unwrap();
        conn.execute("DELETE FROM memory_episodes", []).unwrap();
        rebuild_from_events(
            &mut conn,
            &MemoryRebuildEventsRequest {
                card_id: "card".into(),
                nickname: Some("小明".into()),
            },
        )
        .unwrap();
        assert_eq!(
            scalar_count(&conn, "SELECT COUNT(*) FROM memory_events").unwrap(),
            events
        );
        assert_eq!(
            scalar_count(
                &conn,
                "SELECT COUNT(*) FROM memory_facts WHERE id='fact-replay'"
            )
            .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row(
                "SELECT source_episode_id FROM memory_facts WHERE id='fact-replay'",
                [],
                |row| row.get::<_, Option<String>>(0),
            )
            .unwrap()
            .as_deref(),
            Some("episode-replay")
        );
        assert_eq!(
            scalar_count(
                &conn,
                "SELECT COUNT(*) FROM memory_episodes WHERE id='episode-replay'"
            )
            .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row(
                "SELECT status FROM memory_commitments WHERE id='commitment-replay'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
            "fulfilled"
        );
        assert_eq!(
            conn.query_row(
                "SELECT status FROM memory_facts WHERE id='fact-old'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            "superseded"
        );
        assert_eq!(
            scalar_count(
                &conn,
                "SELECT COUNT(*) FROM memory_search WHERE item_id='fact-old'"
            )
            .unwrap(),
            0
        );
        assert!(
            scalar_count(
                &conn,
                "SELECT COUNT(*) FROM memory_search WHERE item_id='fact-replay'"
            )
            .unwrap()
                > 0
        );

        conn.execute("INSERT INTO memory_events(id,scope_id,user_id,item_kind,item_id,event_type,source_type,modality,observed_at,trust,consent,idempotency_key,payload_json,created_at) SELECT 'bad-replay-event',scope_id,user_id,'fact','bad-replay','fact.created','test','text',100,0.5,'allowed','bad-replay','not-json',100 FROM memory_events WHERE idempotency_key='replay-fact'", []).unwrap();
        assert!(rebuild_from_events(
            &mut conn,
            &MemoryRebuildEventsRequest {
                card_id: "card".into(),
                nickname: Some("小明".into())
            }
        )
        .is_err());
        assert_eq!(
            scalar_count(
                &conn,
                "SELECT COUNT(*) FROM memory_facts WHERE id='fact-replay'"
            )
            .unwrap(),
            1
        );
    }

    #[test]
    fn v4_events_are_append_only_and_idempotent() {
        let conn = test_db();
        let user = get_or_create_user(&conn, "card", "小明").unwrap();
        let payload = r#"{"text":"用户下周面试"}"#;
        let input = MemoryEventInput {
            user_id: &user,
            card_id: "card",
            item_kind: "fact",
            item_id: "fact-1",
            event_type: "fact.created",
            source_type: "test",
            source_id: Some("job-1"),
            modality: "text",
            observed_at: 100,
            trust: 2.0,
            consent: "allowed",
            idempotency_key: "test-event-1",
            payload_json: payload,
        };
        let first = append_event(&conn, &input).unwrap();
        let second = append_event(&conn, &input).unwrap();
        assert_eq!(first, second);
        let trust: f64 = conn
            .query_row(
                "SELECT trust FROM memory_events WHERE id=?1",
                [&first],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(trust, 1.0);
        let update = conn.execute(
            "UPDATE memory_events SET payload_json='{}' WHERE id=?1",
            [&first],
        );
        assert!(update.is_err());
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM memory_events", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn v3_migration_backfills_existing_items_once() {
        let mut conn = test_db();
        let user = get_or_create_user(&conn, "card", "小明").unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        insert_fact(
            &tx,
            "card",
            &user,
            None,
            &fact("用户下周参加面试", "近期安排", "参加面试", "assertion"),
            now_ts(),
        )
        .unwrap();
        tx.commit().unwrap();
        conn.execute_batch(
            "DROP TRIGGER IF EXISTS memory_events_no_update;
             DROP TABLE memory_edges;
             DROP TABLE memory_evidence;
             DROP TABLE memory_events;
             DROP TABLE memory_scopes;
             UPDATE memory_meta SET value='3' WHERE key='schema_version';",
        )
        .unwrap();
        migrate(&mut conn).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT value FROM memory_meta WHERE key='schema_version'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "5"
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM memory_events WHERE source_type='schema-migration'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        migrate(&mut conn).unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM memory_events WHERE source_type='schema-migration'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }

    #[test]
    fn v4_to_v5_migration_backfills_topics_entities_and_edges() {
        let mut conn = test_db();
        let user = get_or_create_user(&conn, "card", "小明").unwrap();
        conn.execute(
            "INSERT INTO memory_episodes(id,user_id,summary,topics_json,entities_json,occurred_at,created_at,updated_at)
             VALUES('episode-v4',?1,'准备面试','[\"产品经理\"]','[\"小明\"]',100,100,100)",
            [&user],
        )
        .unwrap();
        conn.execute_batch(
            "DROP TABLE memory_edges;
             DROP TABLE memory_entities;
             DROP TABLE memory_topics;
             UPDATE memory_meta SET value='4' WHERE key='schema_version';",
        )
        .unwrap();
        migrate(&mut conn).unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM memory_topics", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM memory_entities", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM memory_edges WHERE from_kind='episode' AND from_id='episode-v4'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            2
        );
        migrate(&mut conn).unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM memory_edges", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
    }

    #[test]
    fn timeline_is_card_scoped_and_excerpts_expire_without_removing_events() {
        let conn = test_db();
        let alice = get_or_create_user(&conn, "card-a", "小明").unwrap();
        let bob = get_or_create_user(&conn, "card-b", "小明").unwrap();
        let payload = r#"{"summary":"一起准备面试"}"#;
        let alice_event = append_event(
            &conn,
            &MemoryEventInput {
                user_id: &alice,
                card_id: "card-a",
                item_kind: "episode",
                item_id: "episode-a",
                event_type: "episode.created",
                source_type: "chat-consolidation",
                source_id: Some("job-a"),
                modality: "text",
                observed_at: 100,
                trust: 0.8,
                consent: "allowed",
                idempotency_key: "timeline-a",
                payload_json: payload,
            },
        )
        .unwrap();
        let _bob_event = append_event(
            &conn,
            &MemoryEventInput {
                user_id: &bob,
                card_id: "card-b",
                item_kind: "episode",
                item_id: "episode-a",
                event_type: "episode.created",
                source_type: "chat-consolidation",
                source_id: Some("job-b"),
                modality: "text",
                observed_at: 100,
                trust: 0.8,
                consent: "allowed",
                idempotency_key: "timeline-b",
                payload_json: payload,
            },
        )
        .unwrap();
        append_evidence(
            &conn,
            &alice_event,
            "episode",
            "episode-a",
            "derived_from",
            &["m1".into()],
            Some("面试原话"),
            now_ts() - SOURCE_RETENTION_SECS - 1,
        )
        .unwrap();
        maintenance(&conn).unwrap();
        let alice_timeline = timeline(
            &conn,
            &MemoryTimelineQuery {
                card_id: "card-a".into(),
                kind: "episode".into(),
                id: "episode-a".into(),
                limit: Some(10),
            },
        )
        .unwrap();
        assert_eq!(alice_timeline.events.len(), 1);
        assert_eq!(alice_timeline.events[0].source_type, "chat-consolidation");
        assert!(alice_timeline.events[0].evidence[0].excerpt.is_none());
        let other = timeline(
            &conn,
            &MemoryTimelineQuery {
                card_id: "card-b".into(),
                kind: "episode".into(),
                id: "episode-a".into(),
                limit: Some(10),
            },
        )
        .unwrap();
        assert_eq!(other.events.len(), 1);
    }

    #[test]
    fn graph_edges_are_idempotent_scoped_and_explainable() {
        let mut conn = test_db();
        let user = get_or_create_user(&conn, "card-a", "小明").unwrap();
        let event_id = append_event(
            &conn,
            &MemoryEventInput {
                user_id: &user,
                card_id: "card-a",
                item_kind: "episode",
                item_id: "episode-1",
                event_type: "episode.created",
                source_type: "test",
                source_id: None,
                modality: "text",
                observed_at: now_ts(),
                trust: 0.9,
                consent: "allowed",
                idempotency_key: "edge-event-1",
                payload_json: r#"{"summary":"面试准备"}"#,
            },
        )
        .unwrap();
        link_episode_nodes(
            &conn,
            &user,
            "card-a",
            "episode-1",
            &["产品经理面试".into()],
            &["小明".into()],
            Some(&event_id),
            0.8,
        )
        .unwrap();
        let edges = query_edges(&conn, "card-a", "episode", "episode-1", 20).unwrap();
        assert_eq!(edges.len(), 2);
        assert!(edges
            .iter()
            .any(|edge| edge.relation == "about" && edge.to_kind == "topic"));
        assert!(edges
            .iter()
            .any(|edge| edge.relation == "mentions" && edge.to_kind == "entity"));
        assert!(edges.iter().any(|edge| edge.to_label == "产品经理面试"));
        assert!(edges.iter().any(|edge| edge.to_label == "小明"));
        link_episode_nodes(
            &conn,
            &user,
            "card-a",
            "episode-1",
            &["产品经理面试".into()],
            &["小明".into()],
            Some(&event_id),
            0.8,
        )
        .unwrap();
        assert_eq!(
            query_edges(&conn, "card-a", "episode", "episode-1", 20)
                .unwrap()
                .len(),
            2
        );
        assert!(query_edges(&conn, "card-b", "episode", "episode-1", 20)
            .unwrap()
            .is_empty());
        delete_memory(
            &mut conn,
            &MemoryDeleteRequest {
                items: vec![MemoryItemRef {
                    kind: "episode".into(),
                    id: "episode-1".into(),
                }],
            },
        )
        .unwrap();
        assert!(query_edges(&conn, "card-a", "episode", "episode-1", 20)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn memory_graph_is_scoped_filtered_bounded_and_preserves_edge_provenance() {
        let conn = test_db();
        let user_a = get_or_create_user(&conn, "card-a", "小明").unwrap();
        let user_b = get_or_create_user(&conn, "card-b", "小明").unwrap();
        let now = now_ts();
        conn.execute(
            "INSERT INTO memory_episodes(id,user_id,summary,importance,topics_json,entities_json,occurred_at,created_at,updated_at)
             VALUES('episode-a',?1,'准备产品经理面试',0.9,'[\"面试\"]','[\"小明\"]',?2,?2,?2)",
            params![user_a, now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO memory_episodes(id,user_id,summary,occurred_at,created_at,updated_at)
             VALUES('episode-b',?1,'另一张卡的面试',?2,?2,?2)",
            params![user_b, now],
        )
        .unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        let fact_id = insert_fact(
            &tx,
            "card-a",
            &user_a,
            Some("episode-a"),
            &fact("下周参加产品经理面试", "近期安排", "面试", "assertion"),
            now,
        )
        .unwrap()
        .unwrap();
        insert_fact(
            &tx,
            "card-a",
            &user_a,
            None,
            &fact("已经过期的事实", "过期", "旧", "assertion"),
            now - 8 * 86_400,
        )
        .unwrap();
        tx.commit().unwrap();
        conn.execute(
            "UPDATE memory_facts SET valid_to=?1 WHERE text='已经过期的事实'",
            params![now - 1],
        )
        .unwrap();
        let event_id = append_event(
            &conn,
            &MemoryEventInput {
                user_id: &user_a,
                card_id: "card-a",
                item_kind: "fact",
                item_id: &fact_id,
                event_type: "fact.created",
                source_type: "test",
                source_id: Some("test-event"),
                modality: "text",
                observed_at: now,
                trust: 0.9,
                consent: "allowed",
                idempotency_key: "graph-fact-event",
                payload_json: r#"{"text":"面试"}"#,
            },
        )
        .unwrap();
        append_evidence(
            &conn,
            &event_id,
            "fact",
            &fact_id,
            "supports",
            &[],
            None,
            now,
        )
        .unwrap();

        let graph_result = graph(
            &conn,
            &MemoryGraphQuery {
                card_id: "card-a".into(),
                nickname: "小明".into(),
                scope: "user".into(),
                search: "面试".into(),
                kind: "fact".into(),
                status: String::new(),
                since: None,
                until: None,
                min_confidence: Some(0.7),
                depth: Some(1),
                max_nodes: Some(20),
            },
        )
        .unwrap();
        assert!(graph_result.nodes.iter().any(|node| node.id == fact_id));
        assert!(!graph_result
            .nodes
            .iter()
            .any(|node| node.text == "已经过期的事实"));
        assert!(graph_result
            .nodes
            .iter()
            .find(|node| node.id == fact_id)
            .unwrap()
            .source_event_ids
            .contains(&event_id));
        assert_eq!(
            graph_result
                .nodes
                .iter()
                .find(|node| node.id == fact_id)
                .and_then(|node| node.revision),
            Some(1)
        );
        assert!(graph_result.edges.iter().all(|edge| edge.derived));

        let other_card = graph(
            &conn,
            &MemoryGraphQuery {
                card_id: "card-b".into(),
                nickname: String::new(),
                scope: "card".into(),
                search: String::new(),
                kind: String::new(),
                status: String::new(),
                since: None,
                until: None,
                min_confidence: None,
                depth: Some(2),
                max_nodes: Some(200),
            },
        )
        .unwrap();
        assert!(other_card.nodes.iter().all(|node| node.user_id == user_b));

        let bounded = graph(
            &conn,
            &MemoryGraphQuery {
                card_id: "card-a".into(),
                nickname: String::new(),
                scope: "card".into(),
                search: String::new(),
                kind: String::new(),
                status: String::new(),
                since: None,
                until: None,
                min_confidence: None,
                depth: Some(2),
                max_nodes: Some(2),
            },
        )
        .unwrap();
        assert_eq!(bounded.nodes.len(), 2);
        assert!(bounded.truncated);
        assert!(bounded.total_candidates >= bounded.nodes.len());
    }

    #[test]
    fn integrity_check_reports_fts_and_foreign_key_corruption() {
        let conn = test_db();
        let healthy = integrity_check(&conn).unwrap();
        assert!(healthy.ok);
        assert_eq!(healthy.integrity_result, "ok");
        conn.execute(
            "INSERT INTO memory_search(item_id,kind,card_id,user_id,text,tags)
             VALUES('missing','fact','card','missing-user','孤立索引','')",
            [],
        )
        .unwrap();
        let broken = integrity_check(&conn).unwrap();
        assert!(!broken.ok);
        assert!(broken.errors.iter().any(|error| error.contains("FTS")));
        conn.execute_batch("PRAGMA foreign_keys=OFF;
            INSERT INTO memory_edges(id,scope_id,user_id,from_kind,from_id,to_kind,to_id,relation,idempotency_key,created_at)
            VALUES('broken-edge','missing-scope','missing-user','fact','missing','topic','missing-topic','about','broken-edge',1);
            PRAGMA foreign_keys=ON;").unwrap();
        let broken_fk = integrity_check(&conn).unwrap();
        assert!(!broken_fk.ok);
        assert!(
            broken_fk.foreign_key_errors > 0
                || broken_fk
                    .errors
                    .iter()
                    .any(|error| error.contains("关系边"))
        );
    }

    #[test]
    fn export_is_scoped_and_omits_raw_payload_and_sensitive_text() {
        let conn = test_db();
        let alice = get_or_create_user(&conn, "card-a", "小明").unwrap();
        let bob = get_or_create_user(&conn, "card-a", "阿青").unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        insert_fact(
            &tx,
            "card-a",
            &alice,
            None,
            &fact("小明准备面试", "近期安排", "面试", "assertion"),
            now_ts(),
        )
        .unwrap();
        insert_fact(
            &tx,
            "card-a",
            &bob,
            None,
            &fact("阿青准备露营", "近期安排", "露营", "assertion"),
            now_ts(),
        )
        .unwrap();
        tx.commit().unwrap();
        let sensitive_id: String = conn
            .query_row(
                "SELECT id FROM memory_facts WHERE user_id=?1",
                [&alice],
                |r| r.get(0),
            )
            .unwrap();
        conn.execute(
            "UPDATE memory_facts SET text='API Key sk-secret-123456789' WHERE id=?1",
            [&sensitive_id],
        )
        .unwrap();
        let event_id = append_event(
            &conn,
            &MemoryEventInput {
                user_id: &alice,
                card_id: "card-a",
                item_kind: "fact",
                item_id: &sensitive_id,
                event_type: "fact.created",
                source_type: "test",
                source_id: None,
                modality: "text",
                observed_at: now_ts(),
                trust: 0.8,
                consent: "allowed",
                idempotency_key: "export-event",
                payload_json: r#"{"text":"raw secret should not export"}"#,
            },
        )
        .unwrap();
        assert!(!event_id.is_empty());
        let exported = export_memory(
            &conn,
            &MemoryExportRequest {
                card_id: "card-a".into(),
                nickname: "小明".into(),
            },
        )
        .unwrap();
        assert_eq!(exported.user_count, 1);
        assert_eq!(exported.item_count, 1);
        assert!(exported.json.contains("敏感内容已省略"));
        assert!(!exported.json.contains("raw secret should not export"));
        assert!(!exported.json.contains("sk-secret-123456789"));
    }

    #[test]
    fn vacuum_backup_round_trip_passes_read_only_verification() {
        let conn = test_db();
        let path =
            std::env::temp_dir().join(format!("kxyy-memory-backup-{}.sqlite3", Uuid::new_v4()));
        conn.execute("VACUUM INTO ?1", [path.to_string_lossy().as_ref()])
            .unwrap();
        let verified = verify_backup_file(&path).unwrap();
        assert_eq!(verified.schema_version, SCHEMA_VERSION);
        assert_eq!(verified.integrity_result, "ok");
        assert_eq!(verified.foreign_key_errors, 0);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn sqlite_backup_restore_replaces_database_and_keeps_it_usable() {
        let source = test_db();
        get_or_create_user(&source, "restored-card", "昨晚").unwrap();
        let path =
            std::env::temp_dir().join(format!("kxyy-memory-restore-{}.sqlite3", Uuid::new_v4()));
        source
            .execute("VACUUM INTO ?1", [path.to_string_lossy().as_ref()])
            .unwrap();

        let mut destination = test_db();
        get_or_create_user(&destination, "current-card", "今天").unwrap();
        copy_database(&path, &mut destination).unwrap();
        let integrity = finish_restored_database(&mut destination).unwrap();
        assert!(integrity.ok);
        assert_eq!(
            destination
                .query_row(
                    "SELECT COUNT(*) FROM memory_users WHERE card_id='restored-card'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        assert_eq!(
            destination
                .query_row(
                    "SELECT COUNT(*) FROM memory_users WHERE card_id='current-card'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn backup_verification_rejects_unrelated_sqlite_files() {
        let path =
            std::env::temp_dir().join(format!("kxyy-unrelated-backup-{}.sqlite3", Uuid::new_v4()));
        let unrelated = Connection::open(&path).unwrap();
        unrelated
            .execute_batch(
                "CREATE TABLE memory_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                 INSERT INTO memory_meta(key,value) VALUES('schema_version','5');",
            )
            .unwrap();
        drop(unrelated);
        assert!(verify_backup_file(&path)
            .unwrap_err()
            .contains("不是受支持的 Memory 数据库备份"));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn nickname_scope_clear_preserves_other_users_on_the_same_card() {
        let mut conn = test_db();
        get_or_create_user(&conn, "card", "小明").unwrap();
        get_or_create_user(&conn, "card", "小红").unwrap();
        clear_scope(
            &mut conn,
            &MemoryClearRequest {
                card_id: "card".into(),
                nickname: " 小明 ".into(),
            },
        )
        .unwrap();
        assert!(find_user(&conn, "card", "小明").unwrap().is_none());
        assert!(find_user(&conn, "card", "小红").unwrap().is_some());
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM memory_users", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn rebuild_derived_restores_search_and_graph_without_changing_events() {
        let mut conn = test_db();
        let user = get_or_create_user(&conn, "card", "小明").unwrap();
        conn.execute(
            "INSERT INTO memory_episodes(id,user_id,summary,topics_json,entities_json,occurred_at,created_at,updated_at)
             VALUES('episode-rebuild',?1,'准备面试','[\"产品经理\"]','[\"小明\"]',100,100,100)",
            [&user],
        )
        .unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        insert_fact(
            &tx,
            "card",
            &user,
            Some("episode-rebuild"),
            &fact("面试安排", "近期安排", "面试", "assertion"),
            now_ts(),
        )
        .unwrap();
        tx.commit().unwrap();
        let event_id = append_event(
            &conn,
            &MemoryEventInput {
                user_id: &user,
                card_id: "card",
                item_kind: "episode",
                item_id: "episode-rebuild",
                event_type: "episode.created",
                source_type: "test",
                source_id: None,
                modality: "text",
                observed_at: now_ts(),
                trust: 0.8,
                consent: "allowed",
                idempotency_key: "rebuild-event",
                payload_json: r#"{"summary":"准备面试"}"#,
            },
        )
        .unwrap();
        assert!(!event_id.is_empty());
        let events_before = scalar_count(&conn, "SELECT COUNT(*) FROM memory_events").unwrap();
        conn.execute("DELETE FROM memory_search", []).unwrap();
        conn.execute("DELETE FROM memory_edges", []).unwrap();
        let result = rebuild_derived(&mut conn).unwrap();
        assert_eq!(result.rebuilt_search_rows, 2);
        assert!(result.rebuilt_edges >= 3);
        assert_eq!(
            scalar_count(&conn, "SELECT COUNT(*) FROM memory_events").unwrap(),
            events_before
        );
        assert_eq!(
            scalar_count(&conn, "SELECT COUNT(*) FROM memory_topics").unwrap(),
            1
        );
        assert_eq!(
            scalar_count(&conn, "SELECT COUNT(*) FROM memory_entities").unwrap(),
            1
        );
        assert_eq!(
            scalar_count(&conn, "SELECT COUNT(*) FROM memory_search").unwrap(),
            2
        );
    }

    #[test]
    fn confirmations_merge_and_corrections_supersede() {
        let conn = test_db();
        let user = get_or_create_user(&conn, "card", "元宝").unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        let spicy = fact("用户喜欢吃辣", "饮食偏好", "喜欢辣", "assertion");
        insert_fact(&tx, "card", &user, None, &spicy, now_ts()).unwrap();
        insert_fact(&tx, "card", &user, None, &spicy, now_ts()).unwrap();
        let correction = fact(
            "用户最近因胃不舒服暂时不吃辣",
            "饮食偏好",
            "暂时不吃辣",
            "preferenceChange",
        );
        insert_fact(&tx, "card", &user, None, &correction, now_ts()).unwrap();
        tx.commit().unwrap();
        let old: (String, i64) = conn
            .query_row(
                "SELECT status,confirmation_count FROM memory_facts WHERE value='喜欢辣'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(old, ("superseded".into(), 2));
        let active: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM memory_facts WHERE status='active' AND value='暂时不吃辣'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(active, 1);
    }

    #[test]
    fn temporary_memory_expires_after_seven_days() {
        let conn = test_db();
        let user = get_or_create_user(&conn, "card", "元宝").unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        let mut temporary = fact("用户今天心情不好", "当前情绪", "低落", "assertion");
        temporary.durability = "temporary".into();
        insert_fact(&tx, "card", &user, None, &temporary, 1_000).unwrap();
        tx.commit().unwrap();
        let valid_to: i64 = conn
            .query_row("SELECT valid_to FROM memory_facts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(valid_to, 1_000 + 7 * 86_400);
    }

    #[test]
    fn maintenance_recovers_jobs_and_removes_expired_sources() {
        let conn = test_db();
        let user = get_or_create_user(&conn, "card", "元宝").unwrap();
        let old = now_ts() - SOURCE_RETENTION_SECS - 10;
        conn.execute(
            "INSERT INTO memory_episodes(id,user_id,summary,source_excerpt,source_expires_at,occurred_at,created_at,updated_at)
             VALUES('e',?1,'一次聊天','原话',?2,?2,?2,?2)",
            params![user,old],
        ).unwrap();
        conn.execute(
            "INSERT INTO memory_jobs(id,user_id,card_id,session_id,batch_start,batch_end,payload_json,status,next_attempt_at,created_at,updated_at)
             VALUES('j',?1,'card','s',0,1,'[]','processing',?2,?2,?2)",
            params![user,now_ts()],
        ).unwrap();
        maintenance(&conn).unwrap();
        let excerpt: Option<String> = conn
            .query_row(
                "SELECT source_excerpt FROM memory_episodes WHERE id='e'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let status: String = conn
            .query_row("SELECT status FROM memory_jobs WHERE id='j'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(excerpt.is_none());
        assert_eq!(status, "retrying");
    }

    #[test]
    fn secrets_and_long_identifiers_are_rejected() {
        assert!(is_sensitive("我的 API Key 是 sk-secret"));
        assert!(is_sensitive("身份证号 123456789012345678"));
        assert!(!is_sensitive("我下周二有一场面试"));

        let conn = test_db();
        let user = get_or_create_user(&conn, "card", "元宝").unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        let mut unsafe_fact = fact("用户提供了登录信息", "password", "secret", "assertion");
        unsafe_fact.confidence = 1.0;
        insert_fact(&tx, "card", &user, None, &unsafe_fact, now_ts()).unwrap();
        tx.commit().unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM memory_facts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn legacy_import_preserves_topics_and_timestamps_and_is_idempotent() {
        let mut conn = test_db();
        let request = MemoryLegacyRequest {
            card_id: "card".into(),
            memories: serde_json::json!({
                "alice": {
                    "nickname": "小明",
                    "topics_recent": ["产品经理面试", "简历"],
                    "sessions": [{
                        "id": "old-session",
                        "ts": "2026-07-01 12:34",
                        "summary": "一起准备了产品经理面试"
                    }],
                    "facts": ["用户正在找产品工作"],
                    "promises": [{"text": "下次继续帮用户改简历"}]
                },
                "bob": {
                    "nickname": "阿青",
                    "topics_recent": ["周末露营"],
                    "sessions": []
                }
            }),
        };
        let first = import_legacy(&mut conn, &request).unwrap();
        assert_eq!(first.affected, 4);
        let expected = NaiveDateTime::parse_from_str("2026-07-01 12:34", "%Y-%m-%d %H:%M")
            .unwrap()
            .and_utc()
            .timestamp();
        let (occurred_at, topics): (i64, String) = conn
            .query_row(
                "SELECT occurred_at,topics_json FROM memory_episodes WHERE session_id='old-session'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(occurred_at, expected);
        assert!(topics.contains("产品经理面试"));
        let synthetic: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM memory_episodes WHERE summary LIKE '旧版记录的近期话题%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(synthetic, 1);

        let second = import_legacy(&mut conn, &request).unwrap();
        assert_eq!(second.affected, 0);
        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM memory_episodes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(total, 2);
    }

    #[test]
    fn user_edits_keep_superseded_revisions_and_raise_fact_confidence() {
        let mut conn = test_db();
        let user = get_or_create_user(&conn, "card", "元宝").unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        insert_fact(
            &tx,
            "card",
            &user,
            None,
            &fact("用户喜欢辣", "饮食偏好", "喜欢辣", "assertion"),
            now_ts(),
        )
        .unwrap();
        tx.commit().unwrap();
        let id: String = conn
            .query_row("SELECT id FROM memory_facts", [], |r| r.get(0))
            .unwrap();
        update_memory(
            &mut conn,
            &MemoryUpdateRequest {
                kind: "fact".into(),
                id: id.clone(),
                text: Some("用户最近不吃辣".into()),
                pinned: None,
                status: None,
            },
        )
        .unwrap();
        let events_before_delete: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM memory_events WHERE item_kind='fact' AND item_id=?1",
                [&id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(events_before_delete >= 1);
        let (text, confidence): (String, f64) = conn
            .query_row(
                "SELECT text,confidence FROM memory_facts WHERE id=?1",
                [&id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(text, "用户最近不吃辣");
        assert_eq!(confidence, 1.0);
        let snapshot: String = conn
            .query_row(
                "SELECT snapshot_json FROM memory_revisions WHERE kind='fact' AND item_id=?1",
                [&id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(snapshot.contains("用户喜欢辣"));
    }

    #[test]
    fn pinning_does_not_change_unpinned_sort_position() {
        let mut conn = test_db();
        let user = get_or_create_user(&conn, "card", "元宝").unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        insert_fact(
            &tx,
            "card",
            &user,
            None,
            &fact("较早的记忆", "时间", "较早", "assertion"),
            now_ts(),
        )
        .unwrap();
        insert_fact(
            &tx,
            "card",
            &user,
            None,
            &fact("较新的记忆", "时间", "较新", "assertion"),
            now_ts(),
        )
        .unwrap();
        tx.commit().unwrap();
        let ids: Vec<String> = conn
            .prepare("SELECT id FROM memory_facts ORDER BY updated_at DESC")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let target = ids[1].clone();
        conn.execute(
            "UPDATE memory_facts SET updated_at=100 WHERE id=?1",
            [&target],
        )
        .unwrap();
        update_memory(
            &mut conn,
            &MemoryUpdateRequest {
                kind: "fact".into(),
                id: target.clone(),
                text: None,
                pinned: Some(true),
                status: None,
            },
        )
        .unwrap();
        update_memory(
            &mut conn,
            &MemoryUpdateRequest {
                kind: "fact".into(),
                id: target.clone(),
                text: None,
                pinned: Some(false),
                status: None,
            },
        )
        .unwrap();
        let (pinned, updated_at): (i64, i64) = conn
            .query_row(
                "SELECT pinned,updated_at FROM memory_facts WHERE id=?1",
                [&target],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(pinned, 0);
        assert_eq!(updated_at, 100);
    }

    #[test]
    fn split_batches_use_non_overlapping_absolute_boundaries() {
        let messages: Vec<_> = (0..45)
            .map(|index| MemoryMessage {
                id: format!("m{index}"),
                role: "user".into(),
                content: "一条短消息".into(),
                image_caption: String::new(),
                do_not_remember: false,
            })
            .collect();
        let chunks = chunk_memory_messages(messages);
        assert_eq!(chunks.iter().map(Vec::len).collect::<Vec<_>>(), [20, 20, 5]);
        assert_eq!(
            chunk_boundaries(100, 145, &chunks),
            [(100, 120), (120, 140), (140, 145)]
        );
    }

    #[test]
    fn commitments_merge_and_explicit_completion_stops_recall() {
        let conn = test_db();
        let user = get_or_create_user(&conn, "card", "元宝").unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        insert_commitment(
            &tx,
            "card",
            &user,
            None,
            "下次提醒用户准备产品经理面试",
            None,
            0.7,
            now_ts(),
        )
        .unwrap();
        insert_commitment(
            &tx,
            "card",
            &user,
            None,
            "记得下次提醒用户准备产品经理面试",
            None,
            0.8,
            now_ts(),
        )
        .unwrap();
        let count: i64 = tx
            .query_row("SELECT COUNT(*) FROM memory_commitments", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
        resolve_commitments_from_messages(
            &tx,
            &user,
            &[MemoryMessage {
                id: "m1".into(),
                role: "user".into(),
                content: "产品经理面试已经完成了".into(),
                image_caption: String::new(),
                do_not_remember: false,
            }],
            now_ts(),
        )
        .unwrap();
        tx.commit().unwrap();
        let status: String = conn
            .query_row("SELECT status FROM memory_commitments", [], |r| r.get(0))
            .unwrap();
        assert_eq!(status, "fulfilled");
        assert!(load_recent_candidates(&conn, &user)
            .unwrap()
            .iter()
            .all(|candidate| candidate.kind != "commitment"));
    }

    #[test]
    fn enqueue_is_idempotent_and_excludes_private_or_sensitive_messages() {
        let mut conn = test_db();
        let make_request = || MemoryEnqueueRequest {
            card_id: "card".into(),
            nickname: "元宝".into(),
            session_id: "session-1".into(),
            batch_start: 10,
            batch_end: 13,
            messages: vec![
                MemoryMessage {
                    id: "m-safe".into(),
                    role: "user".into(),
                    content: "我下周参加产品经理面试".into(),
                    image_caption: String::new(),
                    do_not_remember: false,
                },
                MemoryMessage {
                    id: "m-private".into(),
                    role: "user".into(),
                    content: "这段只是临时吐槽".into(),
                    image_caption: String::new(),
                    do_not_remember: true,
                },
                MemoryMessage {
                    id: "m-secret".into(),
                    role: "user".into(),
                    content: "我的 API Key 是 sk-secret".into(),
                    image_caption: String::new(),
                    do_not_remember: false,
                },
            ],
        };

        let first = enqueue_session(&mut conn, make_request()).unwrap();
        let second = enqueue_session(&mut conn, make_request()).unwrap();
        assert!(first.accepted);
        assert!(!first.duplicate);
        assert!(second.accepted);
        assert!(second.duplicate);

        let (count, payload, start, end): (i64, String, i64, i64) = conn
            .query_row(
                "SELECT COUNT(*),payload_json,batch_start,batch_end FROM memory_jobs",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!((start, end), (10, 13));
        assert!(payload.contains("m-safe"));
        assert!(!payload.contains("m-private"));
        assert!(!payload.contains("m-secret"));
    }

    #[test]
    fn enqueue_keeps_final_user_and_assistant_turn_for_replay() {
        let mut conn = test_db();
        let result = enqueue_session(
            &mut conn,
            MemoryEnqueueRequest {
                card_id: "card".into(),
                nickname: "元宝".into(),
                session_id: "final-turn".into(),
                batch_start: 0,
                batch_end: 2,
                messages: vec![
                    MemoryMessage {
                        id: "final-user".into(),
                        role: "user".into(),
                        content: "我下周有面试".into(),
                        image_caption: String::new(),
                        do_not_remember: false,
                    },
                    MemoryMessage {
                        id: "final-assistant".into(),
                        role: "assistant".into(),
                        content: "我会记住，下次可以问问进展".into(),
                        image_caption: String::new(),
                        do_not_remember: false,
                    },
                ],
            },
        )
        .unwrap();
        assert!(result.accepted);
        let payload: String = conn
            .query_row(
                "SELECT payload_json FROM memory_jobs WHERE id=?1",
                [&result.job_id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(payload.contains("final-user"));
        assert!(payload.contains("final-assistant"));
    }

    #[test]
    fn recall_is_scoped_relevant_and_within_budget() {
        let mut conn = test_db();
        let alice = get_or_create_user(&conn, "card-a", "小明").unwrap();
        let bob = get_or_create_user(&conn, "card-a", "阿青").unwrap();
        let other_card = get_or_create_user(&conn, "card-b", "小明").unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        insert_fact(
            &tx,
            "card-a",
            &alice,
            None,
            &fact(
                "小明下周参加产品经理面试",
                "近期安排",
                "产品经理面试",
                "assertion",
            ),
            now_ts(),
        )
        .unwrap();
        let mut unrelated = fact("小明喜欢收藏咖啡杯", "收藏偏好", "咖啡杯", "assertion");
        unrelated.importance = 1.0;
        insert_fact(&tx, "card-a", &alice, None, &unrelated, now_ts()).unwrap();
        insert_fact(
            &tx,
            "card-a",
            &bob,
            None,
            &fact(
                "阿青也在准备产品经理面试",
                "近期安排",
                "产品经理面试",
                "assertion",
            ),
            now_ts(),
        )
        .unwrap();
        insert_fact(
            &tx,
            "card-b",
            &other_card,
            None,
            &fact(
                "另一张卡记录了产品经理面试",
                "近期安排",
                "产品经理面试",
                "assertion",
            ),
            now_ts(),
        )
        .unwrap();
        insert_commitment(
            &tx,
            "card-a",
            &alice,
            None,
            "下次提醒小明更新护照照片",
            None,
            0.9,
            now_ts(),
        )
        .unwrap();
        for index in 0..8 {
            let mut candidate = fact(
                &format!("产品经理面试准备事项第 {index} 项，侧重不同案例 {index}"),
                &format!("面试准备 {index}"),
                &format!("案例 {index}"),
                "assertion",
            );
            candidate.importance = 0.6 + index as f64 * 0.02;
            insert_fact(&tx, "card-a", &alice, None, &candidate, now_ts()).unwrap();
        }
        tx.commit().unwrap();

        let result = recall_memory(
            &mut conn,
            &MemoryRecallRequest {
                card_id: "card-a".into(),
                nickname: "小明".into(),
                query: "产品经理面试该怎么准备".into(),
                reason: String::new(),
                image_caption: String::new(),
                max_items: Some(6),
            },
        )
        .unwrap();
        assert!(!result.items.is_empty());
        assert!(result.items.len() <= 6);
        assert!(result.items.iter().filter(|item| !item.pinned).count() <= 4);
        assert!(result.total_chars <= RECALL_CHAR_BUDGET);
        assert!(result.items.iter().all(|item| !item.text.contains("阿青")));
        assert!(result
            .items
            .iter()
            .all(|item| !item.text.contains("另一张卡")));
        assert!(result
            .items
            .iter()
            .all(|item| !item.text.contains("护照照片")));

        let unrelated_result = recall_memory(
            &mut conn,
            &MemoryRecallRequest {
                card_id: "card-a".into(),
                nickname: "小明".into(),
                query: "Rust 所有权和生命周期".into(),
                reason: String::new(),
                image_caption: String::new(),
                max_items: Some(6),
            },
        )
        .unwrap();
        assert!(unrelated_result.items.is_empty());
    }

    #[test]
    fn contextual_followup_uses_only_the_latest_important_episode() {
        let mut conn = test_db();
        let user = get_or_create_user(&conn, "card", "元宝").unwrap();
        let now = now_ts();
        for (id, summary, occurred_at) in [
            ("older", "元宝最近买了新的咖啡杯", now - 3_600),
            ("latest", "元宝下周要参加产品经理面试", now - 60),
        ] {
            conn.execute(
                "INSERT INTO memory_episodes(id,user_id,summary,importance,occurred_at,created_at,updated_at)
                 VALUES(?1,?2,?3,0.95,?4,?4,?4)",
                params![id, user, summary, occurred_at],
            )
            .unwrap();
            index_item(&conn, id, "episode", "card", &user, summary, "").unwrap();
        }

        let result = recall_memory(
            &mut conn,
            &MemoryRecallRequest {
                card_id: "card".into(),
                nickname: "元宝".into(),
                query: "明天有点紧张".into(),
                reason: String::new(),
                image_caption: String::new(),
                max_items: Some(6),
            },
        )
        .unwrap();
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].id, "latest");
    }

    #[test]
    fn empty_query_preloads_only_pinned_items_and_pending_commitments() {
        let mut conn = test_db();
        let user = get_or_create_user(&conn, "card", "元宝").unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        let pinned_id = insert_fact(
            &tx,
            "card",
            &user,
            None,
            &fact("元宝喜欢热茶", "饮品偏好", "喜欢热茶", "assertion"),
            now_ts(),
        )
        .unwrap()
        .unwrap();
        tx.execute("UPDATE memory_facts SET pinned=1 WHERE id=?1", [&pinned_id])
            .unwrap();
        insert_fact(
            &tx,
            "card",
            &user,
            None,
            &fact("元宝最近在准备面试", "近期安排", "准备面试", "assertion"),
            now_ts(),
        )
        .unwrap();
        insert_commitment(
            &tx,
            "card",
            &user,
            None,
            "下次提醒元宝带伞",
            None,
            0.9,
            now_ts(),
        )
        .unwrap();
        tx.execute(
            "INSERT INTO memory_episodes(id,user_id,summary,importance,topics_json,entities_json,occurred_at,created_at,updated_at)
             VALUES('recent-chat-topic',?1,'元宝最近开始学习吉他',0.8,'[\"吉他\"]','[]',?2,?2,?2)",
            params![&user, now_ts()],
        )
        .unwrap();
        tx.commit().unwrap();

        let result = recall_memory(
            &mut conn,
            &MemoryRecallRequest {
                card_id: "card".into(),
                nickname: "元宝".into(),
                query: String::new(),
                reason: String::new(),
                image_caption: String::new(),
                max_items: Some(6),
            },
        )
        .unwrap();
        assert_eq!(result.items.len(), 2);
        assert!(result.items.iter().any(|item| item.pinned));
        assert!(result.items.iter().any(|item| item.kind == "commitment"));
        assert!(result
            .items
            .iter()
            .all(|item| !item.text.contains("准备面试")));

        let proactive = recall_memory(
            &mut conn,
            &MemoryRecallRequest {
                card_id: "card".into(),
                nickname: "元宝".into(),
                query: String::new(),
                reason: "proactive-topic".into(),
                image_caption: String::new(),
                max_items: Some(3),
            },
        )
        .unwrap();
        assert!(proactive
            .items
            .iter()
            .any(|item| item.id == "recent-chat-topic"));
        assert!(proactive.items.len() <= 3);
        assert!(proactive.total_chars <= 300);
    }

    #[test]
    fn delete_and_clear_remove_revisions_search_rows_jobs_and_user_data() {
        let mut conn = test_db();
        let user = get_or_create_user(&conn, "card", "元宝").unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        insert_fact(
            &tx,
            "card",
            &user,
            None,
            &fact("元宝喜欢吃辣", "饮食偏好", "喜欢辣", "assertion"),
            now_ts(),
        )
        .unwrap();
        insert_commitment(
            &tx,
            "card",
            &user,
            None,
            "下次提醒元宝带伞",
            None,
            0.8,
            now_ts(),
        )
        .unwrap();
        tx.commit().unwrap();
        let fact_id: String = conn
            .query_row("SELECT id FROM memory_facts", [], |row| row.get(0))
            .unwrap();
        update_memory(
            &mut conn,
            &MemoryUpdateRequest {
                kind: "fact".into(),
                id: fact_id.clone(),
                text: Some("元宝最近暂时不吃辣".into()),
                pinned: None,
                status: None,
            },
        )
        .unwrap();
        enqueue_session(
            &mut conn,
            MemoryEnqueueRequest {
                card_id: "card".into(),
                nickname: "元宝".into(),
                session_id: "pending-session".into(),
                batch_start: 0,
                batch_end: 1,
                messages: vec![MemoryMessage {
                    id: "m1".into(),
                    role: "user".into(),
                    content: "周末准备去露营".into(),
                    image_caption: String::new(),
                    do_not_remember: false,
                }],
            },
        )
        .unwrap();

        delete_memory(
            &mut conn,
            &MemoryDeleteRequest {
                items: vec![MemoryItemRef {
                    kind: "fact".into(),
                    id: fact_id.clone(),
                }],
            },
        )
        .unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM memory_events WHERE item_kind='fact' AND item_id=?1",
                [&fact_id],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM memory_evidence WHERE item_kind='fact' AND item_id=?1",
                [&fact_id],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        let fact_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM memory_facts", [], |row| row.get(0))
            .unwrap();
        let revision_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM memory_revisions", [], |row| {
                row.get(0)
            })
            .unwrap();
        let fact_search_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM memory_search WHERE kind='fact'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!((fact_rows, revision_rows, fact_search_rows), (0, 0, 0));

        clear_scope(
            &mut conn,
            &MemoryClearRequest {
                card_id: "card".into(),
                nickname: "元宝".into(),
            },
        )
        .unwrap();
        for table in [
            "memory_users",
            "memory_episodes",
            "memory_facts",
            "memory_commitments",
            "memory_jobs",
            "memory_revisions",
            "memory_search",
        ] {
            let count: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 0, "{table} should be empty after clear");
        }
    }

    #[test]
    fn retry_policy_uses_backoff_and_drops_expired_payloads() {
        let mut conn = test_db();
        enqueue_session(
            &mut conn,
            MemoryEnqueueRequest {
                card_id: "card".into(),
                nickname: "元宝".into(),
                session_id: "retry-session".into(),
                batch_start: 0,
                batch_end: 1,
                messages: vec![MemoryMessage {
                    id: "m1".into(),
                    role: "user".into(),
                    content: "下周参加面试".into(),
                    image_caption: String::new(),
                    do_not_remember: false,
                }],
            },
        )
        .unwrap();
        let job = take_due_job(&mut conn).unwrap().unwrap();
        let before = now_ts();
        retry_job(&conn, &job, "模型暂时不可用").unwrap();
        let (status, attempts, next_attempt_at, error): (String, i64, i64, String) = conn
            .query_row(
                "SELECT status,attempts,next_attempt_at,last_error FROM memory_jobs WHERE id=?1",
                [&job.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(status, "retrying");
        assert_eq!(attempts, 1);
        assert!((before + 60..=now_ts() + 60).contains(&next_attempt_at));
        assert_eq!(error, "模型暂时不可用");

        conn.execute(
            "UPDATE memory_jobs SET payload_json='[]',created_at=?1 WHERE id=?2",
            params![now_ts() - JOB_RETENTION_SECS - 1, job.id],
        )
        .unwrap();
        let expired = PendingJob {
            attempts,
            created_at: now_ts() - JOB_RETENTION_SECS - 1,
            ..job
        };
        retry_job(&conn, &expired, "仍然不可用").unwrap();
        let (status, payload): (String, Option<String>) = conn
            .query_row(
                "SELECT status,payload_json FROM memory_jobs WHERE id=?1",
                [&expired.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "skipped");
        assert!(payload.is_none());
    }

    #[test]
    fn locked_database_job_remains_pending_and_recovers_after_unlock() {
        let db_path =
            std::env::temp_dir().join(format!("kxyy-memory-lock-test-{}.sqlite3", Uuid::new_v4()));
        let mut worker_conn = Connection::open(&db_path).unwrap();
        configure(&worker_conn).unwrap();
        migrate(&mut worker_conn).unwrap();
        worker_conn
            .busy_timeout(std::time::Duration::from_millis(20))
            .unwrap();
        enqueue_session(
            &mut worker_conn,
            MemoryEnqueueRequest {
                card_id: "card".into(),
                nickname: "元宝".into(),
                session_id: "locked-session".into(),
                batch_start: 0,
                batch_end: 1,
                messages: vec![MemoryMessage {
                    id: "m1".into(),
                    role: "user".into(),
                    content: "明天参加面试".into(),
                    image_caption: String::new(),
                    do_not_remember: false,
                }],
            },
        )
        .unwrap();

        let locker = Connection::open(&db_path).unwrap();
        configure(&locker).unwrap();
        locker.execute_batch("BEGIN IMMEDIATE").unwrap();
        assert!(take_due_job(&mut worker_conn).is_err());
        let status: String = worker_conn
            .query_row("SELECT status FROM memory_jobs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(status, "pending");

        locker.execute_batch("ROLLBACK").unwrap();
        let first_take = take_due_job(&mut worker_conn).unwrap().unwrap();
        assert_eq!(first_take.session_id, "locked-session");
        maintenance(&worker_conn).unwrap();
        let recovered_status: String = worker_conn
            .query_row("SELECT status FROM memory_jobs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(recovered_status, "retrying");
        assert!(take_due_job(&mut worker_conn).unwrap().is_some());

        drop(locker);
        drop(worker_conn);
        for path in [
            db_path.clone(),
            PathBuf::from(format!("{}-wal", db_path.display())),
            PathBuf::from(format!("{}-shm", db_path.display())),
        ] {
            let _ = fs::remove_file(path);
        }
    }

    #[test]
    fn newer_schema_is_rejected_without_overwriting_its_version() {
        let mut conn = Connection::open_in_memory().unwrap();
        configure(&conn).unwrap();
        conn.execute_batch(
            "CREATE TABLE memory_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
             INSERT INTO memory_meta(key,value) VALUES('schema_version','999');",
        )
        .unwrap();
        assert!(migrate(&mut conn).is_err());
        let version: String = conn
            .query_row(
                "SELECT value FROM memory_meta WHERE key='schema_version'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(version, "999");
    }
}
