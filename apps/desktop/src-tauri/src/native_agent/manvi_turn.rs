//! One DevPrism chat turn, driven by `manvi run`.
//!
//! Manvi is the turn driver. This module resolves the binary, builds the
//! process environment, attaches the approve pipe on fd 3, and translates
//! Manvi's NDJSON `ui.Event` stream into the `claude-output` / `claude-complete`
//! events the chat UI already renders. It does not implement a second tool loop.

use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use base64::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager, WebviewWindow};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use super::manvi_sidecar;

const PROMPT_ARG_MAX: usize = 8 * 1024;
const MAX_IMAGES: usize = 4;
const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const APPROVE_FD: i32 = 3;
const SESSION_PREFIX: &str = "manvi:";

const OPUS: &str = "claude-opus-5-5";
const SONNET: &str = "claude-sonnet-5-5";
const HAIKU: &str = "claude-haiku-5-5";

/// Input nano-USD per token, matching Manvi's Anthropic price table.
/// Haiku 5.5's long-prompt rate is higher; the ceiling uses the base rate.
fn input_nano_usd(model: &str) -> Option<i64> {
    Some(match model {
        "claude-fable-5-1" | "claude-fable-5" => 10_000,
        "claude-opus-5" | "claude-opus-4-8" => 5_000,
        OPUS => 4_000,
        SONNET | "claude-sonnet-5" => 2_000,
        "claude-haiku-4-5" => 1_000,
        HAIKU => 100,
        _ => return None,
    })
}

/// Shipped tier model when `llm.provider.default` is anthropic.
fn shipped_tier_cost(tier: &str) -> Option<i64> {
    Some(match tier {
        "ADVISOR" => 10_000,
        "HEAVY" | "MAIN" => 4_000,
        "LITE" => 2_000,
        "BASIC" => 100,
        _ => return None,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProviderKind {
    Ollama,
    Compat,
    Anthropic,
}

pub(crate) struct RunRequest {
    pub window: WebviewWindow,
    pub project_path: String,
    pub prompt: String,
    pub tab_id: String,
    pub model: Option<String>,
    pub base_url: Option<String>,
    pub images: Option<Vec<String>>,
    pub num_ctx: Option<u32>,
    pub temperature: Option<f32>,
    pub keep_alive: Option<String>,
    pub active_file: Option<String>,
    pub selection: Option<String>,
    pub selection_start_line: Option<u32>,
    pub selection_end_line: Option<u32>,
    pub personalization_prompt: Option<String>,
    pub compile_state_prompt: Option<String>,
    pub chat_only: Option<bool>,
    pub effort_level: Option<String>,
    pub api_key: Option<String>,
    pub chat_provider: Option<String>,
    pub provider_credential_id: Option<String>,
    pub session_id: Option<String>,
}

struct StoredSession {
    id: String,
    project: String,
    state_dir: PathBuf,
}

struct PendingApproval {
    id: String,
    choices: Vec<String>,
    multi_select: bool,
}

struct TabPipe {
    writer: std::io::PipeWriter,
    pending: Option<PendingApproval>,
}

fn sessions() -> &'static Mutex<HashMap<String, StoredSession>> {
    static S: OnceLock<Mutex<HashMap<String, StoredSession>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

fn pipes() -> &'static Mutex<HashMap<String, TabPipe>> {
    static P: OnceLock<Mutex<HashMap<String, TabPipe>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_map<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Stop flags for turns that have started but whose Manvi child is not yet in
/// the process map, keyed like that map (`window:tab`). A Stop during the
/// pre-spawn awaits (version probe, Vertex mint, Ollama capability probe)
/// finds no child to signal, so it records the stop here instead.
fn pending_turns() -> &'static Mutex<HashMap<String, std::sync::Arc<AtomicBool>>> {
    static T: OnceLock<Mutex<HashMap<String, std::sync::Arc<AtomicBool>>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(HashMap::new()))
}

/// One turn's registration in [`pending_turns`]. Dropping it removes the entry
/// only if a newer turn on the same key has not replaced it.
struct PendingTurn {
    key: String,
    stopped: std::sync::Arc<AtomicBool>,
}

impl PendingTurn {
    fn begin(key: &str) -> Self {
        let stopped = std::sync::Arc::new(AtomicBool::new(false));
        lock_map(pending_turns()).insert(key.to_string(), stopped.clone());
        Self {
            key: key.to_string(),
            stopped,
        }
    }

    fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }
}

impl Drop for PendingTurn {
    fn drop(&mut self) {
        let mut guard = lock_map(pending_turns());
        if guard
            .get(&self.key)
            .is_some_and(|flag| std::sync::Arc::ptr_eq(flag, &self.stopped))
        {
            guard.remove(&self.key);
        }
    }
}

/// Mark the pending turn on `key` as stopped. A key with no pending turn is a
/// no-op, so a Stop with nothing starting never blocks the next turn.
fn request_stop(key: &str) {
    if let Some(flag) = lock_map(pending_turns()).get(key) {
        flag.store(true, Ordering::SeqCst);
    }
}

pub(crate) fn forget_tab(tab_id: &str) {
    let removed = lock_map(sessions()).remove(tab_id);
    drop_approval_writer(tab_id);
    if let Some(stored) = removed {
        forget_resume_record(&stored.state_dir, tab_id, &stored.id);
    }
}

pub(crate) fn drop_approval_writer(tab_id: &str) {
    lock_map(pipes()).remove(tab_id);
}

/// Map a picker alias or a catalogue id onto a catalogue id.
pub(crate) fn catalogue_model(model: &str) -> Result<String, String> {
    let trimmed = model.trim();
    match trimmed {
        "opus" | OPUS => Ok(OPUS.to_string()),
        "sonnet" | SONNET => Ok(SONNET.to_string()),
        "haiku" | HAIKU => Ok(HAIKU.to_string()),
        "opusplan" => {
            Err("OpusPlan has no Manvi catalogue id. Pick Opus, Sonnet, or Haiku.".into())
        }
        other if input_nano_usd(other).is_some() => Ok(other.to_string()),
        other => Err(format!(
            "Unknown Claude model `{other}`. Manvi accepts a catalogue id such as {OPUS}."
        )),
    }
}

/// Tier env that keeps a cheaper pick from spawning a more expensive shipped tier.
/// Equal cost is not pinned. `MAIN` is never pinned (`MANVI_MODEL` wins).
pub(crate) fn tier_ceiling(catalogue_id: &str) -> Result<Vec<(String, String)>, String> {
    let cost = input_nano_usd(catalogue_id).ok_or_else(|| {
        format!("No input price for `{catalogue_id}`, so a tier ceiling cannot be set.")
    })?;
    let mut out = Vec::new();
    for tier in ["ADVISOR", "HEAVY", "LITE", "BASIC"] {
        let shipped = shipped_tier_cost(tier).ok_or_else(|| format!("unknown tier {tier}"))?;
        if tier == "MAIN" {
            continue;
        }
        if shipped > cost {
            out.push((format!("MANVI_LLM_TIER_{tier}"), catalogue_id.to_string()));
        }
    }
    Ok(out)
}

pub(crate) fn provider_kind(chat_provider: Option<&str>) -> ProviderKind {
    match chat_provider {
        Some("anthropic") => ProviderKind::Anthropic,
        Some("openai-compat") => ProviderKind::Compat,
        _ => ProviderKind::Ollama,
    }
}

/// Settings win. The process environment is the same variable Manvi itself
/// reads, so a shell that already has a key does not need a second paste.
/// An empty stored key falls through; an empty environment key does not
/// invent one.
pub(crate) fn resolve_anthropic_credential(
    stored: Option<(String, Option<String>)>,
    env_key: Option<&str>,
    env_base: Option<&str>,
) -> Result<(String, Option<String>), String> {
    if let Some((key, base)) = stored {
        let key = key.trim();
        if !key.is_empty() {
            let base = base.filter(|value| !value.trim().is_empty());
            return Ok((key.to_string(), base));
        }
    }
    let key = env_key.unwrap_or("").trim();
    if key.is_empty() {
        return Err(
            "No Anthropic API key is available. Store one in Settings, or set ANTHROPIC_API_KEY for this app."
                .into(),
        );
    }
    let base = env_base
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Ok((key.to_string(), base))
}

fn effort_env(effort: Option<&str>) -> Result<Option<String>, String> {
    match effort.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(v @ ("low" | "medium" | "high")) => Ok(Some(v.to_string())),
        Some(other) => Err(format!(
            "Effort `{other}` is not a Manvi picker value. Use low, medium, or high."
        )),
    }
}

pub(crate) fn compose_prompt(
    user: &str,
    active_file: Option<&str>,
    selection: Option<&str>,
    selection_start_line: Option<u32>,
    selection_end_line: Option<u32>,
    compile_state: Option<&str>,
    personalization: Option<&str>,
) -> String {
    let mut prefix = String::new();
    if let Some(file) = active_file.map(str::trim).filter(|s| !s.is_empty()) {
        prefix.push_str("[Currently open file: ");
        prefix.push_str(file);
        prefix.push_str("]\n");
    }
    if let (Some(start), Some(end)) = (selection_start_line, selection_end_line) {
        prefix.push_str(&format!("[Selection lines: {start}-{end}]\n"));
    }
    if let Some(sel) = selection.map(str::trim).filter(|s| !s.is_empty()) {
        prefix.push_str("[Selected text:\n");
        prefix.push_str(sel);
        prefix.push_str("\n]\n");
    }
    if let Some(compile) = compile_state.map(str::trim).filter(|s| !s.is_empty()) {
        prefix.push_str("[Last compile:\n");
        prefix.push_str(compile);
        prefix.push_str("\n]\n");
    }
    if let Some(profile) = personalization.map(str::trim).filter(|s| !s.is_empty()) {
        prefix.push_str(profile);
        prefix.push('\n');
    }
    if prefix.is_empty() {
        user.to_string()
    } else {
        format!("{prefix}\n{user}")
    }
}

fn ollama_v1(base: &str) -> String {
    let trimmed = base.trim().trim_end_matches('/');
    let root = if trimmed.is_empty() {
        "http://127.0.0.1:11434"
    } else {
        trimmed
    };
    if root.ends_with("/v1") {
        root.to_string()
    } else {
        format!("{root}/v1")
    }
}

