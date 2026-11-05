// Per-passage comments + suggestions persisted to
// `<project_root>/.claudeprism/comments.json`.
//
// Schema is the canonical contract with the frontend AND with any external
// Claude Code session that wants to read or append. See `Comment` below.
//
// A small polling watcher emits a `comments-changed` event so external writes
// (e.g. from a Claude Code session) appear live in the UI.

use crate::plugins::path_guard::atomic_write;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

// ---------- Schema ----------

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CommentAnchor {
    pub line_start: u32,
    pub line_end: u32,
    pub char_start: u32,
    pub char_end: u32,
    pub quoted_text: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Reply {
    pub author: String,
    pub body: String,
    pub ts: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Comment {
    pub id: String,
    pub file_path: String,
    pub anchor: CommentAnchor,
    #[serde(rename = "type")]
    pub ty: String,
    pub author: String,
    pub comment: String,
    pub proposed_replacement: Option<String>,
    pub status: String,
    pub replies: Vec<Reply>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Default)]
struct CommentsFile {
    comments: Vec<Comment>,
}

// ---------- Paths + IO ----------

fn comments_path(project_root: &str) -> PathBuf {
    Path::new(project_root)
        .join(".claudeprism")
        .join("comments.json")
}

fn notifications_path(project_root: &str) -> PathBuf {
    Path::new(project_root)
        .join(".claudeprism")
        .join("notifications.log")
}

fn read_file_or_default(project_root: &str) -> Result<CommentsFile, String> {
    let path = comments_path(project_root);
    match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(CommentsFile::default());
        }
        Err(e) => return Err(format!("read {:?}: {}", path, e)),
        // A planted symlink must not be followed. The writer replaces the link.
        Ok(meta) if meta.file_type().is_symlink() => return Ok(CommentsFile::default()),
        Ok(_) => {}
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read {:?}: {}", path, e))?;
    if raw.trim().is_empty() {
        return Ok(CommentsFile::default());
    }
    serde_json::from_str::<CommentsFile>(&raw).map_err(|e| format!("parse comments.json: {}", e))
}

