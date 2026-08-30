//! Small durable goal/TODO store. It is separate from Memory: goals are
//! user-controlled workflow state, while Memory remains learned context.
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

pub const MAX_GOALS: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GoalStatus { Active, Completed, Paused, Cancelled }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Goal { pub id: String, pub title: String, pub status: GoalStatus, pub created_at_ms: u64, pub updated_at_ms: u64 }

pub struct GoalState { path: PathBuf, goals: Mutex<Vec<Goal>> }
impl GoalState {
    pub fn open(path: PathBuf) -> Self {
        let goals = fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        Self { path, goals: Mutex::new(goals) }
    }
    pub fn list(&self) -> Vec<Goal> { self.goals.lock().unwrap().clone() }
    pub fn upsert(&self, goal: Goal) -> std::io::Result<()> { let mut g=self.goals.lock().unwrap(); upsert(&mut g, goal); persist(&self.path, &g) }
    pub fn set_status(&self, id: &str, status: GoalStatus, now: u64) -> std::io::Result<bool> { let mut g=self.goals.lock().unwrap(); let Some(x)=g.iter_mut().find(|x|x.id==id) else{return Ok(false)}; x.status=status; x.updated_at_ms=now; persist(&self.path,&g)?; Ok(true) }
}
fn persist(path:&PathBuf, goals:&[Goal])->std::io::Result<()> { if let Some(p)=path.parent(){fs::create_dir_all(p)?;} let tmp=path.with_extension("json.tmp"); fs::write(&tmp,serde_json::to_vec(goals).unwrap())?; fs::rename(tmp,path) }
pub fn upsert(goals:&mut Vec<Goal>, goal:Goal){ goals.retain(|x|x.id!=goal.id); goals.insert(0,goal); goals.truncate(MAX_GOALS); }

#[cfg(test)]
mod tests { use super::*; fn g(id:&str)->Goal{Goal{id:id.into(),title:"t".into(),status:GoalStatus::Active,created_at_ms:1,updated_at_ms:1}}
 #[test] fn bounded_and_idempotent(){let mut v=Vec::new(); upsert(&mut v,g("a")); let mut x=g("a");x.title="new".into();upsert(&mut v,x);assert_eq!(v.len(),1);assert_eq!(v[0].title,"new");}
}