fn url_host(base: &str) -> String {
    let rest = base
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    let hostport = rest.split('/').next().unwrap_or("");
    if let Some(inner) = hostport.strip_prefix('[') {
        return inner.split(']').next().unwrap_or("").to_string();
    }
    hostport.split(':').next().unwrap_or("").to_string()
}

fn is_loopback(base: &str) -> bool {
    matches!(url_host(base).as_str(), "localhost" | "127.0.0.1" | "::1")
}

struct ResumeDecision {
    id: Option<String>,
}

fn decide_resume(
    tab_id: &str,
    project: &str,
    requested: Option<&str>,
    state_dir: &Path,
) -> ResumeDecision {
    let Some(raw) = requested.map(str::trim).filter(|s| !s.is_empty()) else {
        return ResumeDecision { id: None };
    };
    let Some(id) = raw.strip_prefix(SESSION_PREFIX) else {
        return ResumeDecision { id: None };
    };
    if id.is_empty() || id.chars().any(char::is_whitespace) {
        return ResumeDecision { id: None };
    }
    let memory = {
        let guard = lock_map(sessions());
        guard.get(tab_id).map(|stored| StoredSession {
            id: stored.id.clone(),
            project: stored.project.clone(),
            state_dir: stored.state_dir.clone(),
        })
    };
    if let Some(stored) = memory {
        return if stored.id == id && stored.project == project {
            ResumeDecision {
                id: Some(id.to_string()),
            }
        } else {
            // This process already bound the tab. A disk row must not override it.
            ResumeDecision { id: None }
        };
    }
    // The in-memory map is empty after a restart. The id still has to be one
    // this host stored for this paper, and Manvi has to have the session file.
    if resume_record_has(state_dir, id) && session_on_disk(state_dir, id) {
        ResumeDecision {
            id: Some(id.to_string()),
        }
    } else {
        ResumeDecision { id: None }
    }
}

pub(crate) struct TurnPlan {
    pub argv: Vec<String>,
    pub env: Vec<(String, String)>,
    pub stdin_prompt: Option<String>,
}

pub(crate) struct PlanInput<'a> {
    pub prompt: &'a str,
    pub resume_id: Option<&'a str>,
    pub image_paths: &'a [PathBuf],
    pub provider: ProviderKind,
    pub catalogue_or_local_model: &'a str,
    pub effort: Option<&'a str>,
    pub base_url: Option<&'a str>,
    pub local_api_key: Option<&'a str>,
    pub anthropic_key: Option<&'a str>,
    pub anthropic_base: Option<&'a str>,
    pub project: &'a Path,
    pub state_dir: &'a Path,
    pub mcp_config: &'a Path,
    pub mcp_trust: &'a str,
    pub temperature: Option<f32>,
    pub num_ctx: Option<u32>,
    pub keep_alive: Option<&'a str>,
    pub chat_only: bool,
}

pub(crate) fn build_plan(input: &PlanInput<'_>) -> Result<TurnPlan, String> {
    if input.prompt.trim().is_empty() {
        return Err("Manvi run needs a prompt.".into());
    }
    if input.image_paths.len() > MAX_IMAGES {
        return Err(format!(
            "At most {MAX_IMAGES} images can be attached to one Manvi turn."
        ));
    }
    let effort = effort_env(input.effort)?;
    let mut argv = vec![
        "run".to_string(),
        "--json".to_string(),
        "--approve-fd".to_string(),
        APPROVE_FD.to_string(),
        "--timeout".to_string(),
        "30m".to_string(),
    ];
    if let Some(id) = input.resume_id {
        argv.push("--resume".into());
        argv.push(id.to_string());
    }
    for path in input.image_paths {
        argv.push("--image".into());
        argv.push(path.display().to_string());
    }
    if input.chat_only {
        argv.push("--chat-only".into());
    }
    let stdin_prompt = if input.prompt.len() < PROMPT_ARG_MAX {
        argv.push("-p".into());
        argv.push(input.prompt.to_string());
        None
    } else {
        Some(input.prompt.to_string())
    };

    let mut env: Vec<(String, String)> = Vec::new();
    let set = |env: &mut Vec<(String, String)>, k: &str, v: String| {
        env.push((k.to_string(), v));
    };
    set(
        &mut env,
        "MANVI_PROJECT_ROOT",
        input.project.display().to_string(),
    );
    set(&mut env, "MANVI_HARNESS_INIT_ENABLED", "false".into());
    set(
        &mut env,
        "MANVI_STATE_DIR",
        input.state_dir.display().to_string(),
    );
    set(
        &mut env,
        "MANVI_MCP_CONFIG",
        input.mcp_config.display().to_string(),
    );
    set(&mut env, "MANVI_MCP_TRUST", input.mcp_trust.to_string());
    if let Some(level) = effort {
        set(&mut env, "MANVI_LLM_EFFORT", level);
    }

    match input.provider {
        ProviderKind::Anthropic => {
            let raw = input.catalogue_or_local_model.trim();
            set(&mut env, "MANVI_LLM_PROVIDER_DEFAULT", "anthropic".into());
            if raw == "opusplan" {
                // Opus plans. Sonnet writes. Advisor stays on Opus so a plan
                // does not escalate to the shipped Fable tier. Lite and basic
                // stay at their shipped models: both are cheaper than Opus.
                // MAIN is never pinned.
                set(&mut env, "MANVI_MODEL", OPUS.to_string());
                set(&mut env, "MANVI_LLM_TIER_HEAVY", SONNET.to_string());
                set(&mut env, "MANVI_LLM_TIER_ADVISOR", OPUS.to_string());
            } else {
                let catalogue = catalogue_model(raw)?;
                set(&mut env, "MANVI_MODEL", catalogue.clone());
                for (k, v) in tier_ceiling(&catalogue)? {
                    set(&mut env, &k, v);
                }
            }
            if let Some(key) = input.anthropic_key {
                set(&mut env, "ANTHROPIC_API_KEY", key.to_string());
            }
            if let Some(base) = input
                .anthropic_base
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                set(&mut env, "ANTHROPIC_BASE_URL", base.to_string());
            }
        }
        ProviderKind::Ollama | ProviderKind::Compat => {
            let ollama = input.provider == ProviderKind::Ollama;
            let base = if ollama {
                ollama_v1(input.base_url.unwrap_or("http://127.0.0.1:11434"))
            } else {
                input
                    .base_url
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or("http://127.0.0.1:8000/v1")
                    .trim_end_matches('/')
                    .to_string()
            };
            set(&mut env, "MANVI_LLM_PROVIDER_DEFAULT", "local".into());
            set(&mut env, "MANVI_LLM_LOCAL_BASE_URL", base.clone());
            let model = input.catalogue_or_local_model.trim();
            if !model.is_empty() {
                set(&mut env, "MANVI_LLM_LOCAL_MODEL", model.to_string());
            }
            if let Some(temp) = input.temperature {
                set(&mut env, "MANVI_LLM_LOCAL_TEMPERATURE", temp.to_string());
            }
            if let Some(ctx) = input.num_ctx {
                set(&mut env, "MANVI_LLM_LOCAL_CONTEXT_WINDOW", ctx.to_string());
            }
            if ollama {
                // Unset still means 10m, which is what the previous engine sent.
                // A non-Ollama server can reject an unknown JSON field, so the
                // variable is set only here.
                set(
                    &mut env,
                    "MANVI_LLM_LOCAL_KEEP_ALIVE",
                    super::ollama::normalize_keep_alive(input.keep_alive),
                );
            }
            if !is_loopback(&base) {
                let key = input.local_api_key.unwrap_or("").trim();
                if !key.is_empty() {
                    set(&mut env, "LOCAL_API_KEY", key.to_string());
                } else if !ollama {
                    // Ollama has no authentication, so a LAN or container host
                    // needs no key; Manvi's local key is optional too.
                    return Err(
                        "[E_AUTH] API key is required for a non-loopback local provider.".into(),
                    );
                }
            }
        }
    }
    Ok(TurnPlan {
        argv,
        env,
        stdin_prompt,
    })
}

fn mcp_fingerprint(name: &str, command: &str, args: &[&str], env: &[(&str, &str)]) -> String {
    let mut h = Sha256::new();
    let write = |h: &mut Sha256, label: &str, value: &str| {
        let _ = write!(h, "{label}\0{}\0{value}\0", value.len());
    };
    write(&mut h, "name", name);
    write(&mut h, "command", command);
    let _ = write!(h, "args\0{}\0", args.len());
    for arg in args {
        write(&mut h, "arg", arg);
    }
    let mut keys: Vec<&&str> = env.iter().map(|(k, _)| k).collect();
    keys.sort_unstable();
    let _ = write!(h, "env\0{}\0", keys.len());
    for key in keys {
        let value = env
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| *v)
            .unwrap_or("");
        write(&mut h, &format!("env.{key}"), value);
    }
    let _ = write!(h, "passthrough\0{}\0", 0);
    format!("sha256:{:x}", h.finalize())
}

/// Manvi refuses `llm.tier` and every `llm.tier.*` key, nested or written as
/// a flat dotted key. A paper that sets one cannot start, so the host says
/// so before spawning.
fn is_tier_key(key: &str) -> bool {
    key == "llm.tier" || key.starts_with("llm.tier.")
}

fn mapping_sets_tier(value: &serde_yaml::Value, prefix: &str) -> bool {
    let Some(map) = value.as_mapping() else {
        return false;
    };
    for (key, child) in map {
        let Some(key) = key.as_str() else {
            continue;
        };
        let dotted = if prefix.is_empty() {
            key.to_string()
        } else {
            format!("{prefix}.{key}")
        };
        if is_tier_key(key) || is_tier_key(&dotted) {
            return true;
        }
        if mapping_sets_tier(child, &dotted) {
            return true;
        }
    }
    false
}