fn append_notification(project_root: &str, event: &serde_json::Value) -> Result<(), String> {
    let path = notifications_path(project_root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir notif parent: {}", e))?;
    }
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open notif log: {}", e))?;
    writeln!(f, "{}", event).map_err(|e| format!("write notif: {}", e))?;
    Ok(())
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn gen_id() -> String {
    let now = Utc::now().format("%Y-%m-%dT%H-%M-%S").to_string();
    let suffix: String = Uuid::new_v4().to_string().chars().take(4).collect();
    format!("cmt_{}_{}", now, suffix)
}

fn write_all(project_root: &str, file: &CommentsFile) -> Result<(), String> {
    let serialized = serde_json::to_string_pretty(file).map_err(|e| format!("serialize: {}", e))?;
    atomic_write(&comments_path(project_root), serialized.as_bytes())
}

// ---------- Commands ----------

#[tauri::command]
pub fn comments_list(project_root: String) -> Result<Vec<Comment>, String> {
    let file = read_file_or_default(&project_root)?;
    Ok(file.comments)
}

#[derive(Deserialize)]
pub struct AddCommentInput {
    pub project_root: String,
    pub file_path: String,
    pub anchor: CommentAnchor,
    #[serde(rename = "type")]
    pub ty: String,
    pub author: String,
    pub comment: String,
    pub proposed_replacement: Option<String>,
}

#[tauri::command]
pub fn comments_add(input: AddCommentInput) -> Result<Comment, String> {
    if input.ty != "comment" && input.ty != "suggestion" {
        return Err(format!("invalid type: {}", input.ty));
    }
    let mut file = read_file_or_default(&input.project_root)?;
    let now = now_iso();
    let new_comment = Comment {
        id: gen_id(),
        file_path: input.file_path.clone(),
        anchor: input.anchor,
        ty: input.ty.clone(),
        author: input.author.clone(),
        comment: input.comment,
        proposed_replacement: input.proposed_replacement,
        status: "open".to_string(),
        replies: vec![],
        created_at: now.clone(),
        updated_at: now.clone(),
    };
    file.comments.push(new_comment.clone());
    write_all(&input.project_root, &file)?;
    append_notification(
        &input.project_root,
        &serde_json::json!({
            "ts": now,
            "actor": input.author,
            "type": "comment_added",
            "comment_type": input.ty,
            "comment_id": new_comment.id,
            "file_path": input.file_path,
        }),
    )?;
    Ok(new_comment)
}

#[derive(Deserialize)]
pub struct UpdateCommentInput {
    pub project_root: String,
    pub id: String,
    pub patch: serde_json::Value,
}

#[tauri::command]
pub fn comments_update(input: UpdateCommentInput) -> Result<Comment, String> {
    let mut file = read_file_or_default(&input.project_root)?;
    let idx = file
        .comments
        .iter()
        .position(|c| c.id == input.id)
        .ok_or_else(|| format!("comment not found: {}", input.id))?;

    let now = now_iso();
    let mut value =
        serde_json::to_value(&file.comments[idx]).map_err(|e| format!("to value: {}", e))?;
    if let (Some(target), Some(patch)) = (value.as_object_mut(), input.patch.as_object()) {
        for (k, v) in patch {
            // Disallow mutating id / created_at via patch
            if k == "id" || k == "created_at" {
                continue;
            }
            target.insert(k.clone(), v.clone());
        }
        target.insert(
            "updated_at".to_string(),
            serde_json::Value::String(now.clone()),
        );
    }
    let updated: Comment =
        serde_json::from_value(value).map_err(|e| format!("from value: {}", e))?;

    // Validate enum-like fields so a patch can't set arbitrary status/type
    // (comments_add already enforces these for new comments).
    const VALID_STATUS: &[&str] = &["open", "resolved", "rejected", "applied", "orphaned"];
    const VALID_TY: &[&str] = &["comment", "suggestion"];
    if !VALID_STATUS.contains(&updated.status.as_str()) {
        return Err(format!("invalid comment status: {}", updated.status));
    }
    if !VALID_TY.contains(&updated.ty.as_str()) {
        return Err(format!("invalid comment type: {}", updated.ty));
    }

    file.comments[idx] = updated.clone();
    write_all(&input.project_root, &file)?;
    append_notification(
        &input.project_root,
        &serde_json::json!({
            "ts": now,
            "actor": "system",
            "type": "comment_updated",
            "comment_id": input.id,
            "patch": input.patch,
        }),
    )?;
    Ok(updated)
}

#[derive(Deserialize)]
pub struct AddReplyInput {
    pub project_root: String,
    pub id: String,
    pub author: String,
    pub body: String,
}

#[tauri::command]
pub fn comments_reply(input: AddReplyInput) -> Result<Comment, String> {
    let mut file = read_file_or_default(&input.project_root)?;
    let idx = file
        .comments
        .iter()
        .position(|c| c.id == input.id)
        .ok_or_else(|| format!("comment not found: {}", input.id))?;
    let now = now_iso();
    let reply = Reply {
        author: input.author.clone(),
        body: input.body.clone(),
        ts: now.clone(),
    };
    file.comments[idx].replies.push(reply);
    file.comments[idx].updated_at = now.clone();
    let updated = file.comments[idx].clone();
    write_all(&input.project_root, &file)?;
    append_notification(
        &input.project_root,
        &serde_json::json!({
            "ts": now,
            "actor": input.author,
            "type": "reply_added",
            "comment_id": input.id,
            "body_preview": input.body.chars().take(80).collect::<String>(),
        }),
    )?;
    Ok(updated)
}

// ---------- Polling watcher ----------

pub struct CommentsWatcherState(pub Mutex<Option<tauri::async_runtime::JoinHandle<()>>>);

impl Default for CommentsWatcherState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

#[tauri::command]
pub fn comments_start_watcher(
    app: AppHandle,
    project_root: String,
    state: tauri::State<'_, CommentsWatcherState>,
) -> Result<(), String> {
    // Stop any existing watcher.
    if let Ok(mut guard) = state.0.lock() {
        if let Some(handle) = guard.take() {
            handle.abort();
        }
    }
    let path = comments_path(&project_root);
    let app_for_task = app.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let mut last_mtime: Option<std::time::SystemTime> = None;
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
            let current = fs::metadata(&path).ok().and_then(|m| m.modified().ok());
            if last_mtime.is_some() && current != last_mtime {
                let _ = app_for_task.emit(
                    "comments-changed",
                    serde_json::json!({
                        "path": path.to_string_lossy().into_owned(),
                    }),
                );
            }
            last_mtime = current;
        }
    });
    if let Ok(mut guard) = state.0.lock() {
        *guard = Some(handle);
    }
    Ok(())
}

#[tauri::command]
pub fn comments_stop_watcher(state: tauri::State<'_, CommentsWatcherState>) -> Result<(), String> {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(handle) = guard.take() {
            handle.abort();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn comments_write_does_not_follow_planted_symlink() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("secret.json");
        fs::write(&secret, "ORIGINAL").unwrap();
        let project = tmp.path();
        let comments = project.join(".claudeprism").join("comments.json");
        fs::create_dir_all(comments.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&secret, &comments).unwrap();

        let saved = comments_add(AddCommentInput {
            project_root: project.to_string_lossy().to_string(),
            file_path: "main.tex".to_string(),
            anchor: CommentAnchor {
                line_start: 1,
                line_end: 1,
                char_start: 0,
                char_end: 1,
                quoted_text: "a".to_string(),
            },
            ty: "comment".to_string(),
            author: "test".to_string(),
            comment: "note".to_string(),
            proposed_replacement: None,
        })
        .unwrap();

        assert_eq!(fs::read_to_string(&secret).unwrap(), "ORIGINAL");
        let meta = fs::symlink_metadata(&comments).unwrap();
        assert!(!meta.file_type().is_symlink());
        let on_disk = fs::read_to_string(&comments).unwrap();
        assert!(on_disk.contains(&saved.id));
        assert!(on_disk.contains("note"));
    }
}
