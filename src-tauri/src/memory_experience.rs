//! Explicit user writes and read-only projections over the existing Memory store.
use super::*;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RememberRequest {
    pub card_id: String,
    pub nickname: String,
    pub message_id: String,
    pub message: String,
    pub lease: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RememberReceipt {
    pub stored: bool,
    pub duplicate: bool,
    pub item_id: String,
}

pub(super) fn invalidate_write_leases(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute("INSERT INTO memory_meta(key,value) VALUES('explicit-write-epoch',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [Uuid::new_v4().to_string()])?;
    Ok(())
}
#[tauri::command]
pub fn memory_write_lease(state: State<'_, MemoryState>) -> Result<String, String> {
    let guard = state.conn.lock().unwrap();
    let conn = guard.as_ref().ok_or("记忆数据库不可用")?;
    conn.execute(
        "INSERT OR IGNORE INTO memory_meta(key,value) VALUES('explicit-write-epoch',?1)",
        [Uuid::new_v4().to_string()],
    )
    .map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT value FROM memory_meta WHERE key='explicit-write-epoch'",
        [],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn memory_remember_explicit(
    state: State<'_, MemoryState>,
    request: RememberRequest,
) -> Result<RememberReceipt, String> {
    let mut guard = state.conn.lock().unwrap();
    remember(guard.as_mut().ok_or("记忆数据库不可用")?, &request)
}

fn remember(conn: &mut Connection, request: &RememberRequest) -> Result<RememberReceipt, String> {
    let message = request.message.trim();
    let body = ["请你记住", "请记住", "帮我记住", "记住"]
        .iter()
        .find_map(|prefix| {
            let rest = message.strip_prefix(prefix)?;
            if !rest.starts_with(|c: char| c.is_whitespace() || "：:,，".contains(c)) {
                return None;
            }
            Some(
                rest.trim_start_matches(|c: char| c.is_whitespace() || "：:,，".contains(c))
                    .trim(),
            )
        })
        .ok_or("需要当前用户明确的记住请求")?;
    if request.nickname.trim().is_empty()
        || request.nickname.chars().count() > 80
        || request.card_id.chars().count() > 120
        || request.message_id.is_empty()
        || request.message_id.len() > 120
        || body.is_empty()
        || body.chars().count() > 500
        || body.chars().any(char::is_control)
        || is_sensitive(message)
    {
        return Err("记忆内容为空、过长、包含敏感信息或缺少身份".into());
    }
    let now = now_ts();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let lease: Option<String> = tx
        .query_row(
            "SELECT value FROM memory_meta WHERE key='explicit-write-epoch'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if lease.as_deref() != Some(request.lease.as_str()) || request.lease.is_empty() {
        return Err("保存请求已因删除、清空或恢复而失效".into());
    }
    let user =
        get_or_create_user(&tx, &request.card_id, &request.nickname).map_err(|e| e.to_string())?;
    let key = format!("user-explicit:{user}:{}", request.message_id);
    let existing = tx
        .query_row(
            "SELECT item_id FROM memory_events WHERE idempotency_key=?1",
            [&key],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(id) = existing {
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM memory_facts WHERE id=?1 AND user_id=?2)",
                params![id, user],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !exists {
            return Err("记忆已删除".into());
        }
        return Ok(RememberReceipt {
            stored: true,
            duplicate: true,
            item_id: id,
        });
    }
    let id = Uuid::new_v4().to_string();
    let text = format!("用户自述：{body}");
    let predicate = format!("用户陈述:{body}");
    tx.execute("INSERT INTO memory_facts(id,user_id,text,predicate,value,confidence,importance,durability,status,valid_from,first_seen_at,last_confirmed_at,created_at,updated_at)
        VALUES(?1,?2,?3,?6,?4,1.0,0.8,'stable','active',?5,?5,?5,?5,?5)", params![id,user,text,body,now,predicate]).map_err(|e| e.to_string())?;
    let payload = serde_json::json!({"text":text,"predicate":predicate,"value":body,"confidence":1.0,"importance":0.8,"durability":"stable","status":"active","validFrom":now}).to_string();
    let event = append_event(
        &tx,
        &MemoryEventInput {
            user_id: &user,
            card_id: &request.card_id,
            item_kind: "fact",
            item_id: &id,
            event_type: "fact.created",
            source_type: "user-explicit",
            source_id: Some(&request.message_id),
            modality: "text",
            observed_at: now,
            trust: 1.0,
            consent: "explicit",
            idempotency_key: &key,
            payload_json: &payload,
        },
    )
    .map_err(|e| e.to_string())?;
    append_evidence(
        &tx,
        &event,
        "fact",
        &id,
        "stated_by",
        &[request.message_id.clone()],
        Some(body),
        now,
    )
    .map_err(|e| e.to_string())?;
    rebuild_search_item(&tx, "fact", &id).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(RememberReceipt {
        stored: true,
        duplicate: false,
        item_id: id,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectionRequest {
    pub card_id: String,
    pub nickname: String,
    pub kind: String,
    #[serde(default)]
    pub query: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionItem {
    pub id: String,
    pub kind: String,
    pub text: String,
    pub source_event_ids: Vec<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Projection {
    pub kind: String,
    pub items: Vec<ProjectionItem>,
}
#[tauri::command]
pub fn memory_projection(
    state: State<'_, MemoryState>,
    request: ProjectionRequest,
) -> Result<Projection, String> {
    let guard = state.conn.lock().unwrap();
    project(guard.as_ref().ok_or("记忆数据库不可用")?, &request)
}
fn project(conn: &Connection, request: &ProjectionRequest) -> Result<Projection, String> {
    if request.nickname.trim().is_empty()
        || !["profile", "topic", "handoff"].contains(&request.kind.as_str())
        || request.query.chars().count() > 80
        || (request.kind == "topic" && request.query.trim().is_empty())
    {
        return Err("请选择明确昵称、快照类型与最多80字主题".into());
    }
    let mut result = Projection {
        kind: request.kind.clone(),
        items: vec![],
    };
    let Some(user) =
        find_user(conn, &request.card_id, &request.nickname).map_err(|e| e.to_string())?
    else {
        return Ok(result);
    };
    let mut candidates = load_recent_candidates(conn, &user).map_err(|e| e.to_string())?;
    if request.kind == "topic" {
        candidates.extend(
            search_candidates(conn, &request.card_id, &user, &request.query)
                .map_err(|e| e.to_string())?,
        );
    }
    candidates.sort_by(|a, b| {
        b.pinned
            .cmp(&a.pinned)
            .then(b.updated_at.cmp(&a.updated_at))
    });
    let query = request.query.trim().to_lowercase();
    let mut seen = HashSet::new();
    let mut remaining = 1000;
    for item in candidates {
        if is_sensitive(&item.text) || !seen.insert((item.kind.clone(), item.id.clone())) {
            continue;
        }
        if item.kind == "commitment" {
            let live: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM memory_commitments WHERE id=?1 AND user_id=?2 AND status='pending' AND (due_at IS NULL OR due_at>=?3))",
                params![item.id,user,now_ts()], |r| r.get(0)).map_err(|e| e.to_string())?;
            if !live {
                continue;
            }
        }
        let active = match item.kind.as_str() {
            "fact" => item.status == "active",
            "commitment" => item.status == "pending",
            "episode" => true,
            _ => false,
        };
        if !active
            || (request.kind == "profile" && (item.kind != "fact" || item.confidence < 0.6))
            || (request.kind == "handoff" && item.kind == "fact")
            || (request.kind == "topic"
                && !format!("{} {}", item.text, item.tags)
                    .to_lowercase()
                    .contains(&query))
        {
            continue;
        }
        let text = truncate_chars(&item.text, remaining.min(500));
        if text.is_empty() || result.items.len() >= 8 {
            break;
        }
        remaining -= text.chars().count();
        let mut stmt = conn.prepare("SELECT id FROM memory_events WHERE user_id=?1 AND item_kind=?2 AND item_id=?3 ORDER BY created_at DESC,rowid DESC LIMIT 4").map_err(|e| e.to_string())?;
        let ids = stmt
            .query_map(params![user, item.kind, item.id], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<String>, _>>()
            .map_err(|e| e.to_string())?;
        result.items.push(ProjectionItem {
            id: item.id,
            kind: item.kind,
            text,
            source_event_ids: ids,
        });
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        configure(&conn).unwrap();
        migrate(&mut conn).unwrap();
        conn.execute(
            "INSERT INTO memory_meta(key,value) VALUES('explicit-write-epoch','fixture-lease')",
            [],
        )
        .unwrap();
        conn
    }
    fn request() -> RememberRequest {
        RememberRequest {
            card_id: "card-a".into(),
            nickname: "小明".into(),
            message_id: "user-1".into(),
            message: "请记住：我喜欢喝茶".into(),
            lease: "fixture-lease".into(),
        }
    }
    #[test]
    fn explicit_write_is_durable_idempotent_scoped_and_replayable() {
        let mut conn = db();
        let request = request();
        let first = remember(&mut conn, &request).unwrap();
        assert!(first.stored);
        assert!(!first.duplicate);
        assert!(remember(&mut conn, &request).unwrap().duplicate);
        let events: i64 = conn.query_row("SELECT COUNT(*) FROM memory_events WHERE source_type='user-explicit' AND consent='explicit'", [], |r| r.get(0)).unwrap();
        assert_eq!(events, 1);
        rebuild_from_events(
            &mut conn,
            &MemoryRebuildEventsRequest {
                card_id: "card-a".into(),
                nickname: Some("小明".into()),
            },
        )
        .unwrap();
        let user = find_user(&conn, "card-a", "小明").unwrap().unwrap();
        let text: String = conn
            .query_row(
                "SELECT text FROM memory_facts WHERE id=?1 AND user_id=?2",
                params![first.item_id, user],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(text, "用户自述：我喜欢喝茶");
        let other = remember(
            &mut conn,
            &RememberRequest {
                card_id: "card-b".into(),
                ..request
            },
        )
        .unwrap();
        assert_ne!(other.item_id, first.item_id);
        delete_memory(
            &mut conn,
            &MemoryDeleteRequest {
                items: vec![MemoryItemRef {
                    kind: "fact".into(),
                    id: first.item_id,
                }],
            },
        )
        .unwrap();
        assert_eq!(
            scalar_count(&conn, "SELECT COUNT(*) FROM memory_facts").unwrap(),
            1
        );
    }
    #[test]
    fn projections_are_scoped_bounded_traceable_and_follow_deletion() {
        let mut conn = db();
        let written = remember(&mut conn, &request()).unwrap();
        let req = ProjectionRequest {
            card_id: "card-a".into(),
            nickname: "小明".into(),
            kind: "profile".into(),
            query: "".into(),
        };
        let profile = project(&conn, &req).unwrap();
        assert_eq!(profile.items.len(), 1);
        assert_eq!(profile.items[0].id, written.item_id);
        assert_eq!(profile.items[0].source_event_ids.len(), 1);
        assert!(project(
            &conn,
            &ProjectionRequest {
                card_id: "card-b".into(),
                ..req
            }
        )
        .unwrap()
        .items
        .is_empty());
        let topic = ProjectionRequest {
            card_id: "card-a".into(),
            nickname: "小明".into(),
            kind: "topic".into(),
            query: "喝茶".into(),
        };
        assert_eq!(project(&conn, &topic).unwrap().items.len(), 1);
        assert!(project(
            &conn,
            &ProjectionRequest {
                query: "%".into(),
                ..topic
            }
        )
        .unwrap()
        .items
        .is_empty());
        assert!(project(
            &conn,
            &ProjectionRequest {
                card_id: "card-a".into(),
                nickname: "".into(),
                kind: "profile".into(),
                query: "".into()
            }
        )
        .is_err());
        delete_memory(
            &mut conn,
            &MemoryDeleteRequest {
                items: vec![MemoryItemRef {
                    kind: "fact".into(),
                    id: written.item_id,
                }],
            },
        )
        .unwrap();
        assert!(project(
            &conn,
            &ProjectionRequest {
                card_id: "card-a".into(),
                nickname: "小明".into(),
                kind: "profile".into(),
                query: "".into()
            }
        )
        .unwrap()
        .items
        .is_empty());
    }

    #[test]
    fn handoff_excludes_expired_commitments_without_running_maintenance() {
        let mut conn = db();
        remember(&mut conn, &request()).unwrap();
        let user = find_user(&conn, "card-a", "小明").unwrap().unwrap();
        for (id, due) in [
            ("old", Some(now_ts() - 1)),
            ("future", Some(now_ts() + 1000)),
            ("open", None),
        ] {
            conn.execute("INSERT INTO memory_commitments(id,user_id,text,due_at,status,created_at,updated_at) VALUES(?1,?2,?1,?3,'pending',?4,?4)", params![id,user,due,now_ts()]).unwrap();
        }
        let result = project(
            &conn,
            &ProjectionRequest {
                card_id: "card-a".into(),
                nickname: "小明".into(),
                kind: "handoff".into(),
                query: "".into(),
            },
        )
        .unwrap();
        assert_eq!(result.items.len(), 2);
        assert!(!result.items.iter().any(|x| x.id == "old"));
    }

    #[test]
    fn clear_invalidates_waiting_explicit_writes_at_database_boundary() {
        let mut conn = db();
        let req = request();
        clear_scope(
            &mut conn,
            &MemoryClearRequest {
                card_id: "card-a".into(),
                nickname: "小明".into(),
            },
        )
        .unwrap();
        assert!(remember(&mut conn, &req).is_err());
        assert_eq!(
            scalar_count(&conn, "SELECT COUNT(*) FROM memory_users").unwrap(),
            0
        );
    }
    #[test]
    fn independent_explicit_statements_do_not_share_a_conflict_key() {
        let mut conn = db();
        remember(&mut conn, &request()).unwrap();
        remember(
            &mut conn,
            &RememberRequest {
                message_id: "user-2".into(),
                message: "请记住：我不吃香菜".into(),
                ..request()
            },
        )
        .unwrap();
        let result = recall_memory(
            &mut conn,
            &MemoryRecallRequest {
                card_id: "card-a".into(),
                nickname: "小明".into(),
                query: "喜欢喝茶 不吃香菜".into(),
                reason: "".into(),
                image_caption: "".into(),
                max_items: Some(6),
            },
        )
        .unwrap();
        assert_eq!(result.items.len(), 2);
        assert_ne!(result.items[0].conflict_key, result.items[1].conflict_key);
    }

    #[test]
    fn explicit_write_rejects_implicit_sensitive_empty_and_oversized_input() {
        let mut conn = db();
        for text in [
            "我喜欢茶".into(),
            "别记住：这段".into(),
            "请记住：".into(),
            "记住：我的密码是abc".into(),
            format!("记住：{}", "字".repeat(601)),
        ] {
            assert!(remember(
                &mut conn,
                &RememberRequest {
                    message: text,
                    ..request()
                }
            )
            .is_err());
        }
        assert!(remember(
            &mut conn,
            &RememberRequest {
                nickname: "".into(),
                ..request()
            }
        )
        .is_err());
        assert_eq!(
            scalar_count(&conn, "SELECT COUNT(*) FROM memory_facts").unwrap(),
            0
        );
    }
}