fn project_pins_llm_tier(project: &Path) -> Result<bool, String> {
    let path = project.join(".devcouncil").join("config.yaml");
    if !path.is_file() {
        return Ok(false);
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    let value: serde_yaml::Value = serde_yaml::from_str(&text)
        .map_err(|e| format!("{} is not valid YAML: {e}", path.display()))?;
    Ok(mapping_sets_tier(&value, ""))
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct HostResume {
    #[serde(default)]
    tabs: HashMap<String, String>,
    #[serde(default)]
    latest: Option<String>,
}

fn host_resume_path(state_dir: &Path) -> PathBuf {
    state_dir.join("host-resume.json")
}

fn read_host_resume(state_dir: &Path) -> HostResume {
    let Ok(text) = std::fs::read_to_string(host_resume_path(state_dir)) else {
        return HostResume::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn write_host_resume(state_dir: &Path, doc: &HostResume) {
    let Ok(body) = serde_json::to_vec(doc) else {
        return;
    };
    let tmp = state_dir.join("host-resume.json.tmp");
    if std::fs::write(&tmp, body).is_err() {
        return;
    }
    if std::fs::rename(&tmp, host_resume_path(state_dir)).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

fn resume_record_has(state_dir: &Path, id: &str) -> bool {
    let doc = read_host_resume(state_dir);
    doc.latest.as_deref() == Some(id) || doc.tabs.values().any(|stored| stored == id)
}

fn forget_resume_record(state_dir: &Path, tab_id: &str, id: &str) {
    let mut doc = read_host_resume(state_dir);
    if doc.tabs.get(tab_id).map(String::as_str) == Some(id) {
        doc.tabs.remove(tab_id);
    }
    if doc.latest.as_deref() == Some(id) {
        doc.latest = None;
    }
    write_host_resume(state_dir, &doc);
}

/// Manvi session files are `<id>.<generation>.json` under `STATE_DIR/sessions`.
/// The id is lowercase hex, so it cannot be a path.
fn session_on_disk(state_dir: &Path, id: &str) -> bool {
    if id.is_empty()
        || id.len() > 64
        || !id
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    {
        return false;
    }
    let Ok(entries) = std::fs::read_dir(state_dir.join("sessions")) else {
        return false;
    };
    let prefix = format!("{id}.");
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let Some(rest) = name.strip_prefix(&prefix) else {
            continue;
        };
        let Some(generation) = rest.strip_suffix(".json") else {
            continue;
        };
        if !generation.is_empty()
            && generation != "0"
            && generation.chars().all(|c| c.is_ascii_digit())
        {
            return true;
        }
    }
    false
}

/// The on-device profile, plus a caller string when that string is not already
/// the profile. An empty profile and an empty extra produce an empty prefix.
fn merge_personalization(built: &str, extra: Option<&str>) -> String {
    let built = built.trim();
    let extra = extra.map(str::trim).filter(|s| !s.is_empty());
    match (built.is_empty(), extra) {
        (true, None) => String::new(),
        (true, Some(extra)) => extra.to_string(),
        (false, None) => built.to_string(),
        (false, Some(extra)) if extra.contains(built) => extra.to_string(),
        (false, Some(extra)) => format!("{built}\n\n{extra}"),
    }
}

fn remember_session(tab_id: &str, project: &str, id: &str, state_dir: &Path) {
    lock_map(sessions()).insert(
        tab_id.to_string(),
        StoredSession {
            id: id.to_string(),
            project: project.to_string(),
            state_dir: state_dir.to_path_buf(),
        },
    );
    let mut doc = read_host_resume(state_dir);
    doc.tabs.insert(tab_id.to_string(), id.to_string());
    doc.latest = Some(id.to_string());
    write_host_resume(state_dir, &doc);
}

struct OpenTool {
    id: String,
    question: bool,
    emitted: bool,
}

struct Translator {
    seq: u64,
    open: VecDeque<OpenTool>,
    side_approvals: Vec<String>,
    saw_error: bool,
}

fn is_question_tool(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n == "devcouncil_ask_question" || n == "askuser" || n.ends_with("ask_question")
}

/// Phase string the chat watchdog already understands. Unknown events leave the
/// previous phase in place.
fn activity_phase(ev: &Value) -> Option<&'static str> {
    match ev.get("kind").and_then(|k| k.as_str()) {
        Some("assistant.reasoning") => Some("thinking"),
        Some("assistant.text") => Some("chat"),
        Some("approval.request") => Some("ask_user"),
        Some("tool.start") => {
            let name = ev.get("tool").and_then(|v| v.as_str()).unwrap_or("");
            Some(if is_question_tool(name) {
                "ask_user"
            } else {
                "tool"
            })
        }
        Some("tool.result") => Some("chat"),
        _ => None,
    }
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// Translate one Manvi event into zero or more chat messages.
fn translate(st: &mut Translator, ev: &Value) -> Vec<Value> {
    let kind = ev.get("kind").and_then(|k| k.as_str()).unwrap_or("");
    match kind {
        "session.start" => {
            let Some(id) = ev.get("session_id").and_then(|v| v.as_str()) else {
                return Vec::new();
            };
            if id.is_empty() {
                return Vec::new();
            }
            vec![json!({
                "type": "system",
                "subtype": "init",
                "session_id": format!("{SESSION_PREFIX}{id}"),
            })]
        }
        "assistant.text" => {
            let text = ev.get("text").and_then(|v| v.as_str()).unwrap_or("");
            if text.is_empty() {
                return Vec::new();
            }
            vec![super::delta_coalesce::streaming_delta_event(
                super::ollama::StreamDeltaKind::Text,
                text,
            )]
        }
        "assistant.reasoning" => {
            let text = ev.get("text").and_then(|v| v.as_str()).unwrap_or("");
            if text.is_empty() {
                return Vec::new();
            }
            vec![super::delta_coalesce::streaming_delta_event(
                super::ollama::StreamDeltaKind::Thinking,
                text,
            )]
        }
        "tool.start" => {
            st.seq += 1;
            let id = format!("tool-{}", st.seq);
            let name = ev.get("tool").and_then(|v| v.as_str()).unwrap_or("tool");
            let question = is_question_tool(name);
            let mut out = Vec::new();
            if !question {
                let input = ev.get("arguments").cloned().unwrap_or(json!({}));
                out.push(json!({
                    "type": "assistant",
                    "message": { "content": [{
                        "type": "tool_use",
                        "id": id,
                        "name": name,
                        "input": input,
                    }]}
                }));
            }
            st.open.push_back(OpenTool {
                id,
                question,
                emitted: !question,
            });
            out
        }
        "approval.request" => {
            let id = ev
                .get("approval_id")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| {
                    st.seq += 1;
                    format!("approval-{}", st.seq)
                });
            let choices = string_list(ev.get("choices"));
            let multi = ev
                .get("multi_select")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let question = ev.get("text").and_then(|v| v.as_str()).unwrap_or("");
            if let Some(tool) = st.open.iter_mut().rev().find(|t| t.question && !t.emitted) {
                tool.id = id.clone();
                tool.emitted = true;
            } else {
                st.side_approvals.push(id.clone());
            }
            vec![json!({
                "type": "assistant",
                "message": { "content": [{
                    "type": "tool_use",
                    "id": id,
                    "name": "AskUser",
                    "input": {
                        "question": question,
                        "options": choices,
                        "multi_select": multi,
                    },
                }]}
            })]
        }
        "tool.result" => {
            let text = ev.get("text").and_then(|v| v.as_str()).unwrap_or("");
            let is_error = ev
                .get("is_error")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let mut ids = Vec::new();
            if let Some(tool) = st.open.pop_front() {
                if tool.emitted {
                    ids.push(tool.id);
                }
            }
            ids.extend(st.side_approvals.drain(..));
            ids.into_iter()
                .map(|id| {
                    json!({
                        "type": "user",
                        "message": { "content": [{
                            "type": "tool_result",
                            "tool_use_id": id,
                            "content": text,
                            "is_error": is_error,
                        }]}
                    })
                })
                .collect()
        }
        "harness.message" | "notice" => {
            let text = ev.get("text").and_then(|v| v.as_str()).unwrap_or("");
            if text.is_empty() {
                Vec::new()
            } else {
                vec![json!({
                    "type": "system",
                    "subtype": "harness_notice",
                    "text": text,
                })]
            }
        }
        "error" => {
            st.saw_error = true;
            let text = ev
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("Manvi reported an error.");
            vec![result_message(false, text)]
        }
        "step.usage" | "verify.report" | "diagnostic" | "approval.decided" | "turn.start"
        | "turn.usage" | "run.report" | "policy.decision" | "lease.change" | "turn.end" => {
            Vec::new()
        }
        _ => Vec::new(),
    }
}

fn result_message(ok: bool, text: &str) -> Value {
    json!({
        "type": "result",
        "subtype": if ok { "success" } else { "error" },
        "is_error": !ok,
        "result": text,
    })
}

fn remember_stderr_line(slot: &Mutex<String>, line: &str) {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.contains("sk-ant-") {
        return;
    }
    *lock_map(slot) = truncate_chars(trimmed, 300).to_string();
}

fn truncate_chars(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn with_stderr_tail(base: &str, stderr_tail: &str) -> String {
    let tail = stderr_tail.trim();
    if tail.is_empty() || base.contains(tail) {
        base.to_string()
    } else {
        format!("{base} {tail}")
    }
}

fn exit_status_error(code: i32, stderr_tail: &str) -> Option<String> {
    let base = match code {
        0 => return None,
        2 => "Manvi stopped at the step ceiling.",
        3 => "Manvi stopped because the output cap was reached.",
        4 => "Manvi finished without an answer.",
        5 => "Manvi finished with the turn unfinished.",
        other => {
            return Some(with_stderr_tail(
                &format!("Manvi exited with status {other}."),
                stderr_tail,
            ));
        }
    };
    Some(with_stderr_tail(base, stderr_tail))
}

/// Assistant text the previous engine emitted when `/api/show` listed
/// capabilities and `tools` was not among them.
fn chat_only_notice(model: &str) -> Value {
    json!({
        "type": "assistant",
        "message": { "content": [{
            "type": "text",
            "text": format!(
                "_Chat-only mode: the model '{model}' does not support tool calling, so file edits are unavailable in this tab. Pick a tools-capable model (e.g. llama3.2, qwen2.5, mistral-nemo) for agent edits._",
            ),
        }]}
    })
}

fn emit_msg(window: &WebviewWindow, tab_id: &str, msg: &Value) {
    let _ = window.emit(
        "claude-output",
        json!({ "tab_id": tab_id, "data": msg.to_string() }),
    );
}

fn emit_complete(window: &WebviewWindow, tab_id: &str, success: bool) {
    let _ = window.emit(
        "claude-complete",
        json!({ "tab_id": tab_id, "success": success }),
    );
}

const STOPPED_BEFORE_START: &str = "Stopped before Manvi started.";

fn fail_turn(window: &WebviewWindow, tab_id: &str, message: &str) -> Result<(), String> {
    emit_msg(window, tab_id, &result_message(false, message));
    emit_complete(window, tab_id, false);
    Err(message.to_string())
}

fn decode_images(raw: &[String]) -> Result<Vec<Vec<u8>>, String> {
    if raw.len() > MAX_IMAGES {
        return Err(format!(
            "At most {MAX_IMAGES} images can be attached to one Manvi turn."
        ));
    }
    let mut out = Vec::with_capacity(raw.len());
    for (idx, item) in raw.iter().enumerate() {
        let bytes = BASE64_STANDARD
            .decode(item.trim())
            .map_err(|_| format!("Image {} is not valid base64.", idx + 1))?;
        if bytes.len() > MAX_IMAGE_BYTES {
            return Err(format!("Image {} is larger than 8 MiB.", idx + 1));
        }
        if bytes.is_empty() {
            return Err(format!("Image {} is empty.", idx + 1));
        }
        out.push(bytes);
    }
    Ok(out)
}

async fn binary_withholds_anthropic_key(binary: &Path) -> Result<(), String> {
    let output = Command::new(binary)
        .args(["version", "--json"])
        .output()
        .await
        .map_err(|e| format!("Could not run `manvi version --json`: {e}"))?;
    if !output.status.success() {
        return Err("`manvi version --json` failed, so the Anthropic key was not injected.".into());
    }
    let parsed: Value = serde_json::from_slice(&output.stdout).map_err(|_| {
        "`manvi version --json` did not return JSON, so the Anthropic key was not injected."
            .to_string()
    })?;
    let names = parsed
        .get("withheld_provider_env")
        .and_then(|v| v.as_array())
        .ok_or_else(|| {
            "This manvi build does not advertise withheld_provider_env, so the Anthropic key was not injected.".to_string()
        })?;
    let listed = names
        .iter()
        .any(|v| v.as_str() == Some("ANTHROPIC_API_KEY"));
    if !listed {
        return Err(
            "This manvi build does not withhold ANTHROPIC_API_KEY from its children, so the key was not injected.".into(),
        );
    }
    Ok(())
}

fn clear_owned_env(cmd: &mut Command) {
    for key in [
        "MANVI_MODEL",
        "MANVI_LLM_EFFORT",
        "MANVI_LLM_PROVIDER_DEFAULT",
        "MANVI_LLM_LOCAL_BASE_URL",
        "MANVI_LLM_LOCAL_MODEL",
        "MANVI_LLM_LOCAL_TEMPERATURE",
        "MANVI_LLM_LOCAL_CONTEXT_WINDOW",
        "MANVI_LLM_LOCAL_KEEP_ALIVE",
        "MANVI_LLM_TIER_ADVISOR",
        "MANVI_LLM_TIER_HEAVY",
        "MANVI_LLM_TIER_MAIN",
        "MANVI_LLM_TIER_LITE",
        "MANVI_LLM_TIER_BASIC",
        "MANVI_LLM_TIER_ADVISOR_EFFORT",
        "MANVI_LLM_TIER_HEAVY_EFFORT",
        "MANVI_LLM_TIER_MAIN_EFFORT",
        "MANVI_LLM_TIER_LITE_EFFORT",
        "MANVI_LLM_TIER_BASIC_EFFORT",
        "LOCAL_API_KEY",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_API_KEY_FALLBACK",
    ] {
        cmd.env_remove(key);
    }
}

pub(crate) fn answer(request_id: &str, answer: &str) -> Result<(), String> {
    let mut guard = lock_map(pipes());
    let Some(tab) = guard
        .values_mut()
        .find(|tab| tab.pending.as_ref().is_some_and(|p| p.id == request_id))
    else {
        return Err(
            "No pending question with this id — it may have been answered already, timed out, or the run was stopped.".into(),
        );
    };
    let pending = tab.pending.take().ok_or_else(|| {
        "No pending question with this id — it may have been answered already, timed out, or the run was stopped.".to_string()
    })?;
    let line = decision_line(&pending, answer)?;
    tab.writer
        .write_all(line.as_bytes())
        .map_err(|e| format!("Could not write the approval decision: {e}"))?;
    tab.writer
        .flush()
        .map_err(|e| format!("Could not flush the approval decision: {e}"))?;
    Ok(())
}

fn decision_line(pending: &PendingApproval, answer: &str) -> Result<String, String> {
    let trimmed = answer.trim();
    if trimmed.is_empty() {
        return Ok(decision_json(
            &pending.id,
            false,
            Vec::new(),
            None,
            Some("empty answer"),
        ));
    }
    if pending.multi_select {
        let parsed: Result<Vec<String>, _> = serde_json::from_str(trimmed);
        let Ok(chosen) = parsed else {
            return Ok(decision_json(
                &pending.id,
                false,
                Vec::new(),
                None,
                Some("multi-select answer was not a JSON string array"),
            ));
        };
        if chosen.is_empty()
            || chosen
                .iter()
                .any(|item| !pending.choices.iter().any(|c| c == item))
        {
            return Ok(decision_json(
                &pending.id,
                false,
                Vec::new(),
                None,
                Some("multi-select answer was not a subset of the choices"),
            ));
        }
        return Ok(decision_json(&pending.id, true, chosen, None, None));
    }
    if pending.choices.is_empty() {
        return Ok(decision_json(
            &pending.id,
            true,
            Vec::new(),
            None,
            Some(trimmed),
        ));
    }
    if pending.choices.iter().any(|c| c == trimmed) {
        return Ok(decision_json(
            &pending.id,
            true,
            vec![trimmed.to_string()],
            None,
            None,
        ));
    }
    Ok(decision_json(
        &pending.id,
        true,
        Vec::new(),
        Some(trimmed),
        None,
    ))
}

fn decision_json(
    id: &str,
    allow: bool,
    chosen: Vec<String>,
    write_in: Option<&str>,
    reason: Option<&str>,
) -> String {
    // Empty strings, not JSON null: Manvi decodes these into Go strings, and
    // a null value fails that decode and becomes a refusal.
    let line = json!({
        "approval_id": id,
        "allow": allow,
        "chosen": chosen,
        "write_in": write_in.unwrap_or(""),
        "reason": reason.unwrap_or(""),
    });
    format!("{line}\n")
}

fn register_pending(tab_id: &str, ev: &Value) {
    let id = ev
        .get("approval_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if id.is_empty() {
        return;
    }
    let mut guard = lock_map(pipes());
    let Some(tab) = guard.get_mut(tab_id) else {
        return;
    };
    tab.pending = Some(PendingApproval {
        id,
        choices: string_list(ev.get("choices")),
        multi_select: ev
            .get("multi_select")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
    });
}

pub async fn run(req: RunRequest) -> Result<(), String> {
    #[cfg(not(unix))]
    {
        let _ = req;
        return Err(
            "Manvi chat needs a POSIX approve fd (fd 3). This build cannot open one.".into(),
        );
    }
    #[cfg(unix)]
    {
        run_unix(req).await
    }
}

#[cfg(unix)]
async fn run_unix(req: RunRequest) -> Result<(), String> {
    let RunRequest {
        window,
        project_path,
        prompt,
        tab_id,
        model,
        base_url,
        images,
        num_ctx,
        temperature,
        keep_alive,
        active_file,
        selection,
        selection_start_line,
        selection_end_line,
        personalization_prompt,
        compile_state_prompt,
        chat_only,
        effort_level,
        api_key,
        chat_provider,
        provider_credential_id,
        session_id,
    } = req;
    let pending = PendingTurn::begin(&format!("{}:{}", window.label(), tab_id));

    let binary = match manvi_sidecar::resolve_binary() {
        Ok(path) => path,
        Err(err) => {
            return fail_turn(&window, &tab_id, &err);
        }
    };
    let project = PathBuf::from(&project_path);
    if !project.is_dir() {
        return fail_turn(
            &window,
            &tab_id,
            &format!("Project folder is not a directory: {project_path}"),
        );
    }
    let project = match project.canonicalize() {
        Ok(path) => path,
        Err(err) => {
            return fail_turn(
                &window,
                &tab_id,
                &format!("Could not resolve the project folder: {err}"),
            );
        }
    };
    if let Err(err) = project_pins_llm_tier(&project).and_then(|pinned| {
        if pinned {
            Err(
                "This project's .devcouncil/config.yaml sets llm.tier. DevPrism does not let a paper choose the chat model."
                    .into(),
            )
        } else {
            Ok(())
        }
    }) {
        return fail_turn(&window, &tab_id, &err);
    }

    let kind = provider_kind(chat_provider.as_deref());
    let (anthropic_key, anthropic_base) = if kind == ProviderKind::Anthropic {
        if let Err(err) = binary_withholds_anthropic_key(&binary).await {
            return fail_turn(&window, &tab_id, &err);
        }
        match resolve_anthropic_credential(
            crate::claude::claude_credential_for_manvi().map(|cred| (cred.api_key, cred.base_url)),
            std::env::var("ANTHROPIC_API_KEY").ok().as_deref(),
            std::env::var("ANTHROPIC_BASE_URL").ok().as_deref(),
        ) {
            Ok((key, base)) => (Some(key), base),
            Err(err) => return fail_turn(&window, &tab_id, &err),
        }
    } else {
        (None, None)
    };

    let local_key = if kind == ProviderKind::Compat {
        let stored = api_key.filter(|k| !k.trim().is_empty()).or_else(|| {
            crate::claude::openai_credential_api_key(provider_credential_id.as_deref(), "")
        });
        // Vertex with an empty or API-key credential mints a bearer here.
        // The token is the local key Manvi already sends; it is not logged.
        // A non-Vertex host with an empty key stays None and fails closed
        // when the base is not loopback.
        match crate::google_auth::resolve_vertex_bearer_token(
            base_url.as_deref().unwrap_or(""),
            stored.as_deref().unwrap_or(""),
        )
        .await
        {
            Ok(token) => token,
            Err(err) => return fail_turn(&window, &tab_id, &err),
        }
    } else {
        None
    };

    let model_for_plan = match kind {
        ProviderKind::Anthropic => model.unwrap_or_else(|| "opus".to_string()),
        ProviderKind::Ollama | ProviderKind::Compat => model.unwrap_or_default(),
    };

    let image_bytes = match decode_images(images.as_deref().unwrap_or(&[])) {
        Ok(bytes) => bytes,
        Err(err) => return fail_turn(&window, &tab_id, &err),
    };

    let app = window.app_handle();
    let app_data = match app.path().app_data_dir() {
        Ok(dir) => dir,
        Err(err) => {
            return fail_turn(&window, &tab_id, &format!("App data directory: {err}"));
        }
    };
    // One store per paper. Manvi keeps every session in STATE_DIR/sessions and
    // prunes that directory, so a shared directory would drop another project's
    // transcripts and make a resume id from paper A resolvable inside paper B.
    let state_dir = project_state_dir(&app_data, &project);
    let sessions_dir = state_dir.join("sessions");
    if let Err(err) = std::fs::create_dir_all(&sessions_dir) {
        return fail_turn(
            &window,
            &tab_id,
            &format!("Could not create the Manvi session directory: {err}"),
        );
    }
    let image_dir = state_dir.join("images").join(sanitize_tab(&tab_id));
    if !image_bytes.is_empty() {
        if let Err(err) = std::fs::create_dir_all(&image_dir) {
            return fail_turn(&window, &tab_id, &format!("Could not store images: {err}"));
        }
    }
    // Drop removes anything still staged. The wait task takes ownership only
    // after the child is registered, and deletes the files once that child exits.
    let mut staged_images = StagedImages(Vec::with_capacity(image_bytes.len()));
    for (idx, bytes) in image_bytes.iter().enumerate() {
        let path = image_dir.join(format!("{idx}.img"));
        if let Err(err) = std::fs::write(&path, bytes) {
            staged_images.0.push(path);
            return fail_turn(
                &window,
                &tab_id,
                &format!("Could not store an image: {err}"),
            );
        }
        staged_images.0.push(path);
    }

    let exe = match std::env::current_exe() {
        Ok(path) => path,
        Err(err) => {
            return fail_turn(
                &window,
                &tab_id,
                &format!("Could not resolve this app binary: {err}"),
            );
        }
    };
    let project_string = project.display().to_string();
    let mcp_body = json!({
        "mcpServers": {
            "devprism": {
                "command": exe.display().to_string(),
                "args": ["--mcp"],
                "env": { "DEVPRISM_PROJECT": project_string }
            }
        }
    });
    let mcp_config = state_dir.join(format!("mcp-{}.json", sanitize_tab(&tab_id)));
    if let Err(err) = std::fs::write(&mcp_config, mcp_body.to_string()) {
        return fail_turn(
            &window,
            &tab_id,
            &format!("Could not write the MCP config: {err}"),
        );
    }
    let trust = mcp_fingerprint(
        "devprism",
        &exe.display().to_string(),
        &["--mcp"],
        &[("DEVPRISM_PROJECT", project_string.as_str())],
    );

    let mut chat_only_flag = chat_only.unwrap_or(false);
    if kind == ProviderKind::Ollama && !chat_only_flag {
        // `None` (the server did not say) keeps tools. Only a definite
        // "no tools" capability list forces the flag.
        let probe = super::ollama::OllamaClient::new(
            base_url.as_deref().unwrap_or("http://127.0.0.1:11434"),
            model_for_plan.trim(),
            num_ctx,
            temperature,
        );
        if probe.supports_tools().await == Some(false) {
            chat_only_flag = true;
            emit_msg(&window, &tab_id, &chat_only_notice(model_for_plan.trim()));
        }
    }

    let profile = crate::personalization::build_personalization_prompt();
    let merged = merge_personalization(&profile, personalization_prompt.as_deref());
    let composed = compose_prompt(
        &prompt,
        active_file.as_deref(),
        selection.as_deref(),
        selection_start_line,
        selection_end_line,
        compile_state_prompt.as_deref(),
        (!merged.is_empty()).then_some(merged.as_str()),
    );
    let resume = decide_resume(&tab_id, &project_string, session_id.as_deref(), &state_dir);
    let plan = match build_plan(&PlanInput {
        prompt: &composed,
        resume_id: resume.id.as_deref(),
        image_paths: &staged_images.0,
        provider: kind,
        catalogue_or_local_model: &model_for_plan,
        effort: effort_level.as_deref(),
        base_url: base_url.as_deref(),
        local_api_key: local_key.as_deref(),
        anthropic_key: anthropic_key.as_deref(),
        anthropic_base: anthropic_base.as_deref(),
        project: &project,
        state_dir: &state_dir,
        mcp_config: &mcp_config,
        mcp_trust: &trust,
        temperature: if kind == ProviderKind::Anthropic {
            None
        } else {
            temperature
        },
        num_ctx: if kind == ProviderKind::Anthropic {
            None
        } else {
            num_ctx
        },
        keep_alive: keep_alive.as_deref(),
        chat_only: chat_only_flag,
    }) {
        Ok(plan) => plan,
        Err(err) => return fail_turn(&window, &tab_id, &err),
    };

    let (read_pipe, write_pipe) = match std::io::pipe() {
        Ok(pair) => pair,
        Err(err) => {
            return fail_turn(
                &window,
                &tab_id,
                &format!("Could not open the approve pipe: {err}"),
            );
        }
    };
    let read_fd = std::os::fd::AsRawFd::as_raw_fd(&read_pipe);

    let mut cmd = Command::new(&binary);
    cmd.args(&plan.argv);
    clear_owned_env(&mut cmd);
    for (key, value) in &plan.env {
        cmd.env(key, value);
    }
    cmd.current_dir(&project);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    if plan.stdin_prompt.is_some() {
        cmd.stdin(std::process::Stdio::piped());
    } else {
        cmd.stdin(std::process::Stdio::null());
    }
    unsafe {
        cmd.pre_exec(move || {
            extern "C" {
                fn setpgid(pid: i32, pgid: i32) -> i32;
                fn dup2(oldfd: i32, newfd: i32) -> i32;
                fn close(fd: i32) -> i32;
            }
            if setpgid(0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            if dup2(read_fd, APPROVE_FD) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            if read_fd != APPROVE_FD && close(read_fd) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

    if pending.is_stopped() {
        return fail_turn(&window, &tab_id, STOPPED_BEFORE_START);
    }
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) => {
            return fail_turn(&window, &tab_id, &format!("Failed to spawn manvi: {err}"));
        }
    };
    drop(read_pipe);

    if let Some(payload) = plan.stdin_prompt {
        let mut stdin = match child.stdin.take() {
            Some(stdin) => stdin,
            None => {
                let _ = child.kill().await;
                return fail_turn(&window, &tab_id, "Failed to acquire stdin for manvi.");
            }
        };
        if let Err(err) = stdin.write_all(payload.as_bytes()).await {
            let _ = child.kill().await;
            return fail_turn(
                &window,
                &tab_id,
                &format!("Failed to write the prompt: {err}"),
            );
        }
        if let Err(err) = stdin.shutdown().await {
            let _ = child.kill().await;
            return fail_turn(
                &window,
                &tab_id,
                &format!("Failed to close manvi stdin: {err}"),
            );
        }
    }

    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill().await;
            return fail_turn(&window, &tab_id, "Failed to capture manvi stdout.");
        }
    };
    let stderr = child.stderr.take();

    let process_key = format!("{}:{}", window.label(), tab_id);
    let processes = window.state::<crate::agent_process::AgentProcessState>();
    {
        let mut guard = processes.processes.lock().await;
        if guard.contains_key(&process_key) {
            drop(guard);
            let _ = child.kill().await;
            return fail_turn(
                &window,
                &tab_id,
                "A Manvi turn is already running in this tab.",
            );
        }
        guard.insert(process_key.clone(), child);
    }
    if pending.is_stopped() {
        // The Stop landed after the check above but before the child was in
        // the map, so it had nothing to signal. A Stop that did find the child
        // has already taken it out of the map.
        let child = processes.processes.lock().await.remove(&process_key);
        if let Some(mut child) = child {
            let _ = child.kill().await;
        }
        return fail_turn(&window, &tab_id, STOPPED_BEFORE_START);
    }
    // From here a Stop finds the child in the process map.
    drop(pending);
    {
        let mut guard = lock_map(pipes());
        guard.insert(
            tab_id.clone(),
            TabPipe {
                writer: write_pipe,
                pending: None,
            },
        );
    }

    let saw_error = std::sync::Arc::new(AtomicBool::new(false));
    let saw_error_reader = saw_error.clone();
    let phase = std::sync::Arc::new(Mutex::new("chat".to_string()));
    let phase_reader = phase.clone();
    let win_out = window.clone();
    let tab_out = tab_id.clone();
    let project_out = project_string.clone();
    let state_for_session = state_dir.clone();
    let stdout_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let mut translator = Translator {
            seq: 0,
            open: VecDeque::new(),
            side_approvals: Vec::new(),
            saw_error: false,
        };
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(ev) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if let Some(next) = activity_phase(&ev) {
                *lock_map(&*phase) = next.to_string();
            }
            if ev.get("kind").and_then(|k| k.as_str()) == Some("session.start") {
                if let Some(id) = ev.get("session_id").and_then(|v| v.as_str()) {
                    if !id.is_empty() {
                        remember_session(&tab_out, &project_out, id, &state_for_session);
                    }
                }
            }
            if ev.get("kind").and_then(|k| k.as_str()) == Some("approval.request") {
                register_pending(&tab_out, &ev);
            }
            for msg in translate(&mut translator, &ev) {
                emit_msg(&win_out, &tab_out, &msg);
            }
        }
        saw_error_reader.store(translator.saw_error, Ordering::Relaxed);
    });

    let stderr_tail = std::sync::Arc::new(Mutex::new(String::new()));
    let stderr_task = stderr.map(|stderr| {
        let slot = stderr_tail.clone();
        let tab_err = tab_id.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let shown = truncate_chars(&line, 200);
                eprintln!("[manvi-stderr] [{tab_err}] {shown}");
                remember_stderr_line(&slot, &line);
            }
        })
    });

    let win_wait = window.clone();
    let tab_wait = tab_id.clone();
    let key_wait = process_key.clone();
    let processes_wait = processes.processes.clone();
    let images_wait = staged_images.into_paths();
    let stderr_tail_wait = stderr_tail.clone();
    tokio::spawn(async move {
        #[cfg(target_os = "macos")]
        let _nap = crate::app_nap::NapActivity::begin("Manvi chat turn");

        use tokio::time::{interval, MissedTickBehavior};
        let mut heartbeat = interval(std::time::Duration::from_secs(super::TOOL_HEARTBEAT_SECS));
        heartbeat.set_missed_tick_behavior(MissedTickBehavior::Skip);
        heartbeat.tick().await;

        tokio::pin!(stdout_task);
        loop {
            tokio::select! {
                _ = &mut stdout_task => break,
                _ = heartbeat.tick() => {
                    let current = lock_map(&*phase_reader).clone();
                    super::emit_stream_heartbeat(&win_wait, &tab_wait, &current, None);
                }
            }
        }

        let child_opt = {
            let mut guard = processes_wait.lock().await;
            guard.remove(&key_wait)
        };
        let success = if let Some(mut child) = child_opt {
            let wait_fut = child.wait();
            tokio::pin!(wait_fut);
            let code = loop {
                tokio::select! {
                    waited = &mut wait_fut => {
                        break match waited {
                            Ok(status) => Some(status.code().unwrap_or(1)),
                            Err(_) => None,
                        };
                    }
                    _ = heartbeat.tick() => {
                        let current = lock_map(&*phase_reader).clone();
                        super::emit_stream_heartbeat(&win_wait, &tab_wait, &current, None);
                    }
                }
            };
            if let Some(task) = stderr_task {
                let _ = task.await;
            }
            match code {
                Some(code) => {
                    let errored = saw_error.load(Ordering::Relaxed);
                    let tail = lock_map(&stderr_tail_wait).clone();
                    if code != 0 && !errored {
                        if let Some(message) = exit_status_error(code, &tail) {
                            emit_msg(&win_wait, &tab_wait, &result_message(false, &message));
                        }
                    }
                    code == 0 && !errored
                }
                None => false,
            }
        } else {
            drop(stderr_task);
            false
        };
        drop_approval_writer(&tab_wait);
        for path in images_wait {
            let _ = std::fs::remove_file(path);
        }
        emit_complete(&win_wait, &tab_wait, success);
    });

    let _ = process_key;
    Ok(())
}

