//! Model Context Protocol (MCP 2.0) Tasks Extension (SEP-2663).
//!
//! Provides non-blocking asynchronous execution for long-running workflows:
//! - Full multi-stage resume synthesis
//! - Batch embedding and re-indexing
//! - Large document and career space ingestion
//! - Compilation verification

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const DEFAULT_TASK_TTL_SECS: u64 = 600; // 10 minutes

/// How long past its TTL a task may remain `Working` before it is declared dead.
///
/// A `Working` task is only advanced by the code that created it. If that code
/// panics, is dropped, or its runtime shuts down, nothing ever moves the record
/// to a terminal state — so a reaper that skips `Working` records (as this one
/// originally did) never reclaims them and the map grows for the life of the
/// process. Past this grace period the record is failed with an explicit
/// timeout, which both bounds memory and stops `tasks/get` from reporting
/// "working, 0% complete" forever for a task that will never progress.
const WORKING_TASK_GRACE_MS: i64 = 5 * 60 * 1000;

/// Hard cap on retained task records.
///
/// Every `resume_synthesize` call creates one, and results are retained for the
/// TTL, so an automated caller can accumulate records faster than they expire.
/// At the cap the oldest terminal records are dropped first; `Working` records
/// are never evicted to make room, because a live task's handle is still
/// referenced by the code running it.
const MAX_TASKS: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Working,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRecord {
    pub task_id: String,
    pub name: String,
    pub status: TaskStatus,
    pub progress: f64, // 0.0 to 1.0
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub expires_at: i64,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Clone)]
pub struct TaskHandle {
    pub task_id: String,
    pub cancelled: Arc<AtomicBool>,
}

impl TaskHandle {
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }
}

pub struct TaskManager {
    tasks: RwLock<HashMap<String, TaskRecord>>,
    cancellation_flags: RwLock<HashMap<String, Arc<AtomicBool>>>,
}

impl Default for TaskManager {
    fn default() -> Self {
        Self::new()
    }
}

impl TaskManager {
    pub fn new() -> Self {
        Self {
            tasks: RwLock::new(HashMap::new()),
            cancellation_flags: RwLock::new(HashMap::new()),
        }
    }

