//! Bounded companion activities. Only scoped fingerprints and fixed progress states persist.
use serde::{Deserialize, Serialize};
const CATEGORIES: &[&str] = &[
    "general",
    "science",
    "work-growth",
    "film-tv",
    "games",
    "technology",
    "music",
    "books",
    "daily-life",
    "food",
    "travel",
    "sports",
    "commitment",
    "episode",
];
fn digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Goal {
    pub scope: String,
    pub category: String,
    pub step: String,
    pub observed: u32,
    pub shared: u32,
    pub last_observed: i64,
    pub last_shared: i64,
    pub last_feedback: i64,
    pub last_reviewed: i64,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Observation {
    scope: String,
    id: String,
    category: String,
    at: i64,
    reviewed: i64,
    attempts: u8,
    state: String,
}
#[derive(Clone,Default,Serialize,Deserialize)]
#[serde(default)]
struct DailyContact {scope:String,day:String,plans:u8,state:String}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ActivityBook {
    pub goals: Vec<Goal>,
    observations: Vec<Observation>,
    day: String,
    reviews: u8,
    daily:Vec<DailyContact>,
}
impl ActivityBook {
    pub fn restore(mut self, now: i64) -> Self {
        self.goals.retain(|g| {
            digest(&g.scope)
                && CATEGORIES.contains(&g.category.as_str())
                && ["observe", "reflect", "rest"].contains(&g.step.as_str())
        });
        self.goals.truncate(12);
        for g in &mut self.goals {
            g.observed = g.observed.min(10000);
            g.shared = g.shared.min(10000);
            g.last_observed = g.last_observed.clamp(0, now);
            g.last_shared = g.last_shared.clamp(0, now);
            g.last_feedback = g.last_feedback.clamp(0, now);
            g.last_reviewed = g.last_reviewed.clamp(0, now);
        }
        self.observations.retain(|o| {
            digest(&o.scope)
                && digest(&o.id)
                && CATEGORIES.contains(&o.category.as_str())
                && o.at <= now
                && now - o.at < 7 * 86400
                && ["observed", "reviewing", "rest", "shared", "unknown"]
                    .contains(&o.state.as_str())
        });
        self.observations.truncate(64);
        for o in &mut self.observations {
            if o.state == "reviewing" {
                o.state = "unknown".into();
            }
        }
        self.reviews = self.reviews.min(10);
        let today=crate::memory_time::day(now).map(|d|d.to_string()).unwrap_or_default();
        self.daily.retain(|d|digest(&d.scope)&&d.day==today&&["planning","waiting","confirmed","unknown"].contains(&d.state.as_str()));
        self.daily.truncate(12);
        for d in &mut self.daily {d.plans=d.plans.min(2);if d.state=="planning"{d.state="unknown".into();}}
        self
    }
    /// Daily contact is a preparation target, never a promise to override silence.
    pub fn daily_status(&self,scope:&str,enabled:bool,at:i64)->(&'static str,u8,i64) {
        if !enabled{return ("daily-off",0,0);}
        let day=crate::memory_time::day(at).map(|d|d.to_string()).unwrap_or_default();
        let row=self.daily.iter().find(|d|d.scope==scope&&d.day==day);
        let plans=row.map(|d|d.plans).unwrap_or(0);
        if let Some(row)=row {
            let state=match row.state.as_str(){"confirmed"=>Some("daily-confirmed"),"unknown"=>Some("daily-unknown"),"planning"=>Some("daily-planning"),_=>None};
            if let Some(state)=state{return (state,plans,0);}
        }
        if plans>=2{return ("daily-exhausted",plans,0);}
        let hour=(at.div_euclid(3600)+8).rem_euclid(24);
        if hour<18{return ("daily-wait-time",plans,at+(18-hour)*3600-at.rem_euclid(3600));}
        ("daily-ready",plans,at)
    }
    pub fn prepare_daily(&mut self,scope:&str,at:i64)->bool {
        if !digest(scope)||self.daily_status(scope,true,at).0!="daily-ready"{return false;}
        self.daily_row(scope,at).plans+=1;self.daily_row(scope,at).state="planning".into();true
    }
    fn daily_row(&mut self,scope:&str,at:i64)->&mut DailyContact {
        let day=crate::memory_time::day(at).map(|d|d.to_string()).unwrap_or_default();
        self.daily.retain(|d|d.day==day);
        if !self.daily.iter().any(|d|d.scope==scope){
            if self.daily.len()==12{self.daily.remove(0);}
            self.daily.push(DailyContact{scope:scope.into(),day,plans:0,state:"waiting".into()});
        }
        self.daily.iter_mut().find(|d|d.scope==scope).unwrap()
    }
    pub fn finish_daily(&mut self,scope:&str,outcome:&str,at:i64) {
        if !digest(scope){return;}
        let row=self.daily_row(scope,at);
        if outcome=="sent" || outcome=="partial"{row.state="confirmed".into();}
        else if !["confirmed","unknown"].contains(&row.state.as_str()) {row.state=if outcome=="unknown"{"unknown"}else{"waiting"}.into();}
    }
    pub fn observe(&mut self, scope: &str, id: &str, category: &str, at: i64) -> bool {
        if !digest(scope) || !digest(id) || !CATEGORIES.contains(&category) {
            return false;
        }
        self.observations
            .retain(|o| at >= o.at && at - o.at < 7 * 86400);
        if self
            .observations
            .iter()
            .any(|o| o.scope == scope && o.id == id)
        {
            return false;
        }
        if !self
            .goals
            .iter()
            .any(|g| g.scope == scope && g.category == category)
        {
            if self.goals.len() == 12 {
                self.goals.remove(0);
            }
            self.goals.push(Goal {
                scope: scope.into(),
                category: category.into(),
                step: "observe".into(),
                ..Default::default()
            });
        }
        let goal = self
            .goals
            .iter_mut()
            .find(|g| g.scope == scope && g.category == category)
            .unwrap();
        goal.observed = goal.observed.saturating_add(1).min(10000);
        goal.last_observed = at;
        goal.step = "reflect".into();
        if self.observations.len() == 64 {
            self.observations.remove(0);
        }
        self.observations.push(Observation {
            scope: scope.into(),
            id: id.into(),
            category: category.into(),
            at,
            state: "observed".into(),
            ..Default::default()
        });
        true
    }
    pub fn can_review(&self, scope: &str, id: &str, mode: &str, at: i64) -> bool {
        let day = crate::memory_time::day(at)
            .map(|d| d.to_string())
            .unwrap_or_default();
        let quota = if mode == "active" { 10 } else { 6 };
        (self.day != day || self.reviews < quota)
            && self.observations.iter().any(|o| {
                o.scope == scope
                    && o.id == id
                    && o.at <= at
                    && at - o.at < 7 * 86400
                    && o.attempts < 2
                    && (o.reviewed == 0 || at - o.reviewed >= 45 * 60)
                    && ["observed", "rest"].contains(&o.state.as_str())
            })
    }
    pub fn can_consider(&self,scope:&str,id:&str,mode:&str,at:i64)->bool {
        if !digest(scope)||!digest(id){return false;}
        if self.observations.iter().any(|o|o.scope==scope&&o.id==id){return self.can_review(scope,id,mode,at);}
        let day=crate::memory_time::day(at).map(|d|d.to_string()).unwrap_or_default();
        self.day!=day || self.reviews<if mode=="active"{10}else{6}
    }
    pub fn review_budget_available(&self,mode:&str,at:i64)->bool {
        self.day!=crate::memory_time::day(at).map(|d|d.to_string()).unwrap_or_default() || self.reviews<if mode=="active"{10}else{6}
    }
    pub fn review(&mut self, scope: &str, id: &str, mode: &str, at: i64) -> bool {
        if !self.can_review(scope, id, mode, at) {
            return false;
        }
        let day = crate::memory_time::day(at)
            .map(|d| d.to_string())
            .unwrap_or_default();
        if self.day != day {
            self.day = day;
            self.reviews = 0;
        }
        self.reviews += 1;
        let o = self
            .observations
            .iter_mut()
            .find(|o| o.scope == scope && o.id == id)
            .unwrap();
        o.attempts += 1;
        o.reviewed = at;
        o.state = "reviewing".into();
        if let Some(g) = self
            .goals
            .iter_mut()
            .find(|g| g.scope == scope && g.category == o.category)
        {
            g.last_reviewed = at;
        }
        true
    }
    pub fn settle(&mut self, scope: &str, id: &str, outcome: &str, at: i64) {
        let Some(o) = self
            .observations
            .iter_mut()
            .find(|o| o.scope == scope && o.id == id)
        else {
            return;
        };
        if o.state != "reviewing" {
            return;
        }
        o.state = if outcome == "sent" {
            "shared"
        } else if outcome == "wait" {
            "rest"
        } else if outcome == "drop" {
            "rest"
        } else {
            "unknown"
        }
        .into();
        if outcome == "drop" {
            o.attempts = 2;
        }
        if let Some(goal) = self
            .goals
            .iter_mut()
            .find(|g| g.scope == scope && g.category == o.category)
        {
            goal.step = "rest".into();
            if outcome == "sent" {
                goal.shared = goal.shared.saturating_add(1).min(10000);
                goal.last_shared = at;
            }
        }
    }
    pub fn returned(&mut self, scope: &str, at: i64) {
        for goal in &mut self.goals {
            if goal.scope == scope
                && goal.last_shared > goal.last_feedback
                && at >= goal.last_shared
                && at - goal.last_shared < 86400
            {
                goal.last_feedback = at;
            }
        }
    }
    pub fn priority(&self, scope: &str, category: &str) -> i64 {
        // Rotate genuine interests instead of repeatedly selecting the first cache category.
        -self
            .goals
            .iter()
            .find(|g| g.scope == scope && g.category == category)
            .map(|g| g.last_shared.max(g.last_reviewed))
            .unwrap_or(0)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn daily_goal_never_reopens_uncertain_delivery_and_caps_declined_preparations() {
        let at=chrono::DateTime::parse_from_rfc3339("2026-10-31T18:00:00+08:00").unwrap().timestamp();
        let scope="a".repeat(64);let other="b".repeat(64);let mut b=ActivityBook::default();
        assert!(b.prepare_daily(&scope,at));b.finish_daily(&scope,"unknown",at+1);
        b.finish_daily(&scope,"cancelled",at+2);
        assert_eq!(b.daily_status(&scope,true,at+3).0,"daily-unknown");
        assert!(!b.prepare_daily(&scope,at+900));
        b.finish_daily(&scope,"partial",at+901);
        assert_eq!(b.daily_status(&scope,true,at+902).0,"daily-confirmed");
        for offset in [0,900]{assert!(b.prepare_daily(&other,at+offset));b.finish_daily(&other,"drop",at+offset+1);}
        assert_eq!(b.daily_status(&other,true,at+1800).0,"daily-exhausted");
        assert!(!b.prepare_daily(&other,at+1800));
        let early="c".repeat(64);b.finish_daily(&early,"sent",at-3600);
        assert_eq!(b.daily_status(&early,true,at+1).0,"daily-confirmed");
    }
    #[test]
    fn daily_goal_counts_confirmed_contacts_and_unknown_never_retries_after_reload() {
        let at=chrono::DateTime::parse_from_rfc3339("2026-10-31T18:00:00+08:00").unwrap().timestamp();
        let scope="a".repeat(64);let other="c".repeat(64);let mut b=ActivityBook::default();
        assert_eq!(b.daily_status(&scope,false,at).0,"daily-off");
        assert_eq!(b.daily_status(&scope,true,at-3600).0,"daily-wait-time");
        assert!(b.prepare_daily(&scope,at));assert_eq!(b.daily_status(&scope,true,at).0,"daily-planning");
        b.finish_daily(&scope,"wait",at);assert!(b.prepare_daily(&scope,at+900));
        b.finish_daily(&scope,"unknown",at+901);
        let restored:ActivityBook=serde_json::from_str(&serde_json::to_string(&b).unwrap()).unwrap();let mut restored=restored.restore(at+902);
        assert_eq!(restored.daily_status(&scope,true,at+902).0,"daily-unknown");assert!(!restored.prepare_daily(&scope,at+1800));
        assert!(restored.prepare_daily(&other,at+1800));
        restored.finish_daily(&other,"sent",at+1801);assert_eq!(restored.daily_status(&other,true,at+1802).0,"daily-confirmed");
        assert!(restored.prepare_daily(&scope,at+86400));
        let recovered=restored.restore(at+86401);assert_eq!(recovered.daily_status(&scope,true,at+86401).0,"daily-unknown");
    }
    #[test]
    fn an_unseen_source_is_reviewable_after_used_heads_without_evicting_existing_state() {
        let mut b=ActivityBook::default();let scope="a".repeat(64);let id="b".repeat(64);
        assert!(b.can_consider(&scope,&id,"natural",1000));
        b.observe(&scope,&id,"games",1000);assert!(b.review(&scope,&id,"natural",1000));b.settle(&scope,&id,"drop",1001);
        assert!(!b.can_consider(&scope,&id,"natural",5000));
        assert!(b.can_consider(&scope,&"c".repeat(64),"natural",5000));
    }
    #[test]
    fn review_budget_unknown_delivery_and_scope_recovery_prevent_repeat_contacts() {
        let mut b = ActivityBook::default();
        let scope = "a".repeat(64);
        let other = "c".repeat(64);
        let id = "b".repeat(64);
        b.observe(&scope, &id, "games", 1000);
        assert!(!b.review(&other, &id, "natural", 1000));
        assert!(b.review(&scope, &id, "natural", 1000));
        b.settle(&scope, &id, "wait", 1001);
        assert!(!b.review(&scope, &id, "natural", 1002));
        assert!(b.review(&scope, &id, "natural", 4000));
        let restored = b.clone().restore(4001);
        assert_eq!(
            restored.observations[0].state, "unknown",
            "in-flight work must recover as uncertain, never repeat"
        );
        assert!(!restored.can_review(&scope, &id, "natural", 8000));
        for i in 1..=8 {
            let source = format!("{i:064x}");
            b.observe(&scope, &source, "music", 4001);
            let accepted = b.review(&scope, &source, "natural", 4001);
            assert_eq!(
                accepted,
                i <= 4,
                "natural mode has six model decision attempts per day"
            );
        }
        let broken = serde_json::json!({"goals":[{"scope":"private name","category":"secret","step":"exec"}]});
        let restored: ActivityBook = serde_json::from_value(broken).unwrap();
        assert!(restored.restore(4002).goals.is_empty());
    }
    #[test]
    fn science_and_work_interests_can_be_reviewed_and_restored() {
        for (category,id) in [("science","b"),("work-growth","c"),("general","d")] {
            let mut book=ActivityBook::default();let scope="a".repeat(64);let source=id.repeat(64);
            assert!(book.observe(&scope,&source,category,1000));
            assert!(book.review(&scope,&source,"natural",1001));
            let restored:ActivityBook=serde_json::from_str(&serde_json::to_string(&book).unwrap()).unwrap();
            let restored=restored.restore(1002);
            assert_eq!(restored.goals[0].category,category);
        }
    }
    #[test]
    fn real_observations_advance_a_goal_once_and_survive_reload_without_source_text() {
        let mut book = ActivityBook::default();
        let scope = "a".repeat(64);
        let source = "b".repeat(64);
        assert!(book.observe(&scope, &source, "film-tv", 1000));
        assert!(!book.observe(&scope, &source, "film-tv", 1001));
        assert_eq!(book.goals[0].observed, 1);
        assert_eq!(book.goals[0].step, "reflect");
        let saved = serde_json::to_string(&book).unwrap();
        let book: ActivityBook = serde_json::from_str(&saved).unwrap();
        assert_eq!(book.goals[0].observed, 1);
        assert!(!saved.contains("http"));
        assert!(!book
            .clone()
            .observe(&scope, &source, "unknown-private-category", 1002));
    }
}