/// Files handed to `manvi run --image`. Dropped copies are removed so a failed
/// spawn does not keep the bytes in app data. [`StagedImages::into_paths`]
/// disarms that once the wait task owns the cleanup.
struct StagedImages(Vec<PathBuf>);

impl StagedImages {
    fn into_paths(mut self) -> Vec<PathBuf> {
        std::mem::take(&mut self.0)
    }
}

impl Drop for StagedImages {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// `app_data/manvi-state/<sha256 of the canonical project path>`.
fn project_state_dir(app_data: &Path, project: &Path) -> PathBuf {
    app_data
        .join("manvi-state")
        .join(project_state_key(project))
}

fn project_state_key(project: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(project.as_os_str().as_encoded_bytes());
    format!("{:x}", hasher.finalize())
}

fn sanitize_tab(tab_id: &str) -> String {
    tab_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .take(80)
        .collect()
}

pub async fn stop(window: WebviewWindow, tab_id: String) {
    request_stop(&format!("{}:{}", window.label(), tab_id));
    drop_approval_writer(&tab_id);
    // SIGINT first: Manvi saves the session in a deferred call that SIGKILL
    // would skip, losing the stopped turn and its edits from the next resume.
    let _ = crate::agent_process::stop_agent_process(
        window,
        tab_id,
        crate::agent_process::AgentStopMode::Interrupt,
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan_for(provider: ProviderKind, model: &str, prompt: &str) -> TurnPlan {
        build_plan(&PlanInput {
            prompt,
            resume_id: None,
            image_paths: &[],
            provider,
            catalogue_or_local_model: model,
            effort: Some("medium"),
            base_url: None,
            local_api_key: None,
            anthropic_key: Some("sk-ant-test-secret"),
            anthropic_base: None,
            project: Path::new("/paper"),
            state_dir: Path::new("/state"),
            mcp_config: Path::new("/state/mcp.json"),
            mcp_trust: "sha256:abc",
            temperature: Some(0.4),
            num_ctx: Some(8192),
            keep_alive: Some("1h"),
            chat_only: false,
        })
        .unwrap_or_else(|err| panic!("plan failed: {err}"))
    }

    fn sessions_test_guard() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    fn env_value<'a>(plan: &'a TurnPlan, key: &str) -> Option<&'a str> {
        plan.env
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    #[test]
    fn opus_alias_pins_advisor_and_leaves_lite_unset() {
        let plan = plan_for(ProviderKind::Anthropic, "opus", "hello");
        assert_eq!(env_value(&plan, "MANVI_MODEL"), Some(OPUS));
        assert_eq!(env_value(&plan, "MANVI_LLM_TIER_ADVISOR"), Some(OPUS));
        assert!(env_value(&plan, "MANVI_LLM_TIER_LITE").is_none());
        assert!(env_value(&plan, "MANVI_LLM_TIER_HEAVY").is_none());
        assert!(env_value(&plan, "MANVI_LLM_TIER_BASIC").is_none());
        assert!(env_value(&plan, "MANVI_LLM_TIER_MAIN").is_none());
        assert!(env_value(&plan, "MANVI_LLM_LOCAL_TEMPERATURE").is_none());
        assert!(env_value(&plan, "MANVI_LLM_LOCAL_KEEP_ALIVE").is_none());
        assert!(env_value(&plan, "ANTHROPIC_AUTH_TOKEN").is_none());
        assert!(!plan
            .argv
            .iter()
            .any(|a| a == "opus" || a == "sonnet" || a == "haiku"));
        assert!(!plan.argv.iter().any(|a| a.contains("sk-ant-test-secret")));
        assert!(!plan.argv.iter().any(|a| a == "--chat-only"));
    }

    #[test]
    fn sonnet_pins_heavy_and_advisor() {
        let plan = plan_for(ProviderKind::Anthropic, "sonnet", "hello");
        assert_eq!(env_value(&plan, "MANVI_MODEL"), Some(SONNET));
        assert_eq!(env_value(&plan, "MANVI_LLM_TIER_HEAVY"), Some(SONNET));
        assert_eq!(env_value(&plan, "MANVI_LLM_TIER_ADVISOR"), Some(SONNET));
        assert!(env_value(&plan, "MANVI_LLM_TIER_LITE").is_none());
        assert!(env_value(&plan, "MANVI_LLM_TIER_BASIC").is_none());
    }

    #[test]
    fn haiku_pins_advisor_heavy_and_lite() {
        let plan = plan_for(ProviderKind::Anthropic, "haiku", "hello");
        assert_eq!(env_value(&plan, "MANVI_MODEL"), Some(HAIKU));
        assert_eq!(env_value(&plan, "MANVI_LLM_TIER_ADVISOR"), Some(HAIKU));
        assert_eq!(env_value(&plan, "MANVI_LLM_TIER_HEAVY"), Some(HAIKU));
        assert_eq!(env_value(&plan, "MANVI_LLM_TIER_LITE"), Some(HAIKU));
        assert!(env_value(&plan, "MANVI_LLM_TIER_BASIC").is_none());
    }

    #[test]
    fn opusplan_catalogue_id_stays_an_error() {
        let err = catalogue_model("opusplan").expect_err("opusplan");
        assert!(err.contains("OpusPlan"));
    }

    #[test]
    fn opusplan_splits_session_opus_and_writer_sonnet() {
        let plan = plan_for(ProviderKind::Anthropic, "opusplan", "hello");
        assert_eq!(env_value(&plan, "MANVI_MODEL"), Some(OPUS));
        assert_eq!(env_value(&plan, "MANVI_LLM_TIER_HEAVY"), Some(SONNET));
        assert_eq!(env_value(&plan, "MANVI_LLM_TIER_ADVISOR"), Some(OPUS));
        assert!(env_value(&plan, "MANVI_LLM_TIER_LITE").is_none());
        assert!(env_value(&plan, "MANVI_LLM_TIER_BASIC").is_none());
        assert!(env_value(&plan, "MANVI_LLM_TIER_MAIN").is_none());
        assert!(!plan.argv.iter().any(|arg| arg.contains("opusplan")));
        assert!(!plan.env.iter().any(|(_, value)| value.contains("opusplan")));
    }

    #[test]
    fn chat_only_is_an_argv_flag_only_when_asked() {
        let off = plan_for(ProviderKind::Anthropic, "opus", "hello");
        assert!(!off.argv.iter().any(|arg| arg == "--chat-only"));
        let on = build_plan(&PlanInput {
            prompt: "hello",
            resume_id: None,
            image_paths: &[],
            provider: ProviderKind::Ollama,
            catalogue_or_local_model: "llama3.2",
            effort: None,
            base_url: Some("http://127.0.0.1:11434"),
            local_api_key: None,
            anthropic_key: None,
            anthropic_base: None,
            project: Path::new("/paper"),
            state_dir: Path::new("/state"),
            mcp_config: Path::new("/state/mcp.json"),
            mcp_trust: "sha256:abc",
            temperature: None,
            num_ctx: None,
            keep_alive: None,
            chat_only: true,
        })
        .unwrap_or_else(|err| panic!("{err}"));
        assert!(on.argv.iter().any(|arg| arg == "--chat-only"));
    }

    #[test]
    fn chat_only_notice_names_the_old_tool_models() {
        let notice = chat_only_notice("tiny");
        let text = notice["message"]["content"][0]["text"]
            .as_str()
            .unwrap_or("");
        assert_eq!(notice["type"], "assistant");
        assert!(text.contains("the model 'tiny'"));
        assert!(text.contains("llama3.2, qwen2.5, mistral-nemo"));
    }

    #[test]
    fn short_prompt_uses_p_and_long_prompt_uses_stdin() {
        let short = plan_for(ProviderKind::Anthropic, "opus", "hello");
        assert!(short
            .argv
            .windows(2)
            .any(|w| w[0] == "-p" && w[1] == "hello"));
        assert!(short.stdin_prompt.is_none());
        let long = "x".repeat(PROMPT_ARG_MAX);
        let big = plan_for(ProviderKind::Anthropic, "opus", &long);
        assert!(!big.argv.iter().any(|a| a == "-p"));
        assert_eq!(big.stdin_prompt.as_deref(), Some(long.as_str()));
        assert!(big.argv.windows(2).any(|w| w == ["--approve-fd", "3"]));
        assert!(big.argv.iter().any(|a| a == "--json"));
    }

    #[test]
    fn resume_refuses_a_claude_code_id() {
        let _guard = sessions_test_guard();
        let dir = tempfile::tempdir().expect("tempdir");
        remember_session("tab", "/paper", "sess-1", dir.path());
        let refused = decide_resume(
            "tab",
            "/paper",
            Some("11111111-2222-3333-4444-555555555555"),
            dir.path(),
        );
        assert!(refused.id.is_none());
        let wrong_project = decide_resume("tab", "/other", Some("manvi:sess-1"), dir.path());
        assert!(wrong_project.id.is_none());
        // Memory match does not require a session file, and a non-hex id is
        // still resumed while this process holds the tab.
        let ok = decide_resume("tab", "/paper", Some("manvi:sess-1"), dir.path());
        assert_eq!(ok.id.as_deref(), Some("sess-1"));
        forget_tab("tab");
    }

    #[test]
    fn resume_after_restart_needs_the_record_and_the_session_file() {
        let _guard = sessions_test_guard();
        lock_map(sessions()).clear();
        let dir = tempfile::tempdir().expect("tempdir");
        let state = dir.path();
        std::fs::create_dir_all(state.join("sessions")).expect("sessions");
        std::fs::write(state.join("sessions").join("ab.1.json"), b"{}").expect("session");
        remember_session("tab-a", "/paper", "ab", state);
        assert!(host_resume_path(state).is_file());
        lock_map(sessions()).clear();

        let resumed = decide_resume("tab-b", "/paper", Some("manvi:ab"), state);
        assert_eq!(resumed.id.as_deref(), Some("ab"));
        let claude = decide_resume(
            "tab-b",
            "/paper",
            Some("11111111-2222-3333-4444-555555555555"),
            state,
        );
        assert!(claude.id.is_none());

        std::fs::write(state.join("sessions").join("cd.0.json"), b"{}").expect("gen0");
        remember_session("tab-a", "/paper", "cd", state);
        lock_map(sessions()).clear();
        let generation_zero = decide_resume("tab-z", "/paper", Some("manvi:cd"), state);
        assert!(generation_zero.id.is_none());
        assert!(!session_on_disk(state, ".."));
        assert!(!session_on_disk(state, "AB"));

        std::fs::write(state.join("sessions").join("ab.1.json"), b"{}").expect("session");
        remember_session("tab-a", "/paper", "ab", state);
        forget_tab("tab-a");
        lock_map(sessions()).clear();
        let after_forget = decide_resume("tab-b", "/paper", Some("manvi:ab"), state);
        assert!(after_forget.id.is_none());
        assert!(state.join("sessions").join("ab.1.json").is_file());
    }

    #[test]
    fn personalization_is_merged_once_into_the_host_prefix() {
        let built = "## USER PERSONALIZATION (on-device; adapt silently — do not mention this section)\nname";
        assert_eq!(merge_personalization("", None), "");
        assert_eq!(merge_personalization("", Some("  ")), "");
        assert_eq!(merge_personalization(built, None), built);
        assert_eq!(merge_personalization("", Some("extra")), "extra");
        assert_eq!(
            merge_personalization(built, Some("extra")),
            format!("{built}\n\nextra")
        );
        assert_eq!(merge_personalization(built, Some(built)), built);
        let composed = compose_prompt("hello", None, None, None, None, None, Some(built));
        assert!(composed.starts_with(built));
        assert!(composed.ends_with("hello"));
        assert_eq!(composed.matches(built).count(), 1);
    }

    #[test]
    fn ollama_base_gains_v1_once() {
        assert_eq!(
            ollama_v1("http://127.0.0.1:11434"),
            "http://127.0.0.1:11434/v1"
        );
        assert_eq!(
            ollama_v1("http://127.0.0.1:11434/v1"),
            "http://127.0.0.1:11434/v1"
        );
        let plan = build_plan(&PlanInput {
            prompt: "hi",
            resume_id: None,
            image_paths: &[],
            provider: ProviderKind::Ollama,
            catalogue_or_local_model: "llama3",
            effort: None,
            base_url: Some("http://localhost:11434"),
            local_api_key: None,
            anthropic_key: None,
            anthropic_base: None,
            project: Path::new("/paper"),
            state_dir: Path::new("/state"),
            mcp_config: Path::new("/state/mcp.json"),
            mcp_trust: "sha256:abc",
            temperature: Some(0.4),
            num_ctx: None,
            keep_alive: None,
            chat_only: false,
        })
        .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(
            env_value(&plan, "MANVI_LLM_LOCAL_BASE_URL"),
            Some("http://localhost:11434/v1")
        );
        assert_eq!(env_value(&plan, "MANVI_LLM_LOCAL_KEEP_ALIVE"), Some("10m"));
        assert!(env_value(&plan, "LOCAL_API_KEY").is_none());
        assert!(env_value(&plan, "OPENAI_API_KEY").is_none());
        assert_eq!(env_value(&plan, "MANVI_PROJECT_ROOT"), Some("/paper"));
        assert_eq!(
            env_value(&plan, "MANVI_HARNESS_INIT_ENABLED"),
            Some("false")
        );
        assert!(!plan.argv.iter().any(|arg| arg == "--chat-only"));

        let held = build_plan(&PlanInput {
            prompt: "hi",
            resume_id: None,
            image_paths: &[],
            provider: ProviderKind::Ollama,
            catalogue_or_local_model: "llama3",
            effort: None,
            base_url: Some("http://localhost:11434"),
            local_api_key: None,
            anthropic_key: None,
            anthropic_base: None,
            project: Path::new("/paper"),
            state_dir: Path::new("/state"),
            mcp_config: Path::new("/state/mcp.json"),
            mcp_trust: "sha256:abc",
            temperature: None,
            num_ctx: None,
            keep_alive: Some("1h"),
            chat_only: false,
        })
        .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(env_value(&held, "MANVI_LLM_LOCAL_KEEP_ALIVE"), Some("1h"));
    }

    #[test]
    fn cloud_compat_sets_local_api_key_not_openai() {
        let plan = build_plan(&PlanInput {
            prompt: "hi",
            resume_id: None,
            image_paths: &[],
            provider: ProviderKind::Compat,
            catalogue_or_local_model: "llama-3.3-70b-versatile",
            effort: None,
            base_url: Some("https://api.groq.com/openai/v1"),
            local_api_key: Some("gsk-test"),
            anthropic_key: None,
            anthropic_base: None,
            project: Path::new("/paper"),
            state_dir: Path::new("/state"),
            mcp_config: Path::new("/state/mcp.json"),
            mcp_trust: "sha256:abc",
            temperature: None,
            num_ctx: None,
            keep_alive: Some("1h"),
            chat_only: false,
        })
        .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(env_value(&plan, "LOCAL_API_KEY"), Some("gsk-test"));
        assert!(env_value(&plan, "OPENAI_API_KEY").is_none());
        assert!(env_value(&plan, "MANVI_LLM_LOCAL_KEEP_ALIVE").is_none());
    }

    #[test]
    fn cloud_compat_without_a_key_fails_closed() {
        let err = match build_plan(&PlanInput {
            prompt: "hi",
            resume_id: None,
            image_paths: &[],
            provider: ProviderKind::Compat,
            catalogue_or_local_model: "llama-3.3-70b-versatile",
            effort: None,
            base_url: Some("https://api.groq.com/openai/v1"),
            local_api_key: None,
            anthropic_key: None,
            anthropic_base: None,
            project: Path::new("/paper"),
            state_dir: Path::new("/state"),
            mcp_config: Path::new("/state/mcp.json"),
            mcp_trust: "sha256:abc",
            temperature: None,
            num_ctx: None,
            keep_alive: None,
            chat_only: false,
        }) {
            Err(err) => err,
            Ok(_) => panic!("empty cloud key was accepted"),
        };
        assert!(err.contains("[E_AUTH]"));
    }

    #[test]
    fn a_stop_before_spawn_marks_the_pending_turn() {
        let turn = PendingTurn::begin("w:pending-stop");
        assert!(!turn.is_stopped());
        request_stop("w:pending-stop");
        assert!(turn.is_stopped(), "the Stop was lost before Manvi spawned");
    }

    #[test]
    fn a_stop_with_nothing_pending_does_not_block_the_next_turn() {
        request_stop("w:idle-stop");
        let turn = PendingTurn::begin("w:idle-stop");
        assert!(!turn.is_stopped());
    }

    #[test]
    fn an_old_turn_finishing_leaves_the_newer_turns_flag() {
        let old = PendingTurn::begin("w:replaced");
        let new = PendingTurn::begin("w:replaced");
        drop(old);
        request_stop("w:replaced");
        assert!(
            new.is_stopped(),
            "dropping the old turn removed the new flag"
        );
        drop(new);
        assert!(!lock_map(pending_turns()).contains_key("w:replaced"));
    }

    /// Ollama has no authentication; a LAN or container host must not need a key.
    #[test]
    fn lan_ollama_without_a_key_is_accepted() {
        for base in [
            "http://192.168.1.10:11434",
            "http://0.0.0.0:11434",
            "http://host.docker.internal:11434",
        ] {
            let plan = build_plan(&PlanInput {
                prompt: "hi",
                resume_id: None,
                image_paths: &[],
                provider: ProviderKind::Ollama,
                catalogue_or_local_model: "llama3.1",
                effort: None,
                base_url: Some(base),
                local_api_key: None,
                anthropic_key: None,
                anthropic_base: None,
                project: Path::new("/paper"),
                state_dir: Path::new("/state"),
                mcp_config: Path::new("/state/mcp.json"),
                mcp_trust: "sha256:abc",
                temperature: None,
                num_ctx: None,
                keep_alive: None,
                chat_only: false,
            })
            .unwrap_or_else(|err| panic!("{base}: {err}"));
            assert_eq!(env_value(&plan, "LOCAL_API_KEY"), None, "{base}");
        }
    }

    #[test]
    fn vertex_empty_key_is_a_mint_and_groq_is_not() {
        let mint = |base: &str, key: &str| {
            crate::google_auth::is_vertex_openai_compat_base_url(base)
                && crate::google_auth::should_mint_google_access_token(key)
        };
        let vertex =
            "https://aiplatform.googleapis.com/v1/projects/p/locations/global/endpoints/openapi";
        let groq = "https://api.groq.com/openai/v1";
        assert!(mint(vertex, ""));
        assert!(mint(vertex, "AIza-example"));
        assert!(!mint(groq, ""));
        assert!(!mint(groq, "gsk-test"));
        assert!(!mint(vertex, "gsk-test"));
    }

    #[test]
    fn fingerprint_matches_the_independent_vector() {
        let got = mcp_fingerprint(
            "devprism",
            "/bin/devprism",
            &["--mcp"],
            &[("DEVPRISM_PROJECT", "/tmp/paper")],
        );
        assert_eq!(
            got,
            "sha256:5809e7efa608fe0124b86b5f8cda44fa8aa5238503c8280bae6efd90820b56af"
        );
    }

    #[test]
    fn harness_message_is_not_a_user_bubble() {
        let mut st = Translator {
            seq: 0,
            open: VecDeque::new(),
            side_approvals: Vec::new(),
            saw_error: false,
        };
        let msgs = translate(
            &mut st,
            &json!({"kind": "harness.message", "text": "verifier said no"}),
        );
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["type"], "system");
        assert_eq!(msgs[0]["subtype"], "harness_notice");
        assert!(msgs[0].get("message").is_none());
    }