    /// Recover the task map even if a previous holder panicked.
    ///
    /// The original code used `if let Ok(guard) = ...write()`, which turns a
    /// single poisoned lock into permanent silent failure: `create_task` would
    /// hand back a handle for a task it never recorded, `complete_task` would
    /// discard finished results, and `get_task` would report "not found" — every
    /// one of them indistinguishable from normal operation. Recovering the inner
    /// value keeps the manager usable and observable instead.
    fn tasks_mut(&self) -> std::sync::RwLockWriteGuard<'_, HashMap<String, TaskRecord>> {
        self.tasks.write().unwrap_or_else(|e| e.into_inner())
    }

    fn tasks_ref(&self) -> std::sync::RwLockReadGuard<'_, HashMap<String, TaskRecord>> {
        self.tasks.read().unwrap_or_else(|e| e.into_inner())
    }

    fn flags_mut(&self) -> std::sync::RwLockWriteGuard<'_, HashMap<String, Arc<AtomicBool>>> {
        self.cancellation_flags
            .write()
            .unwrap_or_else(|e| e.into_inner())
    }

    pub fn create_task(&self, name: impl Into<String>, ttl_secs: Option<u64>) -> TaskHandle {
        let task_id = Uuid::new_v4().to_string();
        let now = now_ms();
        let ttl = ttl_secs
            .unwrap_or(DEFAULT_TASK_TTL_SECS)
            .saturating_mul(1000)
            .min(i64::MAX as u64) as i64;
        let record = TaskRecord {
            task_id: task_id.clone(),
            name: name.into(),
            status: TaskStatus::Working,
            progress: 0.0,
            message: Some("Task started".to_string()),
            result: None,
            error: None,
            created_at: now,
            updated_at: now,
            expires_at: now + ttl,
        };

        let flag = Arc::new(AtomicBool::new(false));

        // Register the cancellation flag *before* the record becomes visible.
        //
        // The original order inserted the record first and the flag second, under
        // two separately-acquired locks. A `cancel_task` landing in the gap saw a
        // Working task with no flag: it marked the record Cancelled and returned
        // `true`, but the worker never observed the flag and ran to completion —
        // burning the full pipeline for a result `complete_task` then discarded.
        // Publishing the flag first means any observer that can see the task can
        // also cancel it.
        self.flags_mut().insert(task_id.clone(), Arc::clone(&flag));
        self.tasks_mut().insert(task_id.clone(), record);

        self.cleanup_expired();

        TaskHandle {
            task_id,
            cancelled: flag,
        }
    }

    pub fn update_progress(&self, task_id: &str, progress: f64, message: Option<String>) {
        if let Some(task) = self.tasks_mut().get_mut(task_id) {
            if task.status == TaskStatus::Working {
                task.progress = progress.clamp(0.0, 1.0);
                if message.is_some() {
                    task.message = message;
                }
                task.updated_at = now_ms();
            }
        }
    }

    pub fn complete_task(&self, task_id: &str, result: Value) {
        if let Some(task) = self.tasks_mut().get_mut(task_id) {
            if task.status == TaskStatus::Working {
                task.status = TaskStatus::Completed;
                task.progress = 1.0;
                task.result = Some(result);
                task.message = Some("Task completed successfully".to_string());
                task.updated_at = now_ms();
            }
        }
    }

    pub fn fail_task(&self, task_id: &str, error: String) {
        if let Some(task) = self.tasks_mut().get_mut(task_id) {
            if task.status == TaskStatus::Working {
                task.status = TaskStatus::Failed;
                task.error = Some(error.clone());
                task.message = Some(format!("Task failed: {error}"));
                task.updated_at = now_ms();
            }
        }
    }

    pub fn cancel_task(&self, task_id: &str) -> bool {
        if let Some(flag) = self
            .cancellation_flags
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(task_id)
        {
            flag.store(true, Ordering::Relaxed);
        }

        if let Some(task) = self.tasks_mut().get_mut(task_id) {
            if task.status == TaskStatus::Working {
                task.status = TaskStatus::Cancelled;
                task.message = Some("Task was cancelled by user or client".to_string());
                task.updated_at = now_ms();
                return true;
            }
        }
        false
    }

    pub fn get_task(&self, task_id: &str) -> Option<TaskRecord> {
        self.tasks_ref().get(task_id).cloned()
    }

    pub fn list_tasks(&self) -> Vec<TaskRecord> {
        self.cleanup_expired();
        self.tasks_ref().values().cloned().collect()
    }

    /// Number of retained records. Test/introspection helper.
    pub fn task_count(&self) -> usize {
        self.tasks_ref().len()
    }

    /// Reap dead records and enforce `MAX_TASKS`.
    ///
    /// Two things the original reaper did not do:
    ///
    /// * It skipped `Working` records entirely, so any task whose owner panicked
    ///   or was dropped stayed in the map for the life of the process. Those are
    ///   now failed with an explicit timeout once past `WORKING_TASK_GRACE_MS`,
    ///   which is both truthful (the task is not progressing) and reclaimable.
    /// * It had no size bound at all, so records accumulated faster than the TTL
    ///   retired them under any automated caller.
    fn cleanup_expired(&self) {
        let now = now_ms();
        let mut tasks = self.tasks_mut();

        // A Working record past its TTL plus the grace period has no live owner
        // advancing it. Say so rather than reporting "working" forever.
        for task in tasks.values_mut() {
            if task.status == TaskStatus::Working
                && task.expires_at.saturating_add(WORKING_TASK_GRACE_MS) < now
            {
                task.status = TaskStatus::Failed;
                task.error = Some("Task exceeded its time-to-live without completing".to_string());
                task.message = Some("Task timed out".to_string());
                task.updated_at = now;
            }
        }

        let mut reaped: Vec<String> = tasks
            .iter()
            .filter(|(_, task)| task.expires_at < now && task.status != TaskStatus::Working)
            .map(|(id, _)| id.clone())
            .collect();

        for id in &reaped {
            tasks.remove(id);
        }

        // Still over the cap: drop the oldest terminal records. Working records
        // are never evicted — their handles are still held by running code.
        if tasks.len() > MAX_TASKS {
            let mut terminal: Vec<(String, i64)> = tasks
                .iter()
                .filter(|(_, t)| t.status != TaskStatus::Working)
                .map(|(id, t)| (id.clone(), t.created_at))
                .collect();
            terminal.sort_by_key(|(_, created)| *created);

            let overflow = tasks.len() - MAX_TASKS;
            for (id, _) in terminal.into_iter().take(overflow) {
                tasks.remove(&id);
                reaped.push(id);
            }
        }

        if !reaped.is_empty() {
            let mut flags = self.flags_mut();
            for id in reaped {
                flags.remove(&id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_completed_task_reports_its_result() {
        let mgr = TaskManager::new();
        let handle = mgr.create_task("unit", Some(600));
        mgr.complete_task(&handle.task_id, json!({"ok": true}));

        let task = mgr.get_task(&handle.task_id).expect("task recorded");
        assert_eq!(task.status, TaskStatus::Completed);
        assert_eq!(task.result, Some(json!({"ok": true})));
    }

    #[test]
    fn a_cancel_is_observable_through_the_handle() {
        let mgr = TaskManager::new();
        let handle = mgr.create_task("unit", Some(600));
        assert!(!handle.is_cancelled());
        assert!(mgr.cancel_task(&handle.task_id));
        assert!(
            handle.is_cancelled(),
            "the worker polls the handle, so cancelling must set its flag"
        );
    }

    #[test]
    fn a_task_whose_owner_never_finishes_is_eventually_reclaimed() {
        // The original reaper skipped `Working` records entirely, so a task
        // whose owner panicked or was dropped stayed in the map for the life of
        // the process and `tasks/get` reported "working, 0%" forever.
        let mgr = TaskManager::new();
        let handle = mgr.create_task("abandoned", Some(0));

        // Backdate past the TTL plus the grace period.
        {
            let mut tasks = mgr.tasks_mut();
            if let Some(task) = tasks.get_mut(&handle.task_id) {
                task.expires_at = now_ms() - WORKING_TASK_GRACE_MS - 1_000;
            }
        }

        mgr.cleanup_expired();
        let after = mgr.get_task(&handle.task_id);
        assert!(
            after.is_none() || after.map(|t| t.status) != Some(TaskStatus::Working),
            "an abandoned Working record must not stay Working forever"
        );
    }

    #[test]
    fn the_task_table_stays_bounded() {
        let mgr = TaskManager::new();
        for i in 0..(MAX_TASKS * 2) {
            let handle = mgr.create_task("bulk", Some(600));
            mgr.complete_task(&handle.task_id, json!({ "i": i }));
        }
        mgr.cleanup_expired();
        assert!(
            mgr.task_count() <= MAX_TASKS,
            "retained records must stay bounded, got {}",
            mgr.task_count()
        );
    }

    #[test]
    fn a_live_task_is_never_evicted_to_make_room() {
        let mgr = TaskManager::new();
        let live = mgr.create_task("live", Some(600));
        for _ in 0..(MAX_TASKS * 2) {
            let h = mgr.create_task("bulk", Some(600));
            mgr.complete_task(&h.task_id, json!({}));
        }
        mgr.cleanup_expired();
        assert!(
            mgr.get_task(&live.task_id).is_some(),
            "a Working task's handle is still held by running code; it must not be dropped"
        );
    }

    #[test]
    fn a_poisoned_lock_does_not_silently_disable_the_manager() {
        // `if let Ok(guard) = lock()` turned a single poisoned lock into
        // permanent silent failure: tasks created but never recorded, results
        // discarded, and `get_task` reporting "not found" — each of them
        // indistinguishable from normal operation.
        use std::sync::Arc;

        let mgr = Arc::new(TaskManager::new());
        let poisoner = Arc::clone(&mgr);
        let _ = std::thread::spawn(move || {
            let _guard = poisoner.tasks_mut();
            panic!("poison the lock");
        })
        .join();

        let handle = mgr.create_task("after-poison", Some(600));
        mgr.complete_task(&handle.task_id, json!({"recovered": true}));

        let task = mgr
            .get_task(&handle.task_id)
            .expect("the manager must remain usable after a poisoned lock");
        assert_eq!(task.status, TaskStatus::Completed);
        assert_eq!(task.result, Some(json!({"recovered": true})));
    }

    #[test]
    fn a_cancellation_flag_exists_as_soon_as_the_task_is_visible() {
        // The flag used to be inserted *after* the record under a separate lock,
        // so a cancel landing in the gap marked the record Cancelled and
        // returned true while the worker never saw the flag and ran to
        // completion for a result that was then discarded.
        let mgr = TaskManager::new();
        let handle = mgr.create_task("unit", Some(600));
        assert!(mgr.get_task(&handle.task_id).is_some());
        assert!(
            mgr.cancellation_flags
                .read()
                .unwrap_or_else(|e| e.into_inner())
                .contains_key(&handle.task_id),
            "a visible task must always have a cancellation flag"
        );
    }
}
