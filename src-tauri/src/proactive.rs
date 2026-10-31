//! Owner-bound initiative. Source text never enters the persisted scheduler state.
use serde::{Deserialize, Serialize};
// Persist a scoped digest rather than Memory identifiers, headlines or URLs.
pub fn source_key(card: &str, nickname: &str, kind: &str, content: &str) -> String {
    use sha2::{Digest, Sha256};
    let normalized: String = content
        .chars()
        .filter(|c| !c.is_whitespace())
        .take(1200)
        .collect();
    let mut hash = Sha256::new();
    for part in [card, nickname, kind, normalized.as_str()] {
        hash.update((part.len() as u64).to_be_bytes());
        hash.update(part.as_bytes());
    }
    format!("{:x}", hash.finalize())
}
pub fn safe_topic(text: &str) -> bool {
    ![
        "密码",
        "验证码",
        "银行卡",
        "身份证",
        "住址",
        "病历",
        "抑郁",
        "自杀",
        "自残",
        "性行为",
        "性生活",
        "创伤",
        "癌症",
        "诊断",
        "用药",
    ]
    .iter()
    .any(|word| text.contains(word))
}
#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Director {
    pub last_activity: i64,
    pub last_send: i64,
    pub daily_day: String,
    pub count: u8,
    pub unanswered: u8,
    pub unengaged: u8,
    pub silent: bool,
    pub used: Vec<(String, i64)>,
    pub next_check: i64,
    pub last_channel: String,
    pub deferred: Vec<(String, i64, u8)>,
    pub busy_until: i64,
}
impl Director {
    pub fn conversation_allowed(
        &self,
        mode: &str,
        start: u8,
        end: u8,
        now: i64,
        blocked: bool,
    ) -> bool {
        let hour = ((now.div_euclid(3600) + 8).rem_euclid(24)) as u8;
        let quiet = start != end
            && if start < end {
                hour >= start && hour < end
            } else {
                hour >= start || hour < end
            };
        ["natural", "active"].contains(&mode)
            && !self.silent
            && !blocked
            && !quiet
            && now >= self.busy_until
    }
    /// Fixed, text-free reasons shared by the UI and scheduler diagnostics.
    pub fn status(
        &self,
        mode: &str,
        start: u8,
        end: u8,
        now: i64,
        blocked: bool,
    ) -> (&'static str, i64) {
        if !["natural", "active"].contains(&mode) {
            return ("off", 0);
        }
        if self.silent {
            return ("paused", 0);
        }
        if blocked {
            return ("busy", 0);
        }
        if now < self.busy_until {
            return ("away", self.busy_until);
        }
        if self.unanswered >= 2 {
            return ("unanswered", 0);
        }
        let (idle, gap, budget) = if mode == "natural" {
            (45 * 60, 3 * 3600, 3)
        } else {
            (20 * 60, 90 * 60, 5)
        };
        if self.daily_day
            == crate::memory_time::day(now)
                .map(|d| d.to_string())
                .unwrap_or_default()
            && self.count >= budget
        {
            return ("budget", 0);
        }
        use chrono::Timelike;
        let hour = ((now.div_euclid(3600) + 8).rem_euclid(24)) as u8;
        if start != end
            && if start < end {
                hour >= start && hour < end
            } else {
                hour >= start || hour < end
            }
        {
            let local = chrono::DateTime::from_timestamp(now, 0)
                .unwrap_or_default()
                .with_timezone(&chrono::FixedOffset::east_opt(28800).unwrap());
            let secs = local.minute() as i64 * 60 + local.second() as i64;
            return (
                "quiet",
                now + ((end as i64 - hour as i64).rem_euclid(24)) * 3600 - secs,
            );
        }
        if now < self.last_activity + idle {
            return ("idle", self.last_activity + idle);
        }
        let gap = if self.unengaged >= 2 {
            gap * 2
        } else if self.unanswered == 1 {
            gap * 3 / 2
        } else {
            gap
        };
        let next = self.last_send + gap;
        if now < next {
            return ("cooldown", next);
        }
        if now < self.next_check {
            return ("recheck", self.next_check);
        }
        ("ready", now)
    }
    pub fn new(now: i64) -> Self {
        Self {
            last_activity: now,
            ..Self::default()
        }
    }
    pub fn restore(mut self, now: i64) -> Self {
        self.last_activity = self.last_activity.clamp(0, now);
        self.last_send = self.last_send.clamp(0, now);
        self.next_check = self.next_check.clamp(0, now + 15 * 60);
        self.busy_until = self.busy_until.clamp(0, now + 12 * 3600);
        self.count = self.count.min(5);
        self.unanswered = self.unanswered.min(2);
        self.unengaged = self.unengaged.min(5);
        let digest = |key: &str| key.len() == 64 && key.bytes().all(|b| b.is_ascii_hexdigit());
        self.used
            .retain(|(key, at)| digest(key) && *at <= now && now - *at < 7 * 86400);
        self.used.truncate(64);
        self.deferred
            .retain(|(key, until, _)| digest(key) && *until > now && *until <= now + 7 * 86400);
        self.deferred.truncate(32);
        if !["desktop", "qq"].contains(&self.last_channel.as_str()) {
            self.last_channel.clear();
        }
        self
    }
    pub fn activity(&mut self, text: &str, now: i64) {
        self.last_activity = now;
        self.unanswered = 0;
        self.unengaged = 0;
        let closing = !text.contains(['?', '？', '“', '”', '"'])
            && text.split(['，', ',', '。', '!', '！']).any(|part| {
                [
                    "先忙",
                    "我先忙",
                    "忙去了",
                    "晚点聊",
                    "先不聊",
                    "晚安",
                    "去睡了",
                    "我去睡了",
                ]
                .iter()
                .any(|s| part.trim().starts_with(s))
            });
        if closing {
            self.busy_until = now + 2 * 3600;
        }
        if ["我回来了", "继续聊", "有空了"]
            .iter()
            .any(|s| text.contains(s))
        {
            self.busy_until = 0;
        }
        if ["先别主动", "不要主动", "别主动", "别打扰", "安静点"]
            .iter()
            .any(|s| text.contains(s))
        {
            self.silent = true;
        }
        if ["可以主动", "继续主动", "恢复主动"]
            .iter()
            .any(|s| text.contains(s))
        {
            self.silent = false;
        }
    }
    pub fn eligible(
        &self,
        mode: &str,
        quiet_start: u8,
        quiet_end: u8,
        now: i64,
        blocked: bool,
    ) -> bool {
        now >= self.next_check && self.can_send(mode, quiet_start, quiet_end, now, blocked)
    }
    pub fn can_send(
        &self,
        mode: &str,
        quiet_start: u8,
        quiet_end: u8,
        now: i64,
        blocked: bool,
    ) -> bool {
        use chrono::Timelike;
        let local = chrono::DateTime::from_timestamp(now, 0)
            .unwrap_or_default()
            .with_timezone(&chrono::FixedOffset::east_opt(8 * 3600).unwrap());
        let hour = local.hour() as u8;
        let quiet = if quiet_start == quiet_end {
            false
        } else if quiet_start < quiet_end {
            hour >= quiet_start && hour < quiet_end
        } else {
            hour >= quiet_start || hour < quiet_end
        };
        let (idle, gap, budget) = match mode {
            "natural" => (45 * 60, 3 * 3600, 3),
            "active" => (20 * 60, 90 * 60, 5),
            _ => return false,
        };
        let count = if self.daily_day == local.format("%Y-%m-%d").to_string() {
            self.count
        } else {
            0
        };
        !blocked
            && !quiet
            && !self.silent
            && now >= self.busy_until
            && self.unanswered < 2
            && count < budget
            && now >= self.last_activity + idle
            && now
                >= self.last_send
                    + if self.unengaged >= 2 {
                        gap * 2
                    } else if self.unanswered == 1 {
                        gap * 3 / 2
                    } else {
                        gap
                    }
    }
    pub fn accept_source(&self, id: &str, expires: i64, now: i64) -> bool {
        !id.is_empty()
            && id.len() <= 200
            && expires > now
            && expires <= now + 7 * 86400
            && !self
                .used
                .iter()
                .any(|(key, at)| key == id && now - *at < 7 * 86400)
            && !self
                .deferred
                .iter()
                .any(|(key, until, _)| key == id && *until > now)
    }
    pub fn decline(&mut self, id: &str, expires: i64, action: &str, now: i64) {
        let attempts = self
            .deferred
            .iter()
            .find(|(key, _, _)| key == id)
            .map(|(_, _, n)| *n)
            .unwrap_or(0)
            .saturating_add(1);
        self.deferred
            .retain(|(key, until, _)| key != id && *until > now);
        self.deferred.push((
            id.into(),
            if action == "drop" || attempts >= 2 {
                expires
            } else {
                (now + 45 * 60).min(expires)
            },
            attempts,
        ));
        if self.deferred.len() > 32 {
            self.deferred.remove(0);
        }
    }
    pub fn reserve(&mut self, source: &str, now: i64) {
        let unanswered = self.unanswered;
        self.sent(source, now);
        self.unanswered = unanswered;
    }
    pub fn confirmed_contact(&mut self, expects_reply: bool) {
        self.unengaged = self.unengaged.saturating_add(1).min(5);
        if expects_reply {
            self.unanswered = self.unanswered.saturating_add(1).min(2);
        }
    }
    pub fn sent(&mut self, source: &str, now: i64) {
        let date = crate::memory_time::day(now)
            .map(|d| d.to_string())
            .unwrap_or_default();
        if self.daily_day != date {
            self.count = 0;
            self.daily_day = date;
        }
        self.count = self.count.saturating_add(1);
        self.unanswered = self.unanswered.saturating_add(1);
        self.last_send = now;
        self.used.retain(|(_, at)| now - *at < 7 * 86400);
        self.used.push((source.into(), now));
        if self.used.len() > 64 {
            self.used.drain(..self.used.len() - 64);
        }
    }
}
#[derive(Clone)]
pub struct Permit {
    pub daily_scope:String,
    pub nonce: String,
    pub lease: String,
    pub revision: u64,
    pub expires: i64,
    pub source_id: String,
    pub source_expires: i64,
    pub card_id: String,
    pub nickname: String,
    pub channel: String,
    pub kind: &'static str,
    pub sequence: u64,
}
pub struct Continuation {
    pub due: i64,
    pub expires: i64,
    pub activity: u64,
    pub source: String,
    pub scope: String,
    pub lease: String,
    pub revision: u64,
}
#[derive(Default)]
pub struct Runtime {
    pub director: Director,
    pub permit: Option<Permit>,
    pub pulse_at: i64,
    pub blocked: bool,
    pub visible: bool,
    pub reason: &'static str,
    pub decisions: std::collections::VecDeque<(&'static str, i64)>,
    pub continuation: Option<Continuation>,
    pub sequence: u64,
}
impl Runtime {
    pub fn record(&mut self, reason: &'static str, at: i64) {
        self.reason = reason;
        if self.decisions.back().is_none_or(|(r, _)| *r != reason) {
            if self.decisions.len() == 24 {
                self.decisions.pop_front();
            }
            self.decisions.push_back((reason, at));
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn at(hour: i64) -> i64 {
        chrono::DateTime::parse_from_rfc3339("2026-10-29T00:00:00+08:00")
            .unwrap()
            .timestamp()
            + hour * 3600
    }
    #[test]
    fn failed_or_unknown_reservations_do_not_mean_owner_ignored_a_question() {
        let mut d = Director::new(at(9));
        d.reserve("source", at(12));
        assert_eq!(d.unanswered, 0);
        assert_eq!(d.count, 1);
        d.confirmed_contact(false);
        assert_eq!(d.unanswered, 0);
        d.confirmed_contact(false);
        assert_eq!(d.unanswered, 0);
        assert_eq!(d.status("natural", 23, 9, at(17), false).0, "cooldown");
        d.activity("我回来了", at(17));
        assert_eq!(d.unengaged, 0);
        d.confirmed_contact(true);
        assert_eq!(d.unanswered, 1);
    }
    #[test]
    fn short_continuation_is_separate_from_idle_and_obeys_pause_quiet_and_expiry() {
        let d = Director::new(at(12));
        assert!(!d.can_send("natural", 23, 9, at(12) + 20, false));
        assert!(d.conversation_allowed("natural", 23, 9, at(12) + 20, false));
        assert!(!d.conversation_allowed("off", 23, 9, at(12) + 20, false));
        assert!(!d.conversation_allowed("natural", 23, 9, at(1), false));
        let mut d = d;
        d.activity("“晚安”是什么意思？", at(12));
        assert!(d.conversation_allowed("natural", 23, 9, at(12) + 20, false));
        d.activity("我先忙了，晚点聊", at(12));
        assert!(!d.conversation_allowed("natural", 23, 9, at(12) + 20, false));
        assert!(!d.can_send("active", 23, 9, at(12) + 30 * 60, false));
        d.activity("我回来了，继续聊", at(12) + 31 * 60);
        assert!(d.conversation_allowed("natural", 23, 9, at(12) + 31 * 60, false));
    }
    #[test]
    fn status_explains_idle_cooldown_pause_and_ready_without_content() {
        let mut d = Director::new(at(12));
        assert_eq!(d.status("off", 23, 9, at(12), false).0, "off");
        assert_eq!(
            d.status("natural", 23, 9, at(12), false),
            ("idle", at(12) + 45 * 60)
        );
        assert_eq!(d.status("natural", 23, 9, at(13), false).0, "ready");
        d.sent("opaque", at(13));
        assert_eq!(d.status("natural", 23, 9, at(14), false).0, "cooldown");
        assert_eq!(d.status("natural", 23, 9, at(14), true).0, "busy");
        d.activity("先别主动找我", at(14));
        assert_eq!(d.status("natural", 23, 9, at(15), false).0, "paused");
    }
    #[test]
    fn restored_state_discards_legacy_source_text_and_bounds_clock_skew() {
        let mut d = Director::new(i64::MAX);
        d.last_send = i64::MAX;
        d.next_check = i64::MAX;
        d.used = vec![("https://example.test/private-title".into(), at(11))];
        let restored = d.restore(at(12));
        assert_eq!(restored.last_activity, at(12));
        assert!(restored.used.is_empty());
        assert!(!restored.can_send("natural", 23, 9, at(12), false));
        assert!(!serde_json::to_string(&restored)
            .unwrap()
            .contains("private-title"));
    }
    #[test]
    fn sources_are_private_scoped_and_sensitive_topics_stay_quiet() {
        let a = source_key("role-a", "owner", "episode", "面试 进展");
        assert_eq!(a.len(), 64);
        assert!(!a.contains("面试"));
        assert_eq!(a, source_key("role-a", "owner", "episode", "面试进展"));
        assert_ne!(a, source_key("role-b", "owner", "episode", "面试进展"));
        assert_ne!(a, source_key("role-a", "other", "episode", "面试进展"));
        assert!(!safe_topic("昨天提过抑郁症的事情"));
        assert!(!safe_topic("银行卡密码"));
        assert!(safe_topic("下周面试进展"));
    }
    #[test]
    fn quiet_budget_unanswered_and_resume_are_enforced_at_send_time() {
        let mut d = Director::new(at(9));
        assert!(!d.eligible("off", 23, 9, at(12), false));
        assert!(!d.eligible("natural", 23, 9, at(1), false));
        assert!(!d.eligible("natural", 23, 9, at(12), true));
        assert!(d.eligible("natural", 23, 9, at(12), false));
        d.sent("source-a", at(12));
        assert!(!d.eligible("natural", 23, 9, at(13), false));
        assert!(d.eligible("natural", 23, 9, at(17), false));
        d.sent("source-b", at(17));
        assert!(!d.eligible("natural", 23, 9, at(20), false));
        d.activity("你好", at(20));
        assert!(d.eligible("natural", 23, 9, at(21), false));
        d.activity("先别主动找我", at(21));
        assert!(!d.eligible("natural", 23, 9, at(22), false));
        d.activity("可以主动找我", at(22));
        assert!(!d.silent);
    }
    #[test]
    fn unanswered_backoff_and_wait_drop_survive_restart() {
        let mut d = Director::new(at(9));
        d.sent("a", at(12));
        assert!(!d.eligible("natural", 23, 9, at(16), false));
        assert!(d.eligible("natural", 23, 9, at(17), false));
        d.decline("b", at(20), "wait", at(17));
        assert!(!d.accept_source("b", at(20), at(17)));
        assert!(d.accept_source("b", at(20), at(18)));
        d.decline("b", at(20), "drop", at(18));
        let restored: Director = serde_json::from_str(&serde_json::to_string(&d).unwrap()).unwrap();
        assert!(!restored.accept_source("b", at(20), at(19)));
    }
    #[test]
    fn expired_repeated_and_unverified_candidates_never_issue_permits() {
        let mut d = Director::new(at(9));
        assert!(!d.accept_source("old", at(10), at(12)));
        assert!(d.accept_source("fresh", at(13), at(12)));
        d.sent("fresh", at(12));
        assert!(!d.accept_source("fresh", at(20), at(16)));
        let saved = serde_json::to_string(&d).unwrap();
        assert!(!saved.contains("nonce"));
        let restored: Director = serde_json::from_str(&saved).unwrap();
        assert_eq!(restored.unanswered, 1);
    }
}