    #[test]
    fn approval_request_with_choices_is_askuser() {
        let mut st = Translator {
            seq: 0,
            open: VecDeque::new(),
            side_approvals: Vec::new(),
            saw_error: false,
        };
        let msgs = translate(
            &mut st,
            &json!({
                "kind": "approval.request",
                "approval_id": "ap-1",
                "text": "Which layout?",
                "choices": ["one column", "two column"],
                "multi_select": false
            }),
        );
        let block = &msgs[0]["message"]["content"][0];
        assert_eq!(block["name"], "AskUser");
        assert_ne!(block["name"], "AskUserQuestion");
        assert_eq!(block["id"], "ap-1");
        assert_eq!(block["input"]["options"][0], "one column");
        let secret = "sk-ant-test-secret";
        assert!(!msgs[0].to_string().contains(secret));
    }

    #[test]
    fn tool_result_pairs_with_the_minted_id() {
        let mut st = Translator {
            seq: 0,
            open: VecDeque::new(),
            side_approvals: Vec::new(),
            saw_error: false,
        };
        let start = translate(
            &mut st,
            &json!({"kind": "tool.start", "tool": "bash", "arguments": {"command": "ls"}}),
        );
        let id = start[0]["message"]["content"][0]["id"]
            .as_str()
            .unwrap_or("");
        assert_eq!(id, "tool-1");
        let done = translate(
            &mut st,
            &json!({"kind": "tool.result", "text": "ok", "is_error": false}),
        );
        assert_eq!(done[0]["message"]["content"][0]["tool_use_id"], id);
    }

