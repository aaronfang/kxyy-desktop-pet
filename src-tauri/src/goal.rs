//! User-controlled goals and TODOs. This is workflow state, not learned Memory.
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

pub const MAX_GOALS: usize = 128;
pub const MAX_LONG_TERM_GOALS: usize = 64;
pub const MAX_TODOS: usize = 128;
pub const MAX_TITLE_CHARS: usize = 120;
pub const MAX_DESCRIPTION_CHARS: usize = 1000;
pub const MAX_SCOPE_CHARS: usize = 160;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GoalKind {
    LongTermGoal,
    Todo,
}
impl Default for GoalKind {
    fn default() -> Self {
        Self::LongTermGoal
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GoalStatus {
    Active,
    Paused,
    Completed,
    Cancelled,
    Expired,
    InProgress,
    Blocked,
    Done,
}
impl Default for GoalStatus {
    fn default() -> Self {
        Self::Active
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Goal {
    pub id: String,
    #[serde(default)] pub revision: u64,
    pub title: String,
    #[serde(default)] pub scope: String,
    #[serde(default)]
    pub kind: GoalKind,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub due_at_ms: Option<u64>,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub source_ref: Option<String>,
    #[serde(default)]
    pub reminder_policy: ReminderPolicy,
    #[serde(default)]
    pub completed_at_ms: Option<u64>,
    #[serde(default)]
    pub cancelled_at_ms: Option<u64>,
    #[serde(default = "schema_version")]
    pub schema_version: u8,
    #[serde(default)]
    pub status: GoalStatus,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}
fn schema_version() -> u8 {
    2
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReminderPolicy {
    Never,
    ManualOnly,
    AllowedWhenRelevant,
}
impl Default for ReminderPolicy {
    fn default() -> Self {
        Self::ManualOnly
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransitionError {
    NotFound,
    InvalidTransition,
    StaleRevision,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalMutationResult {
    pub ok: bool,
    pub not_found: bool,
    pub invalid_transition: bool,
    pub expired: bool,
    pub stale_revision: bool,
}
impl GoalMutationResult {
    pub fn ok() -> Self { Self { ok: true, not_found: false, invalid_transition: false, expired: false, stale_revision: false } }
    pub fn error(error: TransitionError) -> Self { Self { ok: false, not_found: error == TransitionError::NotFound, invalid_transition: error == TransitionError::InvalidTransition, expired: false, stale_revision: false } }
}

pub struct GoalState {
    path: PathBuf,
    goals: Mutex<Vec<Goal>>,
}
impl GoalState {
    pub fn open(path: PathBuf) -> Self {
        let mut goals: Vec<Goal> = fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        for goal in &mut goals { if goal.scope.trim().is_empty() { goal.scope = "default".into(); } }
        Self {
            path,
            goals: Mutex::new(goals),
        }
    }
    pub fn list(&self, kind: Option<GoalKind>, status: Option<GoalStatus>, scope: Option<&str>, include_expired: bool) -> Vec<Goal> {
        self.goals
            .lock()
            .unwrap()
            .iter()
            .filter(|g| {
                    kind.map_or(true, |k| g.kind == k)
                    && status.map_or(true, |s| g.status == s)
                    && scope.map_or(true, |s| s.is_empty() || g.scope == s)
                    && (include_expired || g.status != GoalStatus::Expired)
            })
            .cloned()
            .collect()
    }

    /// Dry-run reminder candidates. This never changes goal state and excludes expired items.
    pub fn reminder_candidates(&self, now: u64) -> Vec<Goal> {
        let mut items: Vec<_> = self.goals.lock().unwrap().iter().filter(|g| {
            matches!(g.reminder_policy, ReminderPolicy::AllowedWhenRelevant)
                && matches!(g.status, GoalStatus::Active | GoalStatus::InProgress)
                && g.due_at_ms.is_none_or(|due| due >= now)
        }).cloned().collect();
        items.sort_by_key(|g| g.due_at_ms.unwrap_or(u64::MAX));
        items.truncate(1);
        items
    }
    pub fn upsert(&self, goal: Goal) -> std::io::Result<()> {
        validate(&goal).map_err(io_error)?;
        let mut g = self.goals.lock().unwrap();
        let mut next = g.clone();
        upsert(&mut next, goal);
        persist(&self.path, &next)?;
        *g = next;
        Ok(())
    }
    pub fn update_checked(&self, mut goal: Goal) -> Result<(), TransitionError> {
        let mut goals = self.goals.lock().unwrap();
        let Some(current) = goals.iter().find(|item| item.id == goal.id).cloned() else { return Err(TransitionError::NotFound); };
        if goal.revision != current.revision { return Err(TransitionError::StaleRevision); }
        goal.revision = current.revision.saturating_add(1);
        validate(&goal).map_err(|_| TransitionError::InvalidTransition)?;
        let mut next = goals.clone();
        upsert(&mut next, goal);
        persist(&self.path, &next).map_err(|_| TransitionError::InvalidTransition)?;
        *goals = next;
        Ok(())
    }
    pub fn transition(
        &self,
        id: &str,
        status: GoalStatus,
        now: u64,
    ) -> Result<bool, TransitionError> {
        let mut g = self.goals.lock().unwrap();
        let Some(current) = g.iter().find(|x| x.id == id) else {
            return Err(TransitionError::NotFound);
        };
        if !valid_transition(current.kind, current.status, status) {
            return Err(TransitionError::InvalidTransition);
        }
        let mut next = g.clone();
        let x = next.iter_mut().find(|x| x.id == id).expect("goal exists in cloned state");
        x.status = status;
        x.revision = x.revision.saturating_add(1);
        x.updated_at_ms = now;
        if status == GoalStatus::Completed || status == GoalStatus::Done {
            x.completed_at_ms = Some(now);
        }
        if status == GoalStatus::Cancelled {
            x.cancelled_at_ms = Some(now);
        }
        persist(&self.path, &next).map_err(|_| TransitionError::InvalidTransition)?;
        *g = next;
        Ok(true)
    }
    pub fn delete(&self, id: &str) -> std::io::Result<bool> {
        let mut g = self.goals.lock().unwrap();
        if !g.iter().any(|x| x.id == id) {
            return Ok(false);
        }
        let mut next = g.clone();
        next.retain(|x| x.id != id);
        persist(&self.path, &next)?;
        *g = next;
        Ok(true)
    }
}
fn io_error(s: String) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidInput, s)
}
fn validate(g: &Goal) -> Result<(), String> {
    if g.id.trim().is_empty() {
        return Err("目标 ID 不能为空".into());
    }
    if g.title.trim().is_empty() {
        return Err("标题不能为空".into());
    }
    if g.title.chars().count() > MAX_TITLE_CHARS {
        return Err("标题过长".into());
    }
    if g.scope.chars().count() > MAX_SCOPE_CHARS || g.scope.chars().any(|c| c.is_control()) {
        return Err("目标 scope 无效".into());
    }
    if g.description.chars().count() > MAX_DESCRIPTION_CHARS {
        return Err("描述过长".into());
    }
    if let Some(due) = g.due_at_ms {
        if due == 0 || due < g.created_at_ms || due.saturating_sub(g.created_at_ms) > 10 * 365 * 24 * 60 * 60 * 1000 {
            return Err("截止时间超出允许范围".into());
        }
    }
    if !matches!(g.status, GoalStatus::Active | GoalStatus::Paused | GoalStatus::Completed | GoalStatus::Cancelled | GoalStatus::Expired)
        && g.kind == GoalKind::LongTermGoal
    { return Err("长期目标状态无效".into()); }
    Ok(())
}
fn valid_transition(kind: GoalKind, from: GoalStatus, to: GoalStatus) -> bool {
    if from == to {
        return true;
    }
    match kind {
        GoalKind::LongTermGoal => matches!(
            (from, to),
            (
                GoalStatus::Active,
                GoalStatus::Paused
                    | GoalStatus::Completed
                    | GoalStatus::Cancelled
                    | GoalStatus::Expired
            ) | (
                GoalStatus::Paused,
                GoalStatus::Active | GoalStatus::Completed | GoalStatus::Cancelled | GoalStatus::Expired
            ) | (
                GoalStatus::Completed | GoalStatus::Cancelled,
                GoalStatus::Active | GoalStatus::Paused
            ) | (GoalStatus::Expired, GoalStatus::Active)
        ),
        GoalKind::Todo => matches!(
            (from, to),
            (
                GoalStatus::Active,
                GoalStatus::InProgress
                    | GoalStatus::Done
                    | GoalStatus::Blocked
                    | GoalStatus::Cancelled
                    | GoalStatus::Expired
            ) | (
                GoalStatus::InProgress,
                GoalStatus::Done
                    | GoalStatus::Blocked
                    | GoalStatus::Cancelled
                    | GoalStatus::Expired
            ) | (
                GoalStatus::Blocked,
                GoalStatus::InProgress | GoalStatus::Done | GoalStatus::Cancelled | GoalStatus::Expired
            ) | (
                GoalStatus::Done | GoalStatus::Cancelled,
                GoalStatus::Active | GoalStatus::InProgress | GoalStatus::Blocked
            ) | (GoalStatus::Expired, GoalStatus::Active)
        ),
    }
}
fn persist(path: &PathBuf, goals: &[Goal]) -> std::io::Result<()> {
    if let Some(p) = path.parent() {
        fs::create_dir_all(p)?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec(goals).unwrap())?;
    fs::rename(tmp, path)
}
pub fn upsert(goals: &mut Vec<Goal>, goal: Goal) {
    goals.retain(|x| x.id != goal.id);
    goals.insert(0, goal);
    let mut long_count = 0usize;
    let mut todo_count = 0usize;
    goals.retain(|item| {
        let keep = match item.kind {
            GoalKind::LongTermGoal => { long_count += 1; long_count <= MAX_LONG_TERM_GOALS }
            GoalKind::Todo => { todo_count += 1; todo_count <= MAX_TODOS }
        };
        keep
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn g(id: &str) -> Goal {
        Goal {
            id: id.into(),
            title: "t".into(),
            scope: "default".into(),
            created_at_ms: 1,
            updated_at_ms: 1,
            ..Default::default()
        }
    }
    impl Default for Goal {
        fn default() -> Self {
            Self {
                id: String::new(),
                revision: 0,
                title: String::new(),
                scope: "default".into(),
                kind: GoalKind::LongTermGoal,
                description: String::new(),
                due_at_ms: None,
                source: String::new(),
                source_ref: None,
                reminder_policy: ReminderPolicy::ManualOnly,
                completed_at_ms: None,
                cancelled_at_ms: None,
                schema_version: 2,
                status: GoalStatus::Active,
                created_at_ms: 0,
                updated_at_ms: 0,
            }
        }
    }
    #[test]
    fn bounded_and_idempotent() {
        let mut v = Vec::new();
        upsert(&mut v, g("a"));
        let mut x = g("a");
        x.title = "new".into();
        upsert(&mut v, x);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].title, "new");
    }
    #[test]
    fn todo_rejects_goal_status_and_allows_explicit_terminal_reopen() {
        assert!(!valid_transition(
            GoalKind::Todo,
            GoalStatus::Active,
            GoalStatus::Completed
        ));
        assert!(valid_transition(
            GoalKind::LongTermGoal,
            GoalStatus::Completed,
            GoalStatus::Active
        ));
        assert!(valid_transition(GoalKind::Todo, GoalStatus::Done, GoalStatus::Active));
    }
    #[test]
    fn validates_title_and_defaults() {
        let mut x = g("x");
        x.title = " ".into();
        assert!(validate(&x).is_err());
        assert_eq!(Goal::default().reminder_policy, ReminderPolicy::ManualOnly);
        let mut dated = g("dated");
        dated.created_at_ms = 1_000;
        dated.due_at_ms = Some(500);
        assert!(validate(&dated).is_err());
        dated.due_at_ms = Some(1_000 + 10 * 365 * 24 * 60 * 60 * 1000 + 1);
        assert!(validate(&dated).is_err());
    }

    #[test]
    fn long_term_and_todo_limits_are_independent() {
        let mut goals = Vec::new();
        for i in 0..(MAX_LONG_TERM_GOALS + 3) { upsert(&mut goals, g(&format!("g{i}"))); }
        for i in 0..(MAX_TODOS + 3) { let mut item = g(&format!("t{i}")); item.kind = GoalKind::Todo; upsert(&mut goals, item); }
        assert_eq!(goals.iter().filter(|g| g.kind == GoalKind::LongTermGoal).count(), MAX_LONG_TERM_GOALS);
        assert_eq!(goals.iter().filter(|g| g.kind == GoalKind::Todo).count(), MAX_TODOS);
    }

    #[test]
    fn reminder_candidates_are_opt_in_active_unexpired_and_bounded() {
        let path = std::env::temp_dir().join(format!("kxyy-goal-reminder-{}.json", std::process::id()));
        let state = GoalState::open(path.clone());
        let mut allowed = g("allowed"); allowed.reminder_policy = ReminderPolicy::AllowedWhenRelevant; allowed.due_at_ms = Some(2_000); state.upsert(allowed).unwrap();
        let mut manual = g("manual"); manual.reminder_policy = ReminderPolicy::ManualOnly; state.upsert(manual).unwrap();
        let mut expired = g("expired"); expired.reminder_policy = ReminderPolicy::AllowedWhenRelevant; expired.due_at_ms = Some(500); state.upsert(expired).unwrap();
        let candidates = state.reminder_candidates(1_000);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].id, "allowed");
        let _ = std::fs::remove_file(path);
    }
    #[test]
    fn stale_revision_cannot_overwrite_newer_goal() {
        let path = std::env::temp_dir().join(format!("kxyy-goal-test-{}.json", std::process::id()));
        let state = GoalState::open(path.clone());
        state.upsert(g("a")).unwrap();
        let mut current = state.list(None, None, None, true).remove(0);
        let mut stale = current.clone(); stale.title = "stale".into(); stale.revision = 99;
        assert_eq!(state.update_checked(stale), Err(TransitionError::StaleRevision));
        current.title = "fresh".into();
        state.update_checked(current).unwrap();
        assert_eq!(state.list(None, None, None, true)[0].revision, 1);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn failed_persist_does_not_mutate_in_memory_state() {
        let blocker = std::env::temp_dir().join(format!("kxyy-goal-blocker-{}", std::process::id()));
        std::fs::write(&blocker, b"not a directory").unwrap();
        let state = GoalState::open(blocker.join("goals.json"));
        let result = state.upsert(g("failed"));
        assert!(result.is_err());
        assert!(state.list(None, None, None, true).is_empty());
        let _ = std::fs::remove_file(blocker);
    }
}
