use chrono::{NaiveDate, TimeZone};
use serde_json::{json, Value};

pub fn day(at: i64) -> Option<NaiveDate> {
    chrono::FixedOffset::east_opt(8 * 3600)?
        .timestamp_opt(at, 0)
        .single()
        .map(|d| d.date_naive())
}
// A source can mention several events. Never assign the first mentioned day
// to every extraction supported by that source.
fn mentioned_days(text: &str, at: i64) -> Vec<NaiveDate> {
    let mut dates = Vec::new();
    for (found, raw) in text.as_bytes().windows(10).enumerate() {
        if raw[4] == b'-' && raw[7] == b'-' {
            if let Some(date) = text
                .get(found..found + 10)
                .and_then(|raw| NaiveDate::parse_from_str(raw, "%Y-%m-%d").ok())
            {
                dates.push(date);
            }
        }
    }
    if let Some(base) = day(at) {
        for (words, offset) in [
            (&["前天"][..], -2),
            (&["昨天", "昨晚"][..], -1),
            (
                &["今天", "今晚", "今早", "现在", "刚才", "刚刚", "正在"][..],
                0,
            ),
            (&["明天", "明晚"][..], 1),
            (&["后天"][..], 2),
        ] {
            if words.iter().any(|word| text.contains(word)) {
                if let Some(date) = base.checked_add_signed(chrono::Duration::days(offset)) {
                    dates.push(date);
                }
            }
        }
    }
    dates.sort_unstable();
    dates.dedup();
    dates
}
pub fn relative_day(text: &str, at: i64) -> Option<NaiveDate> {
    let dates = mentioned_days(text, at);
    (dates.len() == 1).then(|| dates[0])
}
pub fn evidence(messages: &[crate::memory::MemoryMessage], ids: &[String], stable: bool) -> Value {
    let sources: Vec<_> = messages
        .iter()
        .filter(|m| m.role == "user" && ids.contains(&m.id))
        .collect();
    let dated: Vec<_> = sources
        .iter()
        .filter_map(|m| m.message_at.filter(|at| *at > 0).map(|at| (*m, at)))
        .collect();
    let message_at = dated.iter().map(|(_, at)| *at).min();
    let text = sources
        .iter()
        .map(|m| m.content.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let mut dates: Vec<_> = dated
        .iter()
        .flat_map(|(m, at)| mentioned_days(&m.content, *at))
        .collect();
    dates.sort_unstable();
    dates.dedup();
    let planned = ["打算", "准备", "计划", "明天", "明晚", "后天", "下周"]
        .iter()
        .any(|word| text.contains(word));
    let current = ["正在", "现在"].iter().any(|word| text.contains(word));
    let past = [
        "前天", "昨天", "昨晚", "刚才", "刚刚", "吃了", "去了", "看了", "结束", "完成",
    ]
    .iter()
    .any(|word| text.contains(word));
    let ambiguous =
        dates.len() > 1 || [planned, current, past].into_iter().filter(|v| *v).count() > 1;
    let event_date = if stable || ambiguous || dated.len() != sources.len() || dates.len() != 1 {
        None
    } else {
        Some(dates[0].to_string())
    };
    let tense = if stable {
        "stable"
    } else if ambiguous {
        "unknown"
    } else if planned {
        "planned"
    } else if current {
        "current"
    } else if past {
        "past"
    } else {
        "unknown"
    };
    json!({"eventDate":event_date,"messageAt":message_at,"tense":tense,"timeZone":"Asia/Shanghai","precision":if event_date.is_some(){"day"}else{"unknown"}})
}
pub fn event_epoch(temporal: &Value) -> Option<i64> {
    let date = NaiveDate::parse_from_str(temporal["eventDate"].as_str()?, "%Y-%m-%d").ok()?;
    chrono::FixedOffset::east_opt(8 * 3600)?
        .from_local_datetime(&date.and_hms_opt(12, 0, 0)?)
        .single()
        .map(|d| d.timestamp())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_date_survives_delayed_processing_and_relative_days() {
        let at = chrono::DateTime::parse_from_rfc3339("2026-10-28T19:30:00+08:00")
            .unwrap()
            .timestamp();
        let message = |text: &str| crate::memory::MemoryMessage {
            id: "u".into(),
            role: "user".into(),
            content: text.into(),
            image_caption: String::new(),
            do_not_remember: false,
            message_at: Some(at),
        };
        assert_eq!(
            evidence(&[message("今晚吃了汉堡")], &["u".into()], false)["eventDate"],
            "2026-10-28"
        );
        assert_eq!(
            evidence(&[message("昨天吃了汉堡")], &["u".into()], false)["eventDate"],
            "2026-10-27"
        );
        let plan = evidence(&[message("明天打算吃汉堡")], &["u".into()], false);
        assert_eq!(plan["eventDate"], "2026-10-29");
        assert_eq!(plan["tense"], "planned");
        assert!(
            evidence(&[message("以前有一次吃过汉堡")], &["u".into()], false)["eventDate"].is_null()
        );
        assert_eq!(
            evidence(&[message("我喜欢喝茶")], &["u".into()], true)["tense"],
            "stable"
        );
        let mut old = message("今晚吃了汉堡");
        old.message_at = None;
        assert!(evidence(&[old], &["u".into()], false)["eventDate"].is_null());
    }
    #[test]
    fn ambiguous_source_days_and_tenses_never_become_authoritative_event_time() {
        let at = chrono::DateTime::parse_from_rfc3339("2026-10-31T12:00:00+08:00")
            .unwrap()
            .timestamp();
        let message = |id: &str, text: &str| crate::memory::MemoryMessage {
            id: id.into(),
            role: "user".into(),
            content: text.into(),
            image_caption: String::new(),
            do_not_remember: false,
            message_at: Some(at),
        };
        for text in [
            "昨天吃了汉堡，今天准备吃面",
            "昨天吃了汉堡，明天准备吃面",
            "2026-10-29吃了汉堡，2026-10-30去了公园",
            "昨天吃了汉堡，2026-11-01准备吃面",
            "今天上午完成了任务，晚上准备去吃饭",
        ] {
            let result = evidence(&[message("u", text)], &["u".into()], false);
            assert!(result["eventDate"].is_null(), "{text}: {result}");
            assert_eq!(result["tense"], "unknown", "{text}");
            assert_eq!(result["messageAt"], at);
            assert_eq!(result["precision"], "unknown");
        }
        let result = evidence(
            &[message("a", "昨天吃了汉堡"), message("b", "明天准备吃面")],
            &["a".into(), "b".into()],
            false,
        );
        assert!(result["eventDate"].is_null());
        assert_eq!(result["tense"], "unknown");
        assert!(relative_day("昨天和今天的事情", at).is_none());
        assert!(relative_day("2026-10-29和2026-10-30", at).is_none());
        let atomic = evidence(&[message("u", "2026-10-30吃了汉堡")], &["u".into()], false);
        assert_eq!(atomic["eventDate"], "2026-10-30");
        assert_eq!(atomic["tense"], "past");
        assert_eq!(
            relative_day("昨天也就是2026-10-30吃了汉堡", at)
                .unwrap()
                .to_string(),
            "2026-10-30"
        );
    }
}

// Phone protocol accepts bounded inert text, so time is rendered before its cap.
pub fn recall_text(item: &crate::memory::MemoryRecallItem) -> String {
    let meta = item.temporal.as_ref();
    let date = meta.and_then(|t| t["eventDate"].as_str()).unwrap_or("未知");
    let tense = meta.and_then(|t| t["tense"].as_str()).unwrap_or("unknown");
    format!(
        "[事件日期:{date}；{}] {}",
        match tense {
            "planned" => "计划未证明完成",
            "stable" => "长期事实",
            _ => "原消息时的事件，不代表当前",
        },
        item.text
    )
}
pub fn current_context() -> Value {
    use chrono::Datelike;
    let now = chrono::Utc::now().with_timezone(&chrono::FixedOffset::east_opt(8 * 3600).unwrap());
    json!({"date":now.format("%Y-%m-%d").to_string(),"time":now.format("%H:%M").to_string(),"weekday":(["周一","周二","周三","周四","周五","周六","周日"][now.weekday().num_days_from_monday() as usize]),"timeZone":"Asia/Shanghai"})
}