    #[test]
    fn wire_only_events_emit_nothing() {
        let mut st = Translator {
            seq: 0,
            open: VecDeque::new(),
            side_approvals: Vec::new(),
            saw_error: false,
        };
        for kind in [
            "step.usage",
            "verify.report",
            "diagnostic",
            "approval.decided",
        ] {
            let msgs = translate(&mut st, &json!({"kind": kind, "text": "hidden"}));
            assert!(msgs.is_empty(), "{kind}");
        }
    }

    #[test]
    fn exit_codes_name_the_failure() {
        assert!(exit_status_error(0, "").is_none());
        assert!(exit_status_error(2, "")
            .unwrap_or_default()
            .contains("step ceiling"));
        assert!(exit_status_error(3, "")
            .unwrap_or_default()
            .contains("output cap"));
        assert!(exit_status_error(4, "")
            .unwrap_or_default()
            .contains("without an answer"));
        assert!(exit_status_error(5, "")
            .unwrap_or_default()
            .contains("unfinished"));
        let named = exit_status_error(1, "config.yaml sets llm.tier.main").unwrap_or_default();
        assert!(named.contains("status 1"));
        assert!(named.contains("llm.tier.main"));
    }

    #[test]
    fn stderr_tail_drops_a_line_that_contains_a_key() {
        let slot = Mutex::new(String::new());
        remember_stderr_line(&slot, "manvi: session abc");
        remember_stderr_line(&slot, "refused: sk-ant-secret");
        assert_eq!(lock_map(&slot).as_str(), "manvi: session abc");
        remember_stderr_line(&slot, "catalogue has no price for claude-opus-9");
        assert!(lock_map(&slot).contains("claude-opus-9"));
    }

