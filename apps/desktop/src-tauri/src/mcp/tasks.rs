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

    pub fn create_task(&self, name: impl Into<String>, ttl_secs: Option<u64>) -> TaskHandle {
        let task_id = Uuid::new_v4().to_string();
        let now = now_ms();
        let ttl = ttl_secs.unwrap_or(DEFAULT_TASK_TTL_SECS) as i64 * 1000;
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
        if let Ok(mut tasks) = self.tasks.write() {
            tasks.insert(task_id.clone(), record);
        }
        if let Ok(mut flags) = self.cancellation_flags.write() {
            flags.insert(task_id.clone(), Arc::clone(&flag));
        }

        self.cleanup_expired();

        TaskHandle {
            task_id,
            cancelled: flag,
        }
    }

    pub fn update_progress(&self, task_id: &str, progress: f64, message: Option<String>) {
        if let Ok(mut tasks) = self.tasks.write() {
            if let Some(task) = tasks.get_mut(task_id) {
                if task.status == TaskStatus::Working {
                    task.progress = progress.clamp(0.0, 1.0);
                    if message.is_some() {
                        task.message = message;
                    }
                    task.updated_at = now_ms();
                }
            }
        }
    }

    pub fn complete_task(&self, task_id: &str, result: Value) {
        if let Ok(mut tasks) = self.tasks.write() {
            if let Some(task) = tasks.get_mut(task_id) {
                if task.status == TaskStatus::Working {
                    task.status = TaskStatus::Completed;
                    task.progress = 1.0;
                    task.result = Some(result);
                    task.message = Some("Task completed successfully".to_string());
                    task.updated_at = now_ms();
                }
            }
        }
    }

    pub fn fail_task(&self, task_id: &str, error: String) {
        if let Ok(mut tasks) = self.tasks.write() {
            if let Some(task) = tasks.get_mut(task_id) {
                if task.status == TaskStatus::Working {
                    task.status = TaskStatus::Failed;
                    task.error = Some(error.clone());
                    task.message = Some(format!("Task failed: {error}"));
                    task.updated_at = now_ms();
                }
            }
        }
    }

    pub fn cancel_task(&self, task_id: &str) -> bool {
        if let Ok(flags) = self.cancellation_flags.read() {
            if let Some(flag) = flags.get(task_id) {
                flag.store(true, Ordering::Relaxed);
            }
        }

        if let Ok(mut tasks) = self.tasks.write() {
            if let Some(task) = tasks.get_mut(task_id) {
                if task.status == TaskStatus::Working {
                    task.status = TaskStatus::Cancelled;
                    task.message = Some("Task was cancelled by user or client".to_string());
                    task.updated_at = now_ms();
                    return true;
                }
            }
        }
        false
    }

    pub fn get_task(&self, task_id: &str) -> Option<TaskRecord> {
        self.tasks.read().ok()?.get(task_id).cloned()
    }

    pub fn list_tasks(&self) -> Vec<TaskRecord> {
        self.cleanup_expired();
        self.tasks
            .read()
            .map(|t| t.values().cloned().collect())
            .unwrap_or_default()
    }

    fn cleanup_expired(&self) {
        let now = now_ms();
        if let Ok(mut tasks) = self.tasks.write() {
            let expired_ids: Vec<String> = tasks
                .iter()
                .filter(|(_, task)| task.expires_at < now && task.status != TaskStatus::Working)
                .map(|(id, _)| id.clone())
                .collect();

            for id in &expired_ids {
                tasks.remove(id);
            }

            if let Ok(mut flags) = self.cancellation_flags.write() {
                for id in expired_ids {
                    flags.remove(&id);
                }
            }
        }
    }
}