    #[test]
    fn stored_anthropic_key_wins_over_the_environment() {
        let (key, base) = resolve_anthropic_credential(
            Some(("stored-key".into(), Some("https://proxy.example".into()))),
            Some("env-key"),
            Some("https://env.example"),
        )
        .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(key, "stored-key");
        assert_eq!(base.as_deref(), Some("https://proxy.example"));
        let (key, base) = resolve_anthropic_credential(None, Some("env-key"), Some("  "))
            .unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(key, "env-key");
        assert!(base.is_none());
        let missing = resolve_anthropic_credential(None, Some("  "), None);
        assert!(missing.is_err());
    }

    #[test]
    fn choice_answer_and_grant_and_multiselect_refusal() {
        let choice = PendingApproval {
            id: "ap".into(),
            choices: vec!["A".into(), "B".into()],
            multi_select: false,
        };
        let line = decision_line(&choice, "B").unwrap_or_else(|e| panic!("{e}"));
        let v: Value = serde_json::from_str(line.trim()).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(v["allow"], true);
        assert_eq!(v["chosen"][0], "B");
        let grant = PendingApproval {
            id: "g".into(),
            choices: vec![],
            multi_select: false,
        };
        let gline = decision_line(&grant, "yes do it").unwrap_or_else(|e| panic!("{e}"));
        let gv: Value = serde_json::from_str(gline.trim()).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(gv["reason"], "yes do it");
        assert_eq!(gv["allow"], true);
        let multi = PendingApproval {
            id: "m".into(),
            choices: vec!["A".into(), "B".into()],
            multi_select: true,
        };
        let refused = decision_line(&multi, "A").unwrap_or_else(|e| panic!("{e}"));
        let rv: Value = serde_json::from_str(refused.trim()).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(rv["allow"], false);
        let accepted = decision_line(&multi, "[\"A\",\"B\"]").unwrap_or_else(|e| panic!("{e}"));
        let av: Value = serde_json::from_str(accepted.trim()).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(av["allow"], true);
        assert_eq!(av["chosen"].as_array().map(|a| a.len()), Some(2));
    }

    #[test]
    fn init_off_does_not_touch_the_project() {
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let project = tmp.path().join("paper");
        let state = tmp.path().join("state");
        std::fs::create_dir_all(project.join("src")).unwrap_or_else(|e| panic!("{e}"));
        std::fs::create_dir_all(state.join("sessions")).unwrap_or_else(|e| panic!("{e}"));
        assert!(!project_pins_llm_tier(&project).unwrap_or_else(|e| panic!("{e}")));
        assert!(!project.join(".devcouncil").exists());
        assert!(!project.join(".gitignore").exists());
        std::fs::write(project.join(".devcouncil").join("nope"), "x").ok();
        std::fs::create_dir_all(project.join(".devcouncil")).unwrap_or_else(|e| panic!("{e}"));
        std::fs::write(
            project.join(".devcouncil").join("config.yaml"),
            "llm:\n  tier:\n    main: claude-opus-5-5\n",
        )
        .unwrap_or_else(|e| panic!("{e}"));
        assert!(project_pins_llm_tier(&project).unwrap_or_else(|e| panic!("{e}")));
        std::fs::write(
            project.join(".devcouncil").join("config.yaml"),
            "llm.provider.default: anthropic\n",
        )
        .unwrap_or_else(|e| panic!("{e}"));
        assert!(!project_pins_llm_tier(&project).unwrap_or_else(|e| panic!("{e}")));
        std::fs::write(
            project.join(".devcouncil").join("config.yaml"),
            "llm.tier.main: claude-opus-5-5\n",
        )
        .unwrap_or_else(|e| panic!("{e}"));
        assert!(project_pins_llm_tier(&project).unwrap_or_else(|e| panic!("{e}")));
    }

    #[test]
    fn state_dir_is_one_directory_per_project() {
        let app = Path::new("/tmp/devprism-app");
        let a = project_state_dir(app, Path::new("/papers/a"));
        let b = project_state_dir(app, Path::new("/papers/b"));
        assert_ne!(a, b);
        assert_eq!(a, project_state_dir(app, Path::new("/papers/a")));
        assert_eq!(a.parent(), Some(app.join("manvi-state").as_path()));
        assert_eq!(
            a.file_name().and_then(|name| name.to_str()),
            Some("b48b3af8206a62d290237f44c1f2b297acddb6df6baa29861a4c142cff1e6aab")
        );
        assert_eq!(
            b.file_name().and_then(|name| name.to_str()),
            Some("57c10855aa362560f0f7d7313635768eef08673a0f5090bc59cd019e610ced03")
        );
        // Sessions are the child Manvi already uses (`STATE_DIR/sessions`),
        // not a directory shared by every open paper.
        assert_eq!(a.join("sessions").parent(), Some(a.as_path()));
    }

    #[test]
    fn staged_images_are_removed_unless_the_wait_task_takes_them() {
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let path = tmp.path().join("0.img");
        std::fs::write(&path, b"png").unwrap_or_else(|e| panic!("{e}"));
        {
            let staged = StagedImages(vec![path.clone()]);
            drop(staged);
        }
        assert!(!path.exists(), "a dropped stage must delete the image");
        std::fs::write(&path, b"png").unwrap_or_else(|e| panic!("{e}"));
        let staged = StagedImages(vec![path.clone()]);
        let owned = staged.into_paths();
        assert!(
            path.exists(),
            "taking ownership must leave the file for the child"
        );
        assert_eq!(owned.len(), 1);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn fifth_image_is_rejected_before_a_plan() {
        let images = vec!["YQ==".to_string(); 5];
        let err = decode_images(&images).expect_err("fifth");
        assert!(err.contains("4"));
    }
}
