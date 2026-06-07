use serde_json::json;
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use tauri::{Emitter, Manager, WebviewWindow};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

#[derive(Default, serde::Deserialize, serde::Serialize)]
#[serde(default)]
struct ClaudePrismAuthConfig {
    provider: Option<String>,
    anthropic_api_key: Option<String>,
    anthropic_base_url: Option<String>,
    openai_api_key: Option<String>,
    openai_base_url: Option<String>,
    openai_model: Option<String>,
}

struct StoredClaudeCredential {
    api_key: String,
    base_url: Option<String>,
}

#[derive(Clone)]
struct StoredOpenAiCompatibleCredential {
    api_key: String,
    base_url: String,
    model: String,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
struct DirectTask {
    id: String,
    subject: String,
    description: String,
    active_form: Option<String>,
    status: String,
    owner: Option<String>,
}

const PROVIDER_CLAUDE_CODE: &str = "claude-code";
const PROVIDER_OPENAI_COMPATIBLE: &str = "openai-compatible";

/// Check if an environment variable should be explicitly passed to child processes.
///
/// NOTE: This is NOT a true whitelist — we do NOT call `env_clear()`, so the
/// child inherits the full parent environment.  This helper only identifies vars
/// that we *explicitly* re-set via `cmd.env()` to guarantee they are present
/// even when other per-key overrides are applied (e.g. prepending to PATH).
/// Uses case-insensitive comparison for Windows compatibility.
pub(crate) fn is_essential_env_var(key: &str) -> bool {
    let k = key.to_ascii_uppercase();
    // Cross-platform
    matches!(
        k.as_str(),
        "HOME" | "USER" | "SHELL" | "LANG"
        | "HOMEBREW_PREFIX" | "HOMEBREW_CELLAR"
        | "HTTP_PROXY" | "HTTPS_PROXY" | "NO_PROXY" | "ALL_PROXY"
        | "ANTHROPIC_API_KEY" | "ANTHROPIC_AUTH_TOKEN"
        | "ANTHROPIC_BASE_URL"
    ) || k.starts_with("LC_")
    // Windows-specific
    || matches!(
        k.as_str(),
        "USERPROFILE" | "APPDATA" | "LOCALAPPDATA"
        | "TEMP" | "TMP"
        | "SYSTEMROOT" | "SYSTEMDRIVE"
        | "COMPUTERNAME" | "USERNAME"
        | "PROGRAMFILES" | "PROGRAMFILES(X86)" | "COMMONPROGRAMFILES"
        | "PATHEXT" | "PSMODULEPATH" | "WINDIR"
    )
}

fn get_claude_prism_auth_path() -> Result<PathBuf, String> {
    let config_dir = dirs::config_dir()
        .or_else(dirs::home_dir)
        .ok_or("Could not find config directory")?;
    Ok(config_dir
        .join("ClaudePrism")
        .join("anthropic-auth.json"))
}

fn read_claude_prism_auth_config() -> Result<ClaudePrismAuthConfig, String> {
    let path = get_claude_prism_auth_path()?;
    if !path.exists() {
        return Ok(ClaudePrismAuthConfig::default());
    }

    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("Failed to read auth settings: {}", e))?;
    let content = content.trim_start_matches('\u{feff}');
    serde_json::from_str(content).map_err(|e| format!("Failed to parse auth settings: {}", e))
}

fn write_claude_prism_auth_config(config: &ClaudePrismAuthConfig) -> Result<(), String> {
    let path = get_claude_prism_auth_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create auth settings dir: {}", e))?;
    }

    let content = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize auth settings: {}", e))?;
    std::fs::write(&path, content).map_err(|e| format!("Failed to write auth settings: {}", e))
}

fn normalize_api_key(value: &str) -> Result<String, String> {
    let clean = strip_nul(value).trim().to_string();
    if clean.is_empty() {
        return Err("API key is empty".to_string());
    }

    if clean.chars().any(char::is_whitespace) {
        return Err("API key cannot contain spaces or line breaks".to_string());
    }

    Ok(clean)
}

fn normalize_base_url(value: Option<&str>) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };

    let clean = strip_nul(value).trim().trim_end_matches('/').to_string();
    if clean.is_empty() {
        return Ok(None);
    }

    if clean.chars().any(char::is_whitespace) {
        return Err("Base URL cannot contain spaces or line breaks".to_string());
    }

    if !(clean.starts_with("https://") || clean.starts_with("http://")) {
        return Err("Base URL must start with http:// or https://".to_string());
    }

    Ok(Some(clean))
}

fn normalize_provider(value: Option<&str>) -> Result<String, String> {
    let provider = value.unwrap_or(PROVIDER_CLAUDE_CODE).trim();
    match provider {
        "" | PROVIDER_CLAUDE_CODE => Ok(PROVIDER_CLAUDE_CODE.to_string()),
        PROVIDER_OPENAI_COMPATIBLE => Ok(PROVIDER_OPENAI_COMPATIBLE.to_string()),
        other => Err(format!("Unsupported provider: {}", other)),
    }
}

fn normalize_model(value: Option<&str>) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };

    let clean = strip_nul(value).trim().to_string();
    if clean.is_empty() {
        return Ok(None);
    }

    if clean.chars().any(char::is_whitespace) {
        return Err("Model cannot contain spaces or line breaks".to_string());
    }

    Ok(Some(clean))
}

fn stored_claude_credential() -> Option<StoredClaudeCredential> {
    let config = read_claude_prism_auth_config().ok()?;
    let provider = normalize_provider(config.provider.as_deref()).ok()?;
    if provider != PROVIDER_CLAUDE_CODE {
        return None;
    }

    let api_key = config
        .anthropic_api_key
        .and_then(|value| normalize_api_key(&value).ok())?;
    let base_url = normalize_base_url(config.anthropic_base_url.as_deref()).ok()?;

    if base_url.is_none() && !api_key.starts_with("sk-ant-") {
        return None;
    }

    Some(StoredClaudeCredential { api_key, base_url })
}

fn stored_openai_compatible_credential() -> Option<StoredOpenAiCompatibleCredential> {
    let config = read_claude_prism_auth_config().ok()?;
    let provider = normalize_provider(config.provider.as_deref()).ok()?;
    if provider != PROVIDER_OPENAI_COMPATIBLE {
        return None;
    }

    let api_key = config
        .openai_api_key
        .and_then(|value| normalize_api_key(&value).ok())?;
    let base_url = normalize_base_url(config.openai_base_url.as_deref())
        .ok()
        .flatten()?;
    let model = normalize_model(config.openai_model.as_deref())
        .ok()
        .flatten()?;

    Some(StoredOpenAiCompatibleCredential {
        api_key,
        base_url,
        model,
    })
}

fn claude_credential_label() -> Option<&'static str> {
    if std::env::var("ANTHROPIC_API_KEY")
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
    {
        if std::env::var("ANTHROPIC_BASE_URL")
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
        {
            return Some("External API key");
        }
        return Some("Anthropic API key");
    }

    if std::env::var("ANTHROPIC_AUTH_TOKEN")
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
    {
        return Some("Anthropic auth token");
    }

    if let Some(credential) = stored_claude_credential() {
        return Some(if credential.base_url.is_some() {
            "External API key"
        } else {
            "Anthropic API key"
        });
    }

    None
}

#[tauri::command]
pub async fn save_anthropic_api_key(
    api_key: String,
    base_url: Option<String>,
    provider: Option<String>,
    model: Option<String>,
) -> Result<(), String> {
    let api_key = normalize_api_key(&api_key)?;
    let base_url = normalize_base_url(base_url.as_deref())?;
    let provider = normalize_provider(provider.as_deref())?;
    let model = normalize_model(model.as_deref())?;

    // Saving a new key should repair an empty/corrupt legacy auth file.
    let mut config = read_claude_prism_auth_config().unwrap_or_default();
    config.provider = Some(provider.clone());

    if provider == PROVIDER_OPENAI_COMPATIBLE {
        let base_url = base_url.ok_or("OpenAI-compatible provider requires a Base URL")?;
        let model = model.ok_or("OpenAI-compatible provider requires a model")?;
        config.openai_api_key = Some(api_key);
        config.openai_base_url = Some(base_url);
        config.openai_model = Some(model);
        return write_claude_prism_auth_config(&config);
    }

    if base_url.is_none() && !api_key.starts_with("sk-ant-") {
        return Err(
            "This looks like an external provider key. Set the provider Base URL, or use an Anthropic key that starts with sk-ant-."
                .to_string(),
        );
    }

    config.anthropic_api_key = Some(api_key);
    config.anthropic_base_url = base_url;
    write_claude_prism_auth_config(&config)
}

#[tauri::command]
pub async fn clear_anthropic_api_key() -> Result<(), String> {
    // Clearing should also recover from an empty/corrupt legacy auth file.
    let mut config = read_claude_prism_auth_config().unwrap_or_default();
    config.provider = Some(PROVIDER_CLAUDE_CODE.to_string());
    config.anthropic_api_key = None;
    config.anthropic_base_url = None;
    config.openai_api_key = None;
    config.openai_base_url = None;
    config.openai_model = None;
    write_claude_prism_auth_config(&config)
}

/// Windows CREATE_NO_WINDOW flag to prevent console windows from flashing
/// when spawning child processes (e.g. Claude CLI, cmd.exe, node.exe).
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[derive(Clone)]
pub struct ClaudeProcessState {
    pub processes: Arc<Mutex<HashMap<String, Child>>>,
    direct_sessions: Arc<Mutex<HashMap<String, Vec<serde_json::Value>>>>,
    direct_cancellations: Arc<Mutex<HashSet<String>>>,
    direct_task_lists: Arc<Mutex<HashMap<String, Vec<DirectTask>>>>,
}

impl Default for ClaudeProcessState {
    fn default() -> Self {
        Self {
            processes: Arc::new(Mutex::new(HashMap::new())),
            direct_sessions: Arc::new(Mutex::new(HashMap::new())),
            direct_cancellations: Arc::new(Mutex::new(HashSet::new())),
            direct_task_lists: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

/// On Windows, read User + System PATH from the registry and search for claude.
/// This catches cases where claude was installed after the GUI app launched,
/// since the process PATH is stale but the registry PATH is up to date.
/// Registry values may contain unexpanded variables like `%USERPROFILE%`,
/// so we expand them via `ExpandEnvironmentStringsW` before searching.
#[cfg(target_os = "windows")]
fn find_claude_in_registry_path() -> Option<String> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    let mut dirs: Vec<String> = Vec::new();

    // User PATH
    if let Ok(env) = RegKey::predef(HKEY_CURRENT_USER).open_subkey("Environment") {
        if let Ok(user_path) = env.get_value::<String, _>("Path") {
            dirs.extend(
                user_path
                    .split(';')
                    .filter(|s| !s.is_empty())
                    .map(|s| expand_env_vars(s)),
            );
        }
    }

    // System PATH
    if let Ok(env) = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey(r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment")
    {
        if let Ok(sys_path) = env.get_value::<String, _>("Path") {
            dirs.extend(
                sys_path
                    .split(';')
                    .filter(|s| !s.is_empty())
                    .map(|s| expand_env_vars(s)),
            );
        }
    }

    let candidates = ["claude.exe", "claude.cmd"];
    for dir in &dirs {
        for name in &candidates {
            let p = PathBuf::from(dir).join(name);
            if p.is_file() {
                return Some(p.to_string_lossy().to_string());
            }
        }
    }

    None
}

/// Expand Windows environment variables like `%USERPROFILE%` in a string.
#[cfg(target_os = "windows")]
fn expand_env_vars(s: &str) -> String {
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    let wide: Vec<u16> = OsString::from(s).encode_wide().chain(std::iter::once(0)).collect();

    // First call to get required buffer size
    let size = unsafe {
        windows_sys::Win32::System::Environment::ExpandEnvironmentStringsW(
            wide.as_ptr(),
            std::ptr::null_mut(),
            0,
        )
    };
    if size == 0 {
        return s.to_string();
    }

    let mut buf: Vec<u16> = vec![0u16; size as usize];
    let result = unsafe {
        windows_sys::Win32::System::Environment::ExpandEnvironmentStringsW(
            wide.as_ptr(),
            buf.as_mut_ptr(),
            size,
        )
    };
    if result == 0 {
        return s.to_string();
    }

    // Trim trailing null
    if let Some(pos) = buf.iter().position(|&c| c == 0) {
        buf.truncate(pos);
    }
    OsString::from_wide(&buf).to_string_lossy().to_string()
}

/// Discover the claude binary on the system.
/// Search order: ~/.local/bin → NVM_BIN → which → registry PATH (Windows) →
/// login shell (Unix) → npm/nvm global → standard paths → user-specific paths.
/// Returns Err if not found.
fn find_claude_binary() -> Result<String, String> {
    // 1. Check the native installer's default location first
    //    (GUI apps often don't have ~/.local/bin in PATH)
    if let Some(home) = dirs::home_dir() {
        #[cfg(target_os = "windows")]
        let native_path = home.join(".local").join("bin").join("claude.exe");
        #[cfg(not(target_os = "windows"))]
        let native_path = home.join(".local").join("bin").join("claude");
        if native_path.exists() {
            return Ok(native_path.to_string_lossy().to_string());
        }
    }

    // 2. Check NVM_BIN environment variable (active NVM version).
    //    This is checked before `which` because GUI apps lack shell-sourced PATH,
    //    but NVM_BIN may still be set when launched from a terminal-aware context.
    #[cfg(not(target_os = "windows"))]
    if let Ok(nvm_bin) = std::env::var("NVM_BIN") {
        let claude_in_nvm = PathBuf::from(&nvm_bin).join("claude");
        if claude_in_nvm.exists() {
            return Ok(claude_in_nvm.to_string_lossy().to_string());
        }
    }

    // 2b. Check PNPM_HOME before PATH probing.
    //     GUI apps on macOS often miss shell-initialized PATH entries, but
    //     package-manager homes may still be available as environment vars.
    #[cfg(not(target_os = "windows"))]
    if let Some(path) = dirs::home_dir().and_then(|home| {
        unix_claude_candidate_paths(&home, std::env::var_os("PNPM_HOME"))
            .into_iter()
            .find(|path| path.exists())
    }) {
        return Ok(path.to_string_lossy().to_string());
    }

    // 3. Try to find claude on PATH
    if let Ok(path) = which::which("claude") {
        return Ok(path.to_string_lossy().to_string());
    }

    // 4. On macOS/Linux, ask a login shell for the real PATH and package-manager
    //    homes. GUI apps inherit a minimal PATH that misses ~/.nvm, homebrew,
    //    pnpm/npm custom prefixes, etc.
    #[cfg(not(target_os = "windows"))]
    {
        if let Some(path_str) = run_login_shell_command("command -v claude") {
            if PathBuf::from(&path_str).exists() {
                return Ok(path_str);
            }
        }

        if let Some(home) = dirs::home_dir() {
            for path in unix_shell_manager_candidate_paths(&home) {
                if path.exists() {
                    return Ok(path.to_string_lossy().to_string());
                }
            }
        }
    }

    // 5. On Windows, read the real PATH from the registry.
    //    GUI apps inherit the PATH from login time; if the user installed Claude
    //    after that, the registry PATH has it but the process PATH does not.
    #[cfg(target_os = "windows")]
    {
        if let Some(path) = find_claude_in_registry_path() {
            return Ok(path);
        }
    }

    // 6. Check NVM directories (Unix) or npm/nvm global (Windows)
    #[allow(unused_variables)]
    if let Some(home) = dirs::home_dir() {
        #[cfg(not(target_os = "windows"))]
        {
            let nvm_dir = home.join(".nvm").join("versions").join("node");
            if nvm_dir.exists() {
                if let Ok(entries) = std::fs::read_dir(&nvm_dir) {
                    let mut candidates: Vec<PathBuf> = entries
                        .filter_map(|e| e.ok())
                        .map(|e| e.path().join("bin").join("claude"))
                        .filter(|p| p.exists())
                        .collect();
                    // Sort by version (directory name) descending to prefer latest
                    candidates.sort();
                    candidates.reverse();
                    if let Some(path) = candidates.first() {
                        return Ok(path.to_string_lossy().to_string());
                    }
                }
            }
        }

        #[cfg(target_os = "windows")]
        {
            // Check common Windows Node.js locations
            if let Ok(appdata) = std::env::var("APPDATA") {
                let npm_global = PathBuf::from(&appdata).join("npm").join("claude.cmd");
                if npm_global.exists() {
                    return Ok(npm_global.to_string_lossy().to_string());
                }
            }
            // NVM for Windows
            if let Ok(nvm_home) = std::env::var("NVM_HOME") {
                // nvm symlink lives under NVM_SYMLINK (default: C:\Program Files\nodejs)
                if let Ok(nvm_symlink) = std::env::var("NVM_SYMLINK") {
                    let p = PathBuf::from(&nvm_symlink).join("claude.cmd");
                    if p.exists() {
                        return Ok(p.to_string_lossy().to_string());
                    }
                }
                // Also scan NVM_HOME/<version>
                if let Ok(entries) = std::fs::read_dir(&nvm_home) {
                    let mut candidates: Vec<PathBuf> = entries
                        .filter_map(|e| e.ok())
                        .map(|e| e.path().join("claude.cmd"))
                        .filter(|p| p.exists())
                        .collect();
                    candidates.sort();
                    candidates.reverse();
                    if let Some(path) = candidates.first() {
                        return Ok(path.to_string_lossy().to_string());
                    }
                }
            }
        }
    }

    // 7. Check standard paths (Unix only)
    #[cfg(not(target_os = "windows"))]
    {
        let standard_paths = [
            "/usr/local/bin/claude",
            "/opt/homebrew/bin/claude",
            "/usr/bin/claude",
            "/bin/claude",
        ];
        for path in &standard_paths {
            if PathBuf::from(path).exists() {
                return Ok(path.to_string());
            }
        }
    }

    // 8. Check user-specific paths
    if let Some(home) = dirs::home_dir() {
        #[cfg(not(target_os = "windows"))]
        let user_paths = unix_claude_candidate_paths(&home, std::env::var_os("PNPM_HOME"));
        #[cfg(target_os = "windows")]
        let user_paths = vec![
            home.join(".claude").join("local").join("claude.exe"),
            home.join("AppData")
                .join("Local")
                .join("Programs")
                .join("claude")
                .join("claude.exe"),
            // Volta
            home.join("AppData")
                .join("Local")
                .join("Volta")
                .join("bin")
                .join("claude.cmd"),
            // pnpm global
            home.join("AppData")
                .join("Local")
                .join("pnpm")
                .join("claude.cmd"),
            // Scoop
            home.join("scoop")
                .join("shims")
                .join("claude.cmd"),
            // Standard Node.js install
            PathBuf::from(r"C:\Program Files\nodejs\claude.cmd"),
        ];

        for path in &user_paths {
            if path.exists() {
                return Ok(path.to_string_lossy().to_string());
            }
        }
    }

    Err("Not found in any known location. Install from https://claude.ai".to_string())
}

#[cfg(any(test, not(target_os = "windows")))]
fn unix_claude_candidate_paths(home: &std::path::Path, pnpm_home: Option<std::ffi::OsString>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(pnpm_home) = pnpm_home.filter(|value| !value.is_empty()) {
        paths.push(PathBuf::from(pnpm_home).join("claude"));
    }
    paths.extend([
        home.join("Library").join("pnpm").join("claude"),
        home.join(".local").join("share").join("pnpm").join("claude"),
        home.join(".pnpm").join("claude"),
        home.join(".claude").join("local").join("claude"),
        home.join(".npm-global").join("bin").join("claude"),
        home.join(".yarn").join("bin").join("claude"),
        home.join(".bun").join("bin").join("claude"),
        home.join("bin").join("claude"),
    ]);
    paths
}

#[cfg(any(test, not(target_os = "windows")))]
fn unix_claude_path_from_bin_dir(bin_dir: impl Into<PathBuf>) -> PathBuf {
    bin_dir.into().join("claude")
}

#[cfg(any(test, not(target_os = "windows")))]
fn unix_claude_path_from_npm_prefix(prefix: impl Into<PathBuf>) -> PathBuf {
    prefix.into().join("bin").join("claude")
}

#[cfg(not(target_os = "windows"))]
fn run_login_shell_command(command: &str) -> Option<String> {
    let shell_env = std::env::var("SHELL").ok();
    let mut shells = Vec::new();
    if let Some(shell) = shell_env {
        shells.push(shell);
    }
    for fallback in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
        if !shells.iter().any(|shell| shell == fallback) && PathBuf::from(fallback).exists() {
            shells.push(fallback.to_string());
        }
    }

    for shell in shells {
        if let Ok(output) = std::process::Command::new(&shell)
            .args(["-l", "-c", command])
            .output()
        {
            if output.status.success() {
                let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !value.is_empty() && value != "undefined" && value != "null" {
                    return Some(value);
                }
            }
        }
    }

    None
}

#[cfg(not(target_os = "windows"))]
fn unix_shell_manager_candidate_paths(home: &std::path::Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();

    if let Some(pnpm_bin) =
        run_login_shell_command("command -v pnpm >/dev/null 2>&1 && pnpm bin -g 2>/dev/null")
    {
        paths.push(unix_claude_path_from_bin_dir(pnpm_bin));
    }

    if let Some(npm_prefix) = run_login_shell_command(
        "command -v npm >/dev/null 2>&1 && npm config get prefix 2>/dev/null",
    ) {
        paths.push(unix_claude_path_from_npm_prefix(npm_prefix));
    }

    if let Some(yarn_bin) = run_login_shell_command(
        "command -v yarn >/dev/null 2>&1 && yarn global bin 2>/dev/null",
    ) {
        paths.push(unix_claude_path_from_bin_dir(yarn_bin));
    }

    paths.extend(unix_known_pnpm_claude_paths(home));

    paths
}

#[cfg(any(test, not(target_os = "windows")))]
fn unix_known_pnpm_claude_paths(home: &std::path::Path) -> Vec<PathBuf> {
    vec![
        home.join("Library").join("pnpm").join("claude"),
        home.join("Library").join("pnpm").join("global").join("bin").join("claude"),
        home.join(".local").join("share").join("pnpm").join("claude"),
        home.join(".local").join("share").join("pnpm").join("global").join("bin").join("claude"),
        home.join(".pnpm").join("claude"),
        home.join(".pnpm").join("global").join("bin").join("claude"),
    ]
}

#[cfg(any(test, not(target_os = "windows")))]
fn unix_extra_tool_dirs(home: &std::path::Path, pnpm_home: Option<std::ffi::OsString>) -> Vec<PathBuf> {
    let mut dirs = vec![
        home.join(".local").join("bin"),
        home.join(".cargo").join("bin"),
        home.join(".bun").join("bin"),
        home.join("Library").join("pnpm"),
        home.join("Library").join("pnpm").join("global").join("bin"),
        home.join(".local").join("share").join("pnpm"),
        home.join(".local").join("share").join("pnpm").join("global").join("bin"),
        home.join(".pnpm"),
        home.join(".pnpm").join("global").join("bin"),
        "/opt/homebrew/bin".into(),
        "/opt/homebrew/sbin".into(),
        "/usr/local/bin".into(),
    ];
    if let Some(pnpm_home) = pnpm_home.filter(|value| !value.is_empty()) {
        dirs.insert(0, PathBuf::from(pnpm_home));
    }
    dirs
}

/// Strip ANSI escape sequences from CLI output before sending to the frontend.
/// Handles CSI sequences (e.g. colors, cursor), OSC sequences, and private mode
/// sequences like `\x1b[?2026h` emitted by modern CLIs.
fn strip_ansi(s: &str) -> Cow<'_, str> {
    if !s.contains('\x1b') {
        return Cow::Borrowed(s);
    }
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.peek() {
                // CSI: ESC [ ... (letter)
                Some('[') => {
                    chars.next();
                    // consume until final byte (ASCII letter or ~)
                    while let Some(&ch) = chars.peek() {
                        chars.next();
                        if ch.is_ascii_alphabetic() || ch == '~' {
                            break;
                        }
                    }
                }
                // OSC: ESC ] ... (ST or BEL)
                Some(']') => {
                    chars.next();
                    while let Some(&ch) = chars.peek() {
                        chars.next();
                        if ch == '\x07' {
                            break;
                        }
                        if ch == '\x1b' {
                            if chars.peek() == Some(&'\\') {
                                chars.next();
                            }
                            break;
                        }
                    }
                }
                // Two-character sequences: ESC ( , ESC ) , etc.
                Some(&ch) if ch.is_ascii_alphabetic() || ch == '(' || ch == ')' => {
                    chars.next();
                }
                _ => {}
            }
        } else {
            out.push(c);
        }
    }
    Cow::Owned(out)
}

/// Strip interior nul bytes that would cause Command::spawn() to fail.
/// This can happen when prompts contain clipboard artifacts or encoding issues.
/// Returns a borrowed reference when no nul bytes are present (zero-alloc fast path).
fn strip_nul(s: &str) -> Cow<'_, str> {
    if s.contains('\0') {
        eprintln!(
            "[claude-spawn] stripped {} nul byte(s) from input",
            s.matches('\0').count()
        );
        Cow::Owned(s.replace('\0', ""))
    } else {
        Cow::Borrowed(s)
    }
}

/// Environment variables needed by child processes on Linux desktops.
/// These are required for xdg-open, D-Bus, and display server communication.
#[cfg(target_os = "linux")]
const LINUX_DESKTOP_ENV_VARS: &[&str] = &[
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_RUNTIME_DIR",
    "XDG_DATA_DIRS",
    "XDG_CONFIG_DIRS",
    "XDG_CURRENT_DESKTOP",
    "XDG_SESSION_TYPE",
    "DESKTOP_SESSION",
];

/// Sanitize environment for a child process spawned from an AppImage.
///
/// AppImages modify LD_LIBRARY_PATH, PATH, and other variables to point to
/// bundled libraries. Child processes that need to use host system binaries
/// (e.g. xdg-open for browser launch, curl for downloads) will break if they
/// inherit these modified variables. AppImage stores the originals with an
/// `_ORIG` suffix (e.g. `LD_LIBRARY_PATH_ORIG`).
///
/// This function:
/// 1. Closes stdin to prevent interactive prompts from blocking
/// 2. Restores original environment variables when running inside an AppImage
/// 3. Passes through Linux desktop environment variables (DISPLAY, XDG_*, etc.)
#[cfg(target_os = "linux")]
fn sanitize_appimage_env(cmd: &mut tokio::process::Command) {
    cmd.stdin(std::process::Stdio::null());

    if std::env::var("APPIMAGE").is_ok() {
        // Restore original environment variables that AppImage overrides
        for key in &[
            "LD_LIBRARY_PATH",
            "PATH",
            "GDK_PIXBUF_MODULE_FILE",
            "PYTHONPATH",
            "PERLLIB",
            "GSETTINGS_SCHEMA_DIR",
        ] {
            let orig_key = format!("{}_ORIG", key);
            match std::env::var(&orig_key) {
                Ok(orig) => {
                    cmd.env(key, orig);
                }
                Err(_) => {
                    cmd.env_remove(key);
                }
            }
        }
        // Remove AppImage-specific variables that poison child processes
        cmd.env_remove("GDK_BACKEND");
        cmd.env_remove("GIO_MODULE_DIR");
        cmd.env_remove("GIO_EXTRA_MODULES");
    }

    // Pass through Linux desktop environment variables
    for key in LINUX_DESKTOP_ENV_VARS {
        if let Ok(value) = std::env::var(key) {
            cmd.env(key, value);
        }
    }
}

/// On Windows, resolve a `.cmd` wrapper to its underlying Node.js script
/// so we can run `node <script.js>` directly, avoiding cmd.exe escaping issues.
/// Returns (program, extra_prefix_args).
#[cfg(target_os = "windows")]
fn resolve_cmd_to_node(program: &str) -> (String, Vec<String>) {
    let lower = program.to_lowercase();
    if !lower.ends_with(".cmd") && !lower.ends_with(".bat") {
        return (program.to_string(), vec![]);
    }
    // Try to find the JS entry point next to the .cmd file
    // npm .cmd wrappers invoke: node "<dir>\node_modules\<pkg>\cli.js" %*
    let cmd_dir = std::path::Path::new(program)
        .parent()
        .unwrap_or(std::path::Path::new("."));
    let cli_js = cmd_dir
        .join("node_modules")
        .join("@anthropic-ai")
        .join("claude-code")
        .join("cli.js");
    if cli_js.exists() {
        // Find node.exe — prefer one next to the .cmd, then fall back to PATH
        let node = {
            let local_node = cmd_dir.join("node.exe");
            if local_node.exists() {
                local_node.to_string_lossy().to_string()
            } else {
                "node".to_string()
            }
        };
        return (node, vec![cli_js.to_string_lossy().to_string()]);
    }
    // Fallback: use cmd.exe /C (may have issues with special chars in args)
    (
        "cmd.exe".to_string(),
        vec!["/C".to_string(), program.to_string()],
    )
}

/// Create a std::process::Command that handles .cmd/.bat files on Windows.
fn new_sync_command(program: &str) -> std::process::Command {
    #[cfg(target_os = "windows")]
    {

        let (resolved, prefix) = resolve_cmd_to_node(program);
        let mut c = std::process::Command::new(&resolved);
        c.creation_flags(CREATE_NO_WINDOW);
        if !prefix.is_empty() {
            c.args(&prefix);
        }
        return c;
    }
    #[cfg(not(target_os = "windows"))]
    std::process::Command::new(program)
}

/// Create a tokio Command with appropriate environment variables.
fn create_command(
    program: &str,
    args: Vec<String>,
    cwd: &str,
    effort_level: Option<&str>,
) -> Command {
    let clean_program = strip_nul(program);
    let clean_args: Vec<Cow<str>> = args.iter().map(|a| strip_nul(a)).collect();
    let clean_cwd = strip_nul(cwd);

    #[cfg(target_os = "windows")]
    let mut cmd = {

        let (resolved, prefix) = resolve_cmd_to_node(clean_program.as_ref());
        let mut c = Command::new(&resolved);
        c.creation_flags(CREATE_NO_WINDOW);
        if !prefix.is_empty() {
            c.args(&prefix);
        }
        c.args(clean_args.iter().map(|a| a.as_ref()));
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = Command::new(clean_program.as_ref());
        c.args(clean_args.iter().map(|a| a.as_ref()));
        c
    };
    cmd.current_dir(clean_cwd.as_ref());

    // Pipe stdout and stderr for streaming
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    // On Linux AppImage, restore original environment so child processes work correctly
    #[cfg(target_os = "linux")]
    sanitize_appimage_env(&mut cmd);

    // Remove all Claude Code internal env vars to prevent nested session detection
    // and other interference. Tauri inherits these when launched from a Claude Code session.
    cmd.env_remove("CLAUDECODE");
    cmd.env_remove("CLAUDE_AGENT_SDK_VERSION");
    for (key, _) in std::env::vars() {
        // Keep CLAUDE_CODE_GIT_BASH_PATH — Claude Code needs it on Windows to locate git-bash
        if key == "CLAUDE_CODE_GIT_BASH_PATH" {
            continue;
        }
        if key.starts_with("CLAUDE_CODE_") || key.starts_with("CLAUDE_AGENT_") {
            cmd.env_remove(&key);
        }
    }
    // Set effort level (default: low for fast responses)
    cmd.env("CLAUDE_CODE_EFFORT_LEVEL", effort_level.unwrap_or("low"));

    if let Some(credential) = stored_claude_credential() {
        if std::env::var("ANTHROPIC_API_KEY")
            .map(|value| value.trim().is_empty())
            .unwrap_or(true)
        {
            cmd.env("ANTHROPIC_API_KEY", credential.api_key);
        }

        if let Some(base_url) = credential.base_url {
            if std::env::var("ANTHROPIC_BASE_URL")
                .map(|value| value.trim().is_empty())
                .unwrap_or(true)
            {
                cmd.env("ANTHROPIC_BASE_URL", base_url);
            }
        }
    }

    // On Windows, ensure CLAUDE_CODE_GIT_BASH_PATH is set.
    // Claude Code requires git-bash to run on Windows.
    // Uses find_git_bash() which also validates user-specified paths.
    #[cfg(target_os = "windows")]
    {
        if let Some(bash_path) = find_git_bash() {
            cmd.env("CLAUDE_CODE_GIT_BASH_PATH", bash_path);
        }
    }

    // Build PATH: start with current PATH, prepend program dir and venv bin
    // Strip nul bytes from inherited PATH to prevent spawn failures
    let mut current_path = strip_nul(&std::env::var("PATH").unwrap_or_default()).into_owned();
    #[cfg(target_os = "windows")]
    let sep = ";";
    #[cfg(not(target_os = "windows"))]
    let sep = ":";

    // Add the program's parent directory to PATH if not already present
    if let Some(program_dir) = std::path::Path::new(program).parent() {
        let program_dir_str = program_dir.to_string_lossy();
        if !current_path.contains(program_dir_str.as_ref()) {
            current_path = format!("{}{}{}", program_dir_str, sep, current_path);
        }
    }

    // GUI apps (launched from Dock/Spotlight/Finder) inherit a minimal PATH
    // that lacks directories like /opt/homebrew/bin or ~/.local/bin.
    // MCP servers and other child processes that rely on tools installed there
    // (e.g. `uv`, `node`, `python`) would fail to start.
    // Prepend common tool directories so child processes can find them.
    // This mirrors the approach used by find_claude_binary() and extends it
    // to all child processes.  Fixes #87 and #90.
    #[cfg(not(target_os = "windows"))]
    if let Some(home) = dirs::home_dir() {
        let extra_dirs = unix_extra_tool_dirs(&home, std::env::var_os("PNPM_HOME"));
        // Also check NVM: if NVM_BIN is set, use it; otherwise scan ~/.nvm
        if let Ok(nvm_bin) = std::env::var("NVM_BIN") {
            let nvm_bin_path = std::path::PathBuf::from(&nvm_bin);
            if nvm_bin_path.exists() && !current_path.contains(&nvm_bin) {
                current_path = format!("{}{}{}", nvm_bin, sep, current_path);
            }
        } else {
            let nvm_dir = home.join(".nvm").join("versions").join("node");
            if nvm_dir.exists() {
                if let Ok(entries) = std::fs::read_dir(&nvm_dir) {
                    let mut candidates: Vec<std::path::PathBuf> = entries
                        .filter_map(|e| e.ok())
                        .map(|e| e.path().join("bin"))
                        .filter(|p| p.exists())
                        .collect();
                    candidates.sort();
                    candidates.reverse(); // prefer latest version
                    if let Some(nvm_bin_path) = candidates.first() {
                        let nvm_bin_str = nvm_bin_path.to_string_lossy();
                        if !current_path.contains(nvm_bin_str.as_ref()) {
                            current_path =
                                format!("{}{}{}", nvm_bin_str, sep, current_path);
                        }
                    }
                }
            }
        }
        for dir in extra_dirs {
            let dir_str = dir.to_string_lossy().to_string();
            if dir.exists() && !current_path.contains(&dir_str) {
                current_path = format!("{}{}{}", dir_str, sep, current_path);
            }
        }
    }

    // Auto-detect project venv and inject VIRTUAL_ENV + PATH
    let venv_dir = std::path::Path::new(cwd).join(".venv");
    if venv_dir.exists() {
        cmd.env("VIRTUAL_ENV", &venv_dir);
        #[cfg(not(target_os = "windows"))]
        let venv_bin = venv_dir.join("bin");
        #[cfg(target_os = "windows")]
        let venv_bin = venv_dir.join("Scripts");
        current_path = format!("{}{}{}", venv_bin.to_string_lossy(), sep, current_path);
    }

    cmd.env("PATH", current_path);

    cmd
}

fn with_prompt_transport(mut args: Vec<String>, prompt: String) -> (Vec<String>, Option<String>) {
    args.push("-p".to_string());
    #[cfg(target_os = "windows")]
    {
        (args, Some(prompt))
    }
    #[cfg(not(target_os = "windows"))]
    {
        args.push(prompt);
        (args, None)
    }
}

// ─── Event payloads (include tab_id for multi-tab routing) ───

#[derive(Clone, serde::Serialize)]
struct ClaudeOutputEvent {
    tab_id: String,
    data: String,
}

#[derive(Clone, serde::Serialize)]
struct ClaudeCompleteEvent {
    tab_id: String,
    success: bool,
}

#[derive(Clone, serde::Serialize)]
struct ClaudeErrorEvent {
    tab_id: String,
    data: String,
}

/// Spawn the Claude CLI process and stream output via Tauri events.
/// Events are emitted only to the originating window, tagged with tab_id.
async fn spawn_claude_process(
    window: WebviewWindow,
    mut cmd: Command,
    tab_id: String,
    stdin_payload: Option<String>,
) -> Result<(), String> {
    let window_label = window.label().to_string();
    let process_key = format!("{}:{}", window_label, tab_id);

    if stdin_payload.is_some() {
        cmd.stdin(std::process::Stdio::piped());
    }

    // Spawn the process
    let mut child = cmd.spawn().map_err(|e| {
        eprintln!(
            "[claude-spawn] Failed to spawn process for tab {}: {}",
            tab_id, e
        );
        format!(
            "Failed to spawn Claude process: {}. Is Claude Code CLI installed?",
            e
        )
    })?;

    if let Some(payload) = stdin_payload {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to acquire stdin for Claude process".to_string())?;
        stdin
            .write_all(payload.as_bytes())
            .await
            .map_err(|e| format!("Failed to write prompt to Claude process stdin: {}", e))?;
        stdin
            .shutdown()
            .await
            .map_err(|e| format!("Failed to close Claude process stdin: {}", e))?;
    }

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    // Get a clone of the process state Arc before any moves
    let process_arc = window
        .state::<ClaudeProcessState>()
        .inner()
        .processes
        .clone();

    // Store the child process in state (kill any existing process for this tab)
    {
        let mut processes = process_arc.lock().await;
        if let Some(mut existing) = processes.remove(&process_key) {
            let _ = existing.kill().await;
        }
        processes.insert(process_key.clone(), child);
    }

    let stdout_reader = BufReader::new(stdout);
    let stderr_reader = BufReader::new(stderr);
    let session_id_holder: Arc<std::sync::Mutex<Option<String>>> =
        Arc::new(std::sync::Mutex::new(None));
    let result_success_holder: Arc<std::sync::Mutex<Option<bool>>> =
        Arc::new(std::sync::Mutex::new(None));

    let start_time = std::time::Instant::now();

    // Spawn stdout streaming task — emit only to the originating window
    let win_stdout = window.clone();
    let session_id_stdout = session_id_holder.clone();
    let result_success_stdout = result_success_holder.clone();
    let tab_id_stdout = tab_id.clone();
    let stdout_task = tokio::spawn(async move {
        let mut lines = stdout_reader.lines();
        let mut line_count: u64 = 0;
        while let Ok(Some(line)) = lines.next_line().await {
            line_count += 1;
            let elapsed = start_time.elapsed().as_secs_f64();

            // Parse for system:init to extract session_id
            if let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) {
                let msg_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("?");
                let msg_sub = msg.get("subtype").and_then(|v| v.as_str()).unwrap_or("");
                eprintln!(
                    "[claude-stdout] [{}] +{:.1}s #{} type={} sub={} len={}",
                    tab_id_stdout,
                    elapsed,
                    line_count,
                    msg_type,
                    msg_sub,
                    line.len()
                );

                if msg.get("type").and_then(|v| v.as_str()) == Some("system")
                    && msg.get("subtype").and_then(|v| v.as_str()) == Some("init")
                {
                    if let Some(sid) = msg.get("session_id").and_then(|v| v.as_str()) {
                        if let Ok(mut guard) = session_id_stdout.lock() {
                            *guard = Some(sid.to_string());
                        }
                    }
                }

                if msg.get("type").and_then(|v| v.as_str()) == Some("result") {
                    let is_success =
                        msg.get("subtype").and_then(|v| v.as_str()) == Some("success");
                    if let Ok(mut guard) = result_success_stdout.lock() {
                        *guard = Some(is_success);
                    }
                }
            }

            // Emit output event to this window with tab_id
            let _ = win_stdout.emit(
                "claude-output",
                ClaudeOutputEvent {
                    tab_id: tab_id_stdout.clone(),
                    data: line,
                },
            );
        }
        eprintln!(
            "[claude-stdout] [{}] stream ended after {} lines ({:.1}s)",
            tab_id_stdout,
            line_count,
            start_time.elapsed().as_secs_f64()
        );
    });

    // Spawn stderr streaming task — emit only to the originating window
    let win_stderr = window.clone();
    let tab_id_stderr = tab_id.clone();
    let stderr_task = tokio::spawn(async move {
        let mut lines = stderr_reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            eprintln!(
                "[claude-stderr] [{}] +{:.1}s {}",
                tab_id_stderr,
                start_time.elapsed().as_secs_f64(),
                &line[..line.len().min(200)]
            );
            let _ = win_stderr.emit(
                "claude-error",
                ClaudeErrorEvent {
                    tab_id: tab_id_stderr.clone(),
                    data: line,
                },
            );
        }
    });

    // Spawn wait task — wait for process completion
    let process_arc_wait = process_arc.clone();
    let win_wait = window;
    let process_key_wait = process_key;
    let tab_id_wait = tab_id;
    let result_success_wait = result_success_holder.clone();
    tokio::spawn(async move {
        // Wait for stdout/stderr to finish
        let _ = stdout_task.await;
        let _ = stderr_task.await;

        // Wait for process exit and remove from map
        let mut processes = process_arc_wait.lock().await;
        let success = if let Some(mut child) = processes.remove(&process_key_wait) {
            match child.wait().await {
                Ok(status) => {
                    let exit_success = status.success();
                    let result_success = result_success_wait.lock().ok().and_then(|guard| *guard);
                    let success = exit_success || result_success == Some(true);
                    eprintln!(
                        "[claude-process] [{}] exited with status={} result_success={:?} final_success={} ({:.1}s)",
                        tab_id_wait,
                        status,
                        result_success,
                        success,
                        start_time.elapsed().as_secs_f64()
                    );
                    success
                }
                Err(e) => {
                    eprintln!(
                        "[claude-process] [{}] wait error: {} ({:.1}s)",
                        tab_id_wait,
                        e,
                        start_time.elapsed().as_secs_f64()
                    );
                    false
                }
            }
        } else {
            eprintln!(
                "[claude-process] [{}] no child found in map ({:.1}s)",
                tab_id_wait,
                start_time.elapsed().as_secs_f64()
            );
            false
        };
        drop(processes);

        // Emit completion event to this window with tab_id
        let _ = win_wait.emit(
            "claude-complete",
            ClaudeCompleteEvent {
                tab_id: tab_id_wait,
                success,
            },
        );
    });

    Ok(())
}

// ─── Setup / Status Commands ───

#[derive(serde::Serialize)]
pub struct ClaudeStatus {
    pub installed: bool,
    pub authenticated: bool,
    pub binary_path: Option<String>,
    pub version: Option<String>,
    pub account_email: Option<String>,
    pub provider_model: Option<String>,
    pub provider_base_url: Option<String>,
    /// Windows only: true when Git for Windows (git-bash) is not found.
    /// Claude Code requires git-bash to function on Windows.
    pub missing_git: bool,
}

/// Find the path to git-bash on Windows.
/// Returns `Some(path)` if found, `None` otherwise.
/// Used by both `create_command` (to set the env var) and `check_claude_status` (to report status).
#[cfg(target_os = "windows")]
fn find_git_bash() -> Option<String> {
    // 1. User-specified override (only if the path actually exists)
    if let Ok(p) = std::env::var("CLAUDE_CODE_GIT_BASH_PATH") {
        if PathBuf::from(&p).is_file() {
            return Some(p);
        }
    }

    // 2. Common install locations
    let candidates = [
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
    ];
    for path in &candidates {
        if PathBuf::from(path).is_file() {
            return Some(path.to_string());
        }
    }

    // 3. git on PATH → derive bash.exe location
    if let Ok(git_path) = which::which("git") {
        // git.exe is typically at Git/cmd/git.exe → bash.exe at Git/bin/bash.exe
        if let Some(cmd_dir) = git_path.parent() {
            if let Some(git_root) = cmd_dir.parent() {
                let bash = git_root.join("bin").join("bash.exe");
                if bash.is_file() {
                    return Some(bash.to_string_lossy().to_string());
                }
            }
        }
    }

    // 4. bash directly on PATH
    if let Ok(bash_path) = which::which("bash") {
        return Some(bash_path.to_string_lossy().to_string());
    }

    None
}

#[tauri::command]
pub async fn check_claude_status() -> Result<ClaudeStatus, String> {
    if let Some(credential) = stored_openai_compatible_credential() {
        return Ok(ClaudeStatus {
            installed: true,
            authenticated: true,
            binary_path: None,
            version: Some("OpenAI-compatible provider".to_string()),
            account_email: None,
            provider_model: Some(credential.model),
            provider_base_url: Some(credential.base_url),
            missing_git: false,
        });
    }

    // On Windows, check for Git for Windows first — Claude Code requires it.
    #[cfg(target_os = "windows")]
    let missing_git = find_git_bash().is_none();
    #[cfg(not(target_os = "windows"))]
    let missing_git = false;

    // Try to find binary
    let binary_path = match find_claude_binary() {
        Ok(path) => path,
        Err(_) => {
            return Ok(ClaudeStatus {
                installed: false,
                authenticated: false,
                binary_path: None,
                version: None,
                account_email: None,
                provider_model: None,
                provider_base_url: None,
                missing_git,
            });
        }
    };

    // Verify binary actually works by running --version
    let version_output = new_sync_command(&binary_path).arg("--version").output();

    let version = match version_output {
        Ok(output) if output.status.success() => {
            Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
        }
        _ => {
            // Binary found but doesn't work — on Windows this is often because
            // Git for Windows is missing (Claude Code needs git-bash).
            return Ok(ClaudeStatus {
                installed: false,
                authenticated: false,
                binary_path: None,
                version: None,
                account_email: None,
                provider_model: None,
                provider_base_url: None,
                missing_git,
            });
        }
    };

    // Check auth status
    let auth_output = new_sync_command(&binary_path)
        .args(["auth", "status"])
        .output();

    let (authenticated, account_email) = match auth_output {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            // Parse for email — claude auth status outputs account info
            let email = stdout.lines().find(|line| line.contains('@')).map(|line| {
                // Extract email-like substring
                line.split_whitespace()
                    .find(|word| word.contains('@'))
                    .unwrap_or(line.trim())
                    .to_string()
            });
            (true, email)
        }
        _ => match claude_credential_label() {
            Some(label) => (true, Some(label.to_string())),
            None => (false, None),
        },
    };

    Ok(ClaudeStatus {
        installed: true,
        authenticated,
        binary_path: Some(binary_path),
        version,
        account_email,
        provider_model: None,
        provider_base_url: None,
        missing_git,
    })
}

/// Return the list of directories the Claude Code installer needs.
#[cfg(not(target_os = "windows"))]
fn claude_required_dirs(home: &std::path::Path) -> Vec<PathBuf> {
    vec![
        home.join(".local").join("bin"),
        home.join(".local").join("share").join("claude"),
        home.join(".local").join("state").join("claude"),
        home.join(".claude"),
    ]
}

/// Try to create all required directories without elevation.
/// Returns Ok(true) if all succeeded, Ok(false) if any failed.
#[cfg(not(target_os = "windows"))]
fn try_create_dirs(dirs: &[PathBuf]) -> bool {
    dirs.iter().all(|dir| std::fs::create_dir_all(dir).is_ok())
}

/// Verify that all directories exist and are writable.
#[cfg(not(target_os = "windows"))]
fn verify_dirs_writable(dirs: &[PathBuf]) -> Result<(), String> {
    for dir in dirs {
        if !dir.exists() {
            return Err(format!(
                "Directory {} does not exist. \
                 Please run: sudo chown -R $(whoami) ~/.local",
                dir.display()
            ));
        }
        let test_file = dir.join(".prism_write_test");
        match std::fs::write(&test_file, "test") {
            Ok(_) => {
                let _ = std::fs::remove_file(&test_file);
            }
            Err(_) => {
                return Err(format!(
                    "Directory {} exists but is not writable. \
                     Please run: sudo chown -R $(whoami) ~/.local",
                    dir.display()
                ));
            }
        }
    }
    Ok(())
}

/// Build the shell script for elevated directory creation + chown.
#[cfg(not(target_os = "windows"))]
fn build_elevation_script(dirs: &[PathBuf], user: &str, local_dir: &std::path::Path) -> String {
    let dirs_list = dirs
        .iter()
        .map(|d| format!("'{}'", d.display()))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "mkdir -p {} && chown -R {} '{}'",
        dirs_list,
        user,
        local_dir.display()
    )
}

/// Ensure ~/.local/{bin,share/claude,state/claude} and ~/.claude exist and are writable.
/// If creation fails (e.g. ~/.local is owned by root), prompt for admin password via osascript.
#[cfg(not(target_os = "windows"))]
async fn ensure_local_dirs(window: &WebviewWindow) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    let required_dirs = claude_required_dirs(&home);

    // Try without elevation first
    if try_create_dirs(&required_dirs) {
        return Ok(());
    }

    // Need elevation — use osascript directly for reliability
    let user = std::env::var("USER").unwrap_or_default();
    let local_dir = home.join(".local");
    let script = build_elevation_script(&required_dirs, &user, &local_dir);

    let _ = window.emit(
        "install-output",
        "Requesting admin privileges to fix directory permissions...",
    );

    let output = std::process::Command::new("osascript")
        .args([
            "-e",
            &format!(
                "do shell script \"{}\" with administrator privileges",
                script
            ),
        ])
        .output()
        .map_err(|e| format!("Failed to run osascript: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Failed to fix directory permissions. Error: {}. \
             You can fix this manually by running: sudo chown -R $(whoami) ~/.local",
            stderr.trim()
        ));
    }

    // Verify directories are now writable
    verify_dirs_writable(&required_dirs)
}

#[tauri::command]
pub async fn install_claude_cli(window: WebviewWindow) -> Result<(), String> {
    // Ensure directories that the Claude Code installer expects exist.
    // The installer fails with EACCES if ~/.local is owned by root
    // (e.g. created by pip or another tool).
    #[cfg(not(target_os = "windows"))]
    {
        ensure_local_dirs(&window).await?;
    }

    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = tokio::process::Command::new("bash");
        c.args(["-c", "curl -fsSL https://claude.ai/install.sh | bash"]);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {

        let mut c = tokio::process::Command::new("powershell");
        c.creation_flags(CREATE_NO_WINDOW);
        c.args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "irm https://claude.ai/install.ps1 | iex",
        ]);
        c
    };
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.stdin(std::process::Stdio::null());

    // On Linux AppImage, restore original environment so curl/bash work correctly
    #[cfg(target_os = "linux")]
    sanitize_appimage_env(&mut cmd);

    // Inherit essential environment variables, ensuring ~/.local/bin is in PATH
    #[cfg(target_os = "windows")]
    let path_sep = ";";
    #[cfg(not(target_os = "windows"))]
    let path_sep = ":";
    for (key, value) in std::env::vars() {
        if key.eq_ignore_ascii_case("PATH") {
            // Prepend ~/.local/bin so the installer sees it in PATH
            if let Some(home) = dirs::home_dir() {
                let local_bin = home.join(".local").join("bin");
                let local_bin_str = local_bin.to_string_lossy();
                if !value.contains(local_bin_str.as_ref()) {
                    cmd.env("PATH", format!("{}{}{}", local_bin_str, path_sep, value));
                } else {
                    cmd.env("PATH", &value);
                }
            } else {
                cmd.env("PATH", &value);
            }
        } else if is_essential_env_var(&key) {
            cmd.env(&key, &value);
        }
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to run installer: {}", e))?;

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    let stdout_reader = BufReader::new(stdout);
    let stderr_reader = BufReader::new(stderr);

    // Stream stdout
    let win_stdout = window.clone();
    let stdout_task = tokio::spawn(async move {
        let mut lines = stdout_reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let clean = strip_ansi(&line);
            let _ = win_stdout.emit("install-output", clean.as_ref());
        }
    });

    // Stream stderr
    let win_stderr = window.clone();
    let stderr_task = tokio::spawn(async move {
        let mut lines = stderr_reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let clean = strip_ansi(&line);
            let _ = win_stderr.emit("install-error", clean.as_ref());
        }
    });

    // Wait for completion and emit result
    let win_complete = window;
    tokio::spawn(async move {
        let _ = stdout_task.await;
        let _ = stderr_task.await;

        let success = match child.wait().await {
            Ok(status) => status.success(),
            Err(_) => false,
        };

        let _ = win_complete.emit("install-complete", success);
    });

    Ok(())
}

#[tauri::command]
pub async fn login_claude(window: WebviewWindow) -> Result<(), String> {
    let binary_path = find_claude_binary().map_err(|e| format!("Claude CLI not found: {}", e))?;

    // Verify it actually exists
    let version_check = new_sync_command(&binary_path).arg("--version").output();

    if !version_check.as_ref().is_ok_and(|o| o.status.success()) {
        return Err("Claude CLI is not properly installed".to_string());
    }

    #[cfg(target_os = "windows")]
    let mut cmd = {

        let (resolved, prefix) = resolve_cmd_to_node(&binary_path);
        let mut c = tokio::process::Command::new(&resolved);
        c.creation_flags(CREATE_NO_WINDOW);
        if !prefix.is_empty() {
            c.args(&prefix);
        }
        c.args(["auth", "login"]);
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = tokio::process::Command::new(&binary_path);
        c.args(["auth", "login"]);
        c
    };
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.stdin(std::process::Stdio::null());

    // On Linux AppImage, restore original environment so xdg-open works
    #[cfg(target_os = "linux")]
    sanitize_appimage_env(&mut cmd);

    // Inherit essential environment variables
    for (key, value) in std::env::vars() {
        if key.eq_ignore_ascii_case("PATH") || is_essential_env_var(&key) {
            cmd.env(&key, &value);
        }
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to run auth login: {}", e))?;

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    let stdout_reader = BufReader::new(stdout);
    let stderr_reader = BufReader::new(stderr);

    // Stream stdout
    let win_stdout = window.clone();
    let stdout_task = tokio::spawn(async move {
        let mut lines = stdout_reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let clean = strip_ansi(&line);
            let _ = win_stdout.emit("login-output", clean.as_ref());
        }
    });

    // Stream stderr
    let win_stderr = window.clone();
    let stderr_task = tokio::spawn(async move {
        let mut lines = stderr_reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let clean = strip_ansi(&line);
            let _ = win_stderr.emit("login-error", clean.as_ref());
        }
    });

    // Wait for completion with a timeout.
    // If the browser fails to open (e.g. no default browser, AppImage env issues),
    // the CLI can hang indefinitely waiting for auth callback.
    let win_complete = window;
    let child = Arc::new(Mutex::new(child));
    let child_for_timeout = child.clone();
    tokio::spawn(async move {
        let timeout_duration = tokio::time::Duration::from_secs(120);
        let wait_result = tokio::time::timeout(timeout_duration, async {
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            child.lock().await.wait().await
        })
        .await;

        let success = match wait_result {
            Ok(Ok(status)) => status.success(),
            Ok(Err(_)) => false,
            Err(_) => {
                // Timeout — kill the stuck process
                let _ = child_for_timeout.lock().await.kill().await;
                false
            }
        };

        let _ = win_complete.emit("login-complete", success);
    });

    Ok(())
}

/// Common CLI flags shared across all Claude invocations.
fn common_claude_args() -> Vec<String> {
    vec![
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--dangerously-skip-permissions".to_string(),
        "--append-system-prompt".to_string(),
        concat!(
            "You are an AI assistant integrated into a LaTeX document editor (Prism). ",
            "Follow these rules strictly:\n",
            "1. PLANNING FIRST: Before making changes, use TodoWrite to create a step-by-step plan. ",
            "Break large tasks into small, incremental steps (one section or one logical unit per step).\n",
            "2. INCREMENTAL EDITS: Use the Edit tool to make small, targeted changes — one step at a time. ",
            "NEVER write or rewrite an entire file at once. Always prefer editing existing content over replacing it wholesale.\n",
            "3. STEP BY STEP: After each edit, mark the todo item as completed, then proceed to the next step. ",
            "This lets the user review changes incrementally.\n",
            "4. PRESERVE EXISTING CONTENT: Always read the file first. Keep the existing preamble, packages, ",
            "and structure intact. Only add or modify what is needed for the current step.\n",
            "5. LaTeX BEST PRACTICES: Use proper sectioning (\\chapter, \\section, \\subsection), ",
            "citations (\\cite), cross-references (\\label, \\ref), and BibTeX for bibliographies.\n",
            "6. SKILLS: If scientific skills are installed in .claude/skills/, follow their guidelines ",
            "for domain-specific tasks. Use skill-provided LaTeX packages (.sty) and code patterns.\n",
            "7. PYTHON: If a .venv/ exists in the project, it is already activated. ",
            "Use `uv pip install` to add packages and `python` to run scripts."
        ).to_string(),
    ]
}

// ─── Tauri Commands ───

fn direct_provider_system_prompt() -> String {
    [
        "You are an AI assistant integrated into ClaudePrism, a LaTeX document editor.",
        "Help the user write, revise, and reason about academic documents.",
        "Preserve existing LaTeX structure unless the user asks for a rewrite.",
        "Use proper LaTeX sectioning, citations, labels, references, and bibliography conventions.",
        "You can inspect and edit files through the provided tools. Prefer relative paths inside the current project.",
        "Use LS or Glob to understand the project layout before editing unfamiliar files.",
        "Use Read before non-trivial edits, use Edit for precise replacements, and use Write only when creating or fully replacing a file.",
        "PDF attachments may have extracted text sidecars next to them, named like paper.pdf.txt. Read the sidecar when inspecting a PDF.",
        "For multi-step writing or editing tasks, use TodoWrite to keep a short plan with at most one in_progress item.",
        "If you prefer Claude/Codex-style task tools, TaskCreate, TaskUpdate, and TaskList are available as a lightweight session task list.",
        "ToolSearch can be used to inspect the currently available local tool names; it does not install external tools.",
        "Do not claim a file was changed unless a tool result confirms it.",
    ]
    .join("\n")
}

fn direct_provider_no_tools_system_prompt() -> String {
    [
        "You are an AI assistant integrated into ClaudePrism, a LaTeX document editor.",
        "Help the user write, revise, and reason about academic documents.",
        "Preserve existing LaTeX structure unless the user asks for a rewrite.",
        "Use proper LaTeX sectioning, citations, labels, references, and bibliography conventions.",
        "This provider endpoint does not support tool calls in ClaudePrism. Do not claim to read, edit, or run files directly.",
        "When file changes are needed, provide precise patches, replacement snippets, or step-by-step commands for the user.",
    ]
    .join("\n")
}

fn direct_provider_tools() -> serde_json::Value {
    json!([
        {
            "type": "function",
            "function": {
                "name": "Read",
                "description": "Read a UTF-8 text file from the current project. For PDFs, reads the ClaudePrism extracted text sidecar at <file>.pdf.txt when available.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "file_path": { "type": "string", "description": "Project-relative or absolute file path." },
                        "offset": { "type": "integer", "description": "Optional 1-based line offset." },
                        "limit": { "type": "integer", "description": "Optional maximum number of lines to return." }
                    },
                    "required": ["file_path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "Write",
                "description": "Create or replace a UTF-8 text file in the current project.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "file_path": { "type": "string", "description": "Project-relative or absolute file path." },
                        "content": { "type": "string", "description": "Complete file contents to write." }
                    },
                    "required": ["file_path", "content"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "Edit",
                "description": "Replace an exact string in a UTF-8 text file.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "file_path": { "type": "string", "description": "Project-relative or absolute file path." },
                        "old_string": { "type": "string", "description": "Exact text to replace." },
                        "new_string": { "type": "string", "description": "Replacement text." },
                        "replace_all": { "type": "boolean", "description": "Replace all matches instead of requiring a single match." }
                    },
                    "required": ["file_path", "old_string", "new_string"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "MultiEdit",
                "description": "Apply multiple exact string replacements to one UTF-8 text file.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "file_path": { "type": "string", "description": "Project-relative or absolute file path." },
                        "edits": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "old_string": { "type": "string" },
                                    "new_string": { "type": "string" },
                                    "replace_all": { "type": "boolean" }
                                },
                                "required": ["old_string", "new_string"]
                            }
                        }
                    },
                    "required": ["file_path", "edits"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "LS",
                "description": "List files and directories in a project directory.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Optional project-relative directory to list. Defaults to the project root." }
                    }
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "Glob",
                "description": "List project files matching a simple wildcard pattern such as *.tex or chapters/*.tex.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": { "type": "string", "description": "Wildcard pattern. * and ? are supported." },
                        "path": { "type": "string", "description": "Optional project-relative directory to search." }
                    },
                    "required": ["pattern"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "Grep",
                "description": "Search UTF-8 project files for a literal substring.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": { "type": "string", "description": "Literal text to search for." },
                        "path": { "type": "string", "description": "Optional project-relative file or directory to search." },
                        "glob": { "type": "string", "description": "Optional wildcard filter, for example *.tex." },
                        "case_sensitive": { "type": "boolean", "description": "Whether matching is case-sensitive. Defaults to false." }
                    },
                    "required": ["pattern"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "TodoWrite",
                "description": "Update the current session todo list for multi-step work. Keep at most one item in_progress.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "todos": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "content": { "type": "string", "description": "Concise task description." },
                                    "status": {
                                        "type": "string",
                                        "enum": ["pending", "in_progress", "completed"],
                                        "description": "Current task status."
                                    },
                                    "activeForm": { "type": "string", "description": "Present-tense form used while the task is active." }
                                },
                                "required": ["content", "status"]
                            }
                        }
                    },
                    "required": ["todos"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "ToolSearch",
                "description": "Inspect the local tool names available in this ClaudePrism direct-provider session. Supports queries like select:TaskCreate,TaskUpdate,TaskList.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "Search text, or select:<comma-separated tool names> to check exact availability." }
                    },
                    "required": ["query"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "TaskCreate",
                "description": "Create a lightweight task in the current direct-provider session task list.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "subject": { "type": "string", "description": "Brief task title." },
                        "description": { "type": "string", "description": "What needs to be done." },
                        "activeForm": { "type": "string", "description": "Present-tense form while the task is active." },
                        "metadata": { "type": "object", "description": "Optional metadata; accepted for compatibility." }
                    },
                    "required": ["subject", "description"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "TaskUpdate",
                "description": "Update a task in the current direct-provider session task list.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "taskId": { "type": "string", "description": "Task id returned by TaskCreate." },
                        "task_id": { "type": "string", "description": "Alias for taskId." },
                        "subject": { "type": "string", "description": "Updated task title." },
                        "description": { "type": "string", "description": "Updated task description." },
                        "activeForm": { "type": "string", "description": "Present-tense active form." },
                        "status": {
                            "type": "string",
                            "enum": ["pending", "in_progress", "completed", "deleted"],
                            "description": "Updated task status."
                        },
                        "owner": { "type": "string", "description": "Optional assignee name." }
                    },
                    "required": ["taskId"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "TaskList",
                "description": "List lightweight tasks in the current direct-provider session.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "status": {
                            "type": "string",
                            "enum": ["pending", "in_progress", "completed"],
                            "description": "Optional status filter."
                        }
                    }
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "Bash",
                "description": "Run a shell command in the current project directory. Use concise commands and prefer read-only commands before edits.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "description": "Shell command to run in the project directory." },
                        "description": { "type": "string", "description": "Short description of why the command is needed." },
                        "timeout_ms": { "type": "integer", "description": "Optional timeout in milliseconds. Defaults to 120000." }
                    },
                    "required": ["command"]
                }
            }
        }
    ])
}

fn direct_provider_functions() -> serde_json::Value {
    let Some(tools) = direct_provider_tools().as_array().cloned() else {
        return json!([]);
    };
    json!(
        tools
            .into_iter()
            .filter_map(|tool| tool.get("function").cloned())
            .collect::<Vec<_>>()
    )
}

fn openai_chat_completions_url(base_url: &str) -> String {
    let clean = base_url.trim_end_matches('/');
    if clean.ends_with("/chat/completions") {
        clean.to_string()
    } else if openai_compatible_base_url_has_chat_root(clean) {
        format!("{}/chat/completions", clean)
    } else {
        format!("{}/v1/chat/completions", clean)
    }
}

fn openai_compatible_base_url_has_chat_root(base_url: &str) -> bool {
    let lower = base_url.to_ascii_lowercase();
    if lower == "https://api.deepseek.com" || lower == "http://api.deepseek.com" {
        return true;
    }

    let path = lower
        .split_once("://")
        .and_then(|(_, rest)| rest.split_once('/').map(|(_, path)| path))
        .unwrap_or("")
        .trim_matches('/');
    if path.is_empty() {
        return false;
    }

    let segments = path.split('/').collect::<Vec<_>>();
    let last = segments.last().copied().unwrap_or_default();
    matches!(last, "v1" | "v2" | "v3" | "v4" | "beta")
        || path.ends_with("/openai")
        || path.ends_with("compatible-mode/v1")
}

fn direct_reasoning_history_mode(
    credential: &StoredOpenAiCompatibleCredential,
) -> DirectReasoningHistoryMode {
    let base_url = credential.base_url.to_ascii_lowercase();
    let model = credential.model.to_ascii_lowercase();
    if base_url.contains("api.deepseek.com") || model.starts_with("deepseek-v4") {
        DirectReasoningHistoryMode::Preserve
    } else {
        DirectReasoningHistoryMode::Strip
    }
}

fn json_usage(value: &serde_json::Value) -> serde_json::Value {
    let input_tokens = value
        .pointer("/usage/prompt_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let output_tokens = value
        .pointer("/usage/completion_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    json!({
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
    })
}

#[derive(Clone)]
struct DirectToolCall {
    id: String,
    name: String,
    input: serde_json::Value,
    legacy_function_call: bool,
}

struct DirectToolOutput {
    content: String,
    is_error: bool,
}

struct DirectChatResponse {
    message: serde_json::Value,
    content: String,
    reasoning: String,
    tool_calls: Vec<DirectToolCall>,
    usage: serde_json::Value,
    streamed_text: bool,
}

#[derive(Default)]
struct DirectStreamingToolCall {
    id: Option<String>,
    name: String,
    arguments: String,
    legacy_function_call: bool,
}

struct DirectStreamFailure {
    message: String,
    can_retry_non_streaming: bool,
    can_retry_without_tools: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum DirectToolRequestMode {
    Tools,
    Functions,
    None,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum DirectReasoningHistoryMode {
    Strip,
    Preserve,
}

fn emit_direct_output(window: &WebviewWindow, tab_id: &str, event: &serde_json::Value) {
    let _ = window.emit(
        "claude-output",
        ClaudeOutputEvent {
            tab_id: tab_id.to_string(),
            data: event.to_string(),
        },
    );
}

fn emit_direct_error(window: &WebviewWindow, tab_id: &str, message: impl Into<String>) {
    let _ = window.emit(
        "claude-error",
        ClaudeErrorEvent {
            tab_id: tab_id.to_string(),
            data: message.into(),
        },
    );
}

fn emit_direct_complete(window: &WebviewWindow, tab_id: &str, success: bool) {
    let _ = window.emit(
        "claude-complete",
        ClaudeCompleteEvent {
            tab_id: tab_id.to_string(),
            success,
        },
    );
}

fn session_event_with_timestamp(event: &serde_json::Value) -> serde_json::Value {
    let mut event = event.clone();
    if let Some(object) = event.as_object_mut() {
        object
            .entry("timestamp".to_string())
            .or_insert_with(|| json!(chrono::Utc::now().to_rfc3339()));
    }
    event
}

fn valid_session_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn append_direct_session_event(
    project_path: &str,
    session_id: &str,
    event: &serde_json::Value,
) -> Result<(), String> {
    if !valid_session_id(session_id) {
        return Err("Invalid session id".to_string());
    }

    let sessions_dir = get_sessions_dir(project_path)?;
    std::fs::create_dir_all(&sessions_dir)
        .map_err(|e| format!("Failed to create sessions directory: {}", e))?;
    let session_path = sessions_dir.join(format!("{}.jsonl", session_id));
    let event = session_event_with_timestamp(event);
    let line = serde_json::to_string(&event)
        .map_err(|e| format!("Failed to serialize session event: {}", e))?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&session_path)
        .map_err(|e| format!("Failed to open session file: {}", e))?;
    writeln!(file, "{}", line).map_err(|e| format!("Failed to write session event: {}", e))
}

fn emit_and_persist_direct_output(
    window: &WebviewWindow,
    project_path: &str,
    session_id: &str,
    tab_id: &str,
    event: &serde_json::Value,
) {
    emit_direct_output(window, tab_id, event);
    if let Err(err) = append_direct_session_event(project_path, session_id, event) {
        eprintln!("[direct-provider] failed to persist session event: {}", err);
    }
}

fn direct_task_state_event(tasks: &[DirectTask]) -> serde_json::Value {
    json!({
        "type": "direct_task_state",
        "tasks": tasks,
    })
}

fn load_direct_task_state_from_path(session_path: &Path) -> Result<Vec<DirectTask>, String> {
    if !session_path.exists() {
        return Ok(Vec::new());
    }

    let file = std::fs::File::open(session_path)
        .map_err(|e| format!("Failed to open session file: {}", e))?;
    let reader = std::io::BufReader::new(file);
    use std::io::BufRead;

    let mut latest_tasks = Vec::new();
    for line in reader.lines().map_while(Result::ok) {
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if entry.get("type").and_then(|v| v.as_str()) != Some("direct_task_state") {
            continue;
        }
        let Some(tasks) = entry.get("tasks") else {
            continue;
        };
        if let Ok(parsed) = serde_json::from_value::<Vec<DirectTask>>(tasks.clone()) {
            latest_tasks = parsed;
        }
    }

    Ok(latest_tasks)
}

fn load_direct_task_state(project_path: &str, session_id: &str) -> Result<Vec<DirectTask>, String> {
    if !valid_session_id(session_id) {
        return Ok(Vec::new());
    }
    let sessions_dir = get_sessions_dir(project_path)?;
    let session_path = sessions_dir.join(format!("{}.jsonl", session_id));
    load_direct_task_state_from_path(&session_path)
}

async fn hydrate_direct_task_state(
    state: &ClaudeProcessState,
    project_path: &str,
    session_id: &str,
) {
    let mut task_lists = state.direct_task_lists.lock().await;
    if task_lists.contains_key(session_id) {
        return;
    }
    let tasks = load_direct_task_state(project_path, session_id).unwrap_or_default();
    task_lists.insert(session_id.to_string(), tasks);
}

async fn persist_direct_task_state(
    state: &ClaudeProcessState,
    project_path: &str,
    session_id: &str,
) {
    let tasks = {
        let task_lists = state.direct_task_lists.lock().await;
        task_lists.get(session_id).cloned().unwrap_or_default()
    };
    let event = direct_task_state_event(&tasks);
    if let Err(err) = append_direct_session_event(project_path, session_id, &event) {
        eprintln!("[direct-provider] failed to persist task state: {}", err);
    }
}

fn is_direct_task_mutation_tool(name: &str) -> bool {
    matches!(
        canonical_direct_tool_name(name),
        Some("TaskCreate" | "TaskUpdate")
    )
}

async fn direct_provider_cancelled(state: &ClaudeProcessState, process_key: &str) -> bool {
    state
        .direct_cancellations
        .lock()
        .await
        .contains(process_key)
}

async fn clear_direct_provider_cancelled(state: &ClaudeProcessState, process_key: &str) {
    state.direct_cancellations.lock().await.remove(process_key);
}

fn claude_text_from_content_blocks(content: &serde_json::Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }

    let blocks = content.as_array()?;
    let text = blocks
        .iter()
        .filter(|block| block.get("type").and_then(|v| v.as_str()) == Some("text"))
        .filter_map(|block| block.get("text").and_then(|v| v.as_str()))
        .collect::<Vec<_>>()
        .join("\n\n");
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

fn load_direct_provider_messages(
    project_path: &str,
    session_id: &str,
) -> Result<Vec<serde_json::Value>, String> {
    if !valid_session_id(session_id) {
        return Ok(Vec::new());
    }

    let sessions_dir = get_sessions_dir(project_path)?;
    let session_path = sessions_dir.join(format!("{}.jsonl", session_id));
    if !session_path.exists() {
        return Ok(Vec::new());
    }

    let file = std::fs::File::open(&session_path)
        .map_err(|e| format!("Failed to open session file: {}", e))?;
    let reader = std::io::BufReader::new(file);
    use std::io::BufRead;

    let mut messages = Vec::new();
    for line in reader.lines().map_while(Result::ok) {
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        match entry.get("type").and_then(|v| v.as_str()) {
            Some("user") => {
                let Some(content) = entry.pointer("/message/content") else {
                    continue;
                };
                if let Some(blocks) = content.as_array() {
                    let tool_results: Vec<serde_json::Value> = blocks
                        .iter()
                        .filter(|block| {
                            block.get("type").and_then(|v| v.as_str()) == Some("tool_result")
                        })
                        .filter_map(|block| {
                            let tool_call_id = block.get("tool_use_id")?.as_str()?;
                            let content = block
                                .get("content")
                                .and_then(|v| v.as_str())
                                .map(|v| v.to_string())
                                .unwrap_or_else(|| {
                                    block
                                        .get("content")
                                        .map(|v| v.to_string())
                                        .unwrap_or_default()
                                });
                            Some(json!({
                                "role": "tool",
                                "tool_call_id": tool_call_id,
                                "content": content,
                            }))
                        })
                        .collect();
                    if !tool_results.is_empty() {
                        messages.extend(tool_results);
                        continue;
                    }
                }

                if let Some(text) = claude_text_from_content_blocks(content) {
                    messages.push(json!({ "role": "user", "content": text }));
                }
            }
            Some("assistant") => {
                let Some(content) = entry.pointer("/message/content") else {
                    continue;
                };
                let Some(blocks) = content.as_array() else {
                    continue;
                };

                let text = blocks
                    .iter()
                    .filter(|block| block.get("type").and_then(|v| v.as_str()) == Some("text"))
                    .filter_map(|block| block.get("text").and_then(|v| v.as_str()))
                    .collect::<Vec<_>>()
                    .join("\n\n");
                let tool_calls: Vec<serde_json::Value> = blocks
                    .iter()
                    .filter(|block| block.get("type").and_then(|v| v.as_str()) == Some("tool_use"))
                    .filter_map(|block| {
                        let id = block.get("id")?.as_str()?;
                        let name = block.get("name")?.as_str()?;
                        let input = block.get("input").cloned().unwrap_or_else(|| json!({}));
                        Some(json!({
                            "id": id,
                            "type": "function",
                            "function": {
                                "name": name,
                                "arguments": input.to_string(),
                            }
                        }))
                    })
                    .collect();

                if text.trim().is_empty() && tool_calls.is_empty() {
                    continue;
                }

                let mut message = json!({
                    "role": "assistant",
                    "content": if text.trim().is_empty() { serde_json::Value::Null } else { json!(text) },
                });
                if !tool_calls.is_empty() {
                    if let Some(object) = message.as_object_mut() {
                        object.insert("tool_calls".to_string(), json!(tool_calls));
                    }
                }
                messages.push(message);
            }
            _ => {}
        }
    }

    Ok(messages)
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

fn canonical_project_root(project_path: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(strip_nul(project_path).trim());
    let root = root
        .canonicalize()
        .map_err(|e| format!("Failed to resolve project path: {}", e))?;
    if !root.is_dir() {
        return Err("Project path is not a directory".to_string());
    }
    Ok(root)
}

fn tool_path_value(input: &serde_json::Value) -> Result<String, String> {
    for key in ["file_path", "path"] {
        if let Some(value) = input.get(key).and_then(|v| v.as_str()) {
            let clean = strip_nul(value).trim().to_string();
            if !clean.is_empty() {
                return Ok(clean);
            }
        }
    }
    Err("Missing file_path".to_string())
}

fn required_tool_string(input: &serde_json::Value, key: &str) -> Result<String, String> {
    input
        .get(key)
        .and_then(|v| v.as_str())
        .map(|value| strip_nul(value).into_owned())
        .ok_or_else(|| format!("Missing {}", key))
}

fn optional_tool_string(input: &serde_json::Value, key: &str) -> Option<String> {
    input
        .get(key)
        .and_then(|v| v.as_str())
        .map(|value| strip_nul(value).trim().to_string())
        .filter(|value| !value.is_empty())
}

fn optional_tool_string_any(input: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| optional_tool_string(input, key))
}

fn required_tool_string_any(input: &serde_json::Value, keys: &[&str]) -> Result<String, String> {
    optional_tool_string_any(input, keys).ok_or_else(|| format!("Missing {}", keys[0]))
}

fn optional_tool_usize(input: &serde_json::Value, key: &str) -> Option<usize> {
    input
        .get(key)
        .and_then(|v| v.as_u64())
        .and_then(|value| usize::try_from(value).ok())
}

fn resolve_project_tool_path(project_root: &Path, requested: &str) -> Result<PathBuf, String> {
    let clean = strip_nul(requested).trim().trim_matches('"').to_string();
    if clean.is_empty() {
        return Err("Path is empty".to_string());
    }

    let requested_path = PathBuf::from(&clean);
    let candidate = if requested_path.is_absolute() {
        requested_path
    } else {
        project_root.join(requested_path)
    };
    let normalized = lexical_normalize(&candidate);
    if !normalized.starts_with(project_root) {
        return Err("Refusing to access a path outside the project".to_string());
    }
    Ok(normalized)
}

fn ensure_existing_project_tool_path(
    project_root: &Path,
    requested: &str,
) -> Result<PathBuf, String> {
    let resolved = resolve_project_tool_path(project_root, requested)?;
    let canonical = resolved
        .canonicalize()
        .map_err(|e| format!("Failed to resolve path: {}", e))?;
    if !canonical.starts_with(project_root) {
        return Err("Refusing to access a path outside the project".to_string());
    }
    Ok(canonical)
}

fn nearest_existing_parent(path: &Path) -> Option<PathBuf> {
    let mut current = path.to_path_buf();
    loop {
        if current.exists() {
            return Some(current);
        }
        if !current.pop() {
            return None;
        }
    }
}

fn ensure_writable_project_tool_path(
    project_root: &Path,
    requested: &str,
) -> Result<PathBuf, String> {
    let resolved = resolve_project_tool_path(project_root, requested)?;
    if resolved.exists() {
        let canonical = resolved
            .canonicalize()
            .map_err(|e| format!("Failed to resolve path: {}", e))?;
        if !canonical.starts_with(project_root) {
            return Err("Refusing to write outside the project".to_string());
        }
        return Ok(canonical);
    }

    let parent = resolved
        .parent()
        .ok_or_else(|| "Path has no parent directory".to_string())?;
    let existing_parent = nearest_existing_parent(parent)
        .ok_or_else(|| "Could not resolve parent directory".to_string())?;
    let canonical_parent = existing_parent
        .canonicalize()
        .map_err(|e| format!("Failed to resolve parent directory: {}", e))?;
    if !canonical_parent.starts_with(project_root) {
        return Err("Refusing to write outside the project".to_string());
    }
    Ok(resolved)
}

fn relative_project_path(project_root: &Path, path: &Path) -> String {
    path.strip_prefix(project_root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn truncate_tool_content(content: String, max_chars: usize) -> String {
    if content.chars().count() <= max_chars {
        return content;
    }
    let truncated: String = content.chars().take(max_chars).collect();
    format!("{}\n\n[Output truncated after {} characters]", truncated, max_chars)
}

fn apply_exact_edit(content: &str, old: &str, new: &str, replace_all: bool) -> Result<String, String> {
    if old.is_empty() {
        return Err("old_string cannot be empty".to_string());
    }
    let count = content.matches(old).count();
    if count == 0 {
        return Err("old_string was not found".to_string());
    }
    if count > 1 && !replace_all {
        return Err(format!(
            "old_string matched {} times; set replace_all=true or provide a more specific old_string",
            count
        ));
    }
    if replace_all {
        Ok(content.replace(old, new))
    } else {
        Ok(content.replacen(old, new, 1))
    }
}

fn skip_direct_provider_dir(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|v| v.to_str()) else {
        return false;
    };
    matches!(
        name,
        ".git" | "node_modules" | "target" | "dist" | "build" | ".venv" | ".prism" | ".claudeprism"
    )
}

fn collect_project_files(dir: &Path, files: &mut Vec<PathBuf>, max_files: usize) -> Result<(), String> {
    if files.len() >= max_files {
        return Ok(());
    }
    if skip_direct_provider_dir(dir) {
        return Ok(());
    }
    let entries = std::fs::read_dir(dir)
        .map_err(|e| format!("Failed to read directory {}: {}", dir.display(), e))?;
    for entry in entries.flatten() {
        if files.len() >= max_files {
            break;
        }
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            collect_project_files(&path, files, max_files)?;
        } else if file_type.is_file() {
            files.push(path);
        }
    }
    Ok(())
}

fn wildcard_match(pattern: &str, text: &str) -> bool {
    let pattern = pattern.as_bytes();
    let text = text.as_bytes();
    let mut dp = vec![vec![false; text.len() + 1]; pattern.len() + 1];
    dp[0][0] = true;
    for i in 1..=pattern.len() {
        if pattern[i - 1] == b'*' {
            dp[i][0] = dp[i - 1][0];
        }
    }
    for i in 1..=pattern.len() {
        for j in 1..=text.len() {
            dp[i][j] = match pattern[i - 1] {
                b'*' => dp[i - 1][j] || dp[i][j - 1],
                b'?' => dp[i - 1][j - 1],
                ch => ch == text[j - 1] && dp[i - 1][j - 1],
            };
        }
    }
    dp[pattern.len()][text.len()]
}

fn is_pdf_file_path(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false)
}

fn pdf_text_sidecar_path(path: &Path) -> PathBuf {
    let mut sidecar = path.as_os_str().to_os_string();
    sidecar.push(".txt");
    PathBuf::from(sidecar)
}

fn execute_direct_read(project_root: &Path, input: &serde_json::Value) -> Result<String, String> {
    let file_path = tool_path_value(input)?;
    let path = ensure_existing_project_tool_path(project_root, &file_path)?;
    let mut read_path = path.clone();
    let mut read_note = None;

    if is_pdf_file_path(&path) {
        let sidecar = pdf_text_sidecar_path(&path);
        let pdf_display_path = relative_project_path(project_root, &path);
        let sidecar_display_path = relative_project_path(project_root, &sidecar);

        if sidecar.exists() {
            let canonical_sidecar = sidecar
                .canonicalize()
                .map_err(|e| format!("Failed to resolve PDF text sidecar: {}", e))?;
            if !canonical_sidecar.starts_with(project_root) {
                return Err("Refusing to read PDF text sidecar outside the project".to_string());
            }
            read_note = Some(format!(
                "[PDF text sidecar for {}: {}]",
                pdf_display_path, sidecar_display_path
            ));
            read_path = canonical_sidecar;
        } else {
            return Ok(format!(
                "[{}]\nPDF files are binary. ClaudePrism can read extracted PDF text when the sidecar exists at {}. Mention or attach this PDF in the chat composer to generate the sidecar, then read {}.",
                pdf_display_path, sidecar_display_path, sidecar_display_path
            ));
        }
    }

    let content = std::fs::read_to_string(&read_path)
        .map_err(|e| format!("Failed to read {}: {}", file_path, e))?;
    let offset = optional_tool_usize(input, "offset").unwrap_or(1).max(1);
    let limit = optional_tool_usize(input, "limit");
    let lines: Vec<&str> = content.lines().collect();
    let selected = lines
        .iter()
        .skip(offset.saturating_sub(1))
        .take(limit.unwrap_or(lines.len()))
        .copied()
        .collect::<Vec<_>>()
        .join("\n");
    let display_path = relative_project_path(project_root, &read_path);
    let body = if offset > 1 || limit.is_some() {
        format!(
            "{}[{} lines {}-{}]\n{}",
            read_note
                .as_ref()
                .map(|note| format!("{}\n", note))
                .unwrap_or_default(),
            display_path,
            offset,
            offset + selected.lines().count().saturating_sub(1),
            selected
        )
    } else {
        format!(
            "{}[{}]\n{}",
            read_note
                .as_ref()
                .map(|note| format!("{}\n", note))
                .unwrap_or_default(),
            display_path,
            content
        )
    };
    Ok(truncate_tool_content(body, 20000))
}

fn execute_direct_write(project_root: &Path, input: &serde_json::Value) -> Result<String, String> {
    let file_path = tool_path_value(input)?;
    let content = required_tool_string(input, "content")?;
    let path = ensure_writable_project_tool_path(project_root, &file_path)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent directory: {}", e))?;
    }
    std::fs::write(&path, content)
        .map_err(|e| format!("Failed to write {}: {}", file_path, e))?;
    Ok(format!("Wrote {}", relative_project_path(project_root, &path)))
}

fn execute_direct_edit(project_root: &Path, input: &serde_json::Value) -> Result<String, String> {
    let file_path = tool_path_value(input)?;
    let old = required_tool_string(input, "old_string")?;
    let new = required_tool_string(input, "new_string")?;
    let replace_all = input
        .get("replace_all")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let path = ensure_existing_project_tool_path(project_root, &file_path)?;
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {}", file_path, e))?;
    let updated = apply_exact_edit(&content, &old, &new, replace_all)?;
    std::fs::write(&path, updated)
        .map_err(|e| format!("Failed to write {}: {}", file_path, e))?;
    Ok(format!("Edited {}", relative_project_path(project_root, &path)))
}

fn execute_direct_multiedit(project_root: &Path, input: &serde_json::Value) -> Result<String, String> {
    let file_path = tool_path_value(input)?;
    let edits = input
        .get("edits")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "Missing edits".to_string())?;
    if edits.is_empty() {
        return Err("edits cannot be empty".to_string());
    }

    let path = ensure_existing_project_tool_path(project_root, &file_path)?;
    let mut content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {}", file_path, e))?;
    for (idx, edit) in edits.iter().enumerate() {
        let old = required_tool_string(edit, "old_string")
            .map_err(|e| format!("Edit {}: {}", idx + 1, e))?;
        let new = required_tool_string(edit, "new_string")
            .map_err(|e| format!("Edit {}: {}", idx + 1, e))?;
        let replace_all = edit
            .get("replace_all")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        content = apply_exact_edit(&content, &old, &new, replace_all)
            .map_err(|e| format!("Edit {}: {}", idx + 1, e))?;
    }
    std::fs::write(&path, content)
        .map_err(|e| format!("Failed to write {}: {}", file_path, e))?;
    Ok(format!(
        "Applied {} edits to {}",
        edits.len(),
        relative_project_path(project_root, &path)
    ))
}

fn execute_direct_ls(project_root: &Path, input: &serde_json::Value) -> Result<String, String> {
    let base = optional_tool_string(input, "path")
        .or_else(|| optional_tool_string(input, "file_path"))
        .map(|path| ensure_existing_project_tool_path(project_root, &path))
        .transpose()?
        .unwrap_or_else(|| project_root.to_path_buf());
    if !base.is_dir() {
        return Err("LS path must be a directory".to_string());
    }

    let mut entries = Vec::new();
    let read_dir = std::fs::read_dir(&base)
        .map_err(|e| format!("Failed to list {}: {}", base.display(), e))?;
    for entry in read_dir.flatten() {
        let path = entry.path();
        if skip_direct_provider_dir(&path) {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let mut rel = relative_project_path(project_root, &path);
        if file_type.is_dir() {
            rel.push('/');
        }
        entries.push(rel);
    }
    entries.sort();
    entries.truncate(200);

    let display_path = relative_project_path(project_root, &base);
    if entries.is_empty() {
        Ok(format!("[{}]\nNo entries", display_path))
    } else {
        Ok(format!("[{}]\n{}", display_path, entries.join("\n")))
    }
}

fn execute_direct_glob(project_root: &Path, input: &serde_json::Value) -> Result<String, String> {
    let pattern = required_tool_string(input, "pattern")?;
    let base = optional_tool_string(input, "path")
        .map(|path| ensure_existing_project_tool_path(project_root, &path))
        .transpose()?
        .unwrap_or_else(|| project_root.to_path_buf());
    if !base.is_dir() {
        return Err("Glob path must be a directory".to_string());
    }

    let mut files = Vec::new();
    collect_project_files(&base, &mut files, 2000)?;
    let pattern = pattern.replace('\\', "/");
    let mut matches = files
        .into_iter()
        .filter_map(|path| {
            let rel = relative_project_path(project_root, &path);
            let name = path.file_name()?.to_str()?;
            if wildcard_match(&pattern, &rel) || wildcard_match(&pattern, name) {
                Some(rel)
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    matches.sort();
    matches.truncate(200);
    if matches.is_empty() {
        Ok("No files matched".to_string())
    } else {
        Ok(matches.join("\n"))
    }
}

fn looks_like_text_file(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase().as_str(),
        "tex"
            | "bib"
            | "sty"
            | "cls"
            | "md"
            | "txt"
            | "json"
            | "yaml"
            | "yml"
            | "toml"
            | "rs"
            | "ts"
            | "tsx"
            | "js"
            | "jsx"
            | "py"
            | "sh"
            | "ps1"
            | "html"
            | "css"
            | "csv"
    )
}

fn execute_direct_grep(project_root: &Path, input: &serde_json::Value) -> Result<String, String> {
    let pattern = required_tool_string(input, "pattern")?;
    if pattern.is_empty() {
        return Err("pattern cannot be empty".to_string());
    }
    let case_sensitive = input
        .get("case_sensitive")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let glob_filter = optional_tool_string(input, "glob").map(|value| value.replace('\\', "/"));
    let base = optional_tool_string(input, "path")
        .map(|path| ensure_existing_project_tool_path(project_root, &path))
        .transpose()?
        .unwrap_or_else(|| project_root.to_path_buf());

    let mut files = Vec::new();
    if base.is_file() {
        files.push(base);
    } else {
        collect_project_files(&base, &mut files, 4000)?;
    }

    let needle = if case_sensitive {
        pattern.clone()
    } else {
        pattern.to_lowercase()
    };
    let mut results = Vec::new();
    for path in files {
        if results.len() >= 200 {
            break;
        }
        if !looks_like_text_file(&path) {
            continue;
        }
        let rel = relative_project_path(project_root, &path);
        if let Some(glob) = &glob_filter {
            let name = path.file_name().and_then(|v| v.to_str()).unwrap_or("");
            if !wildcard_match(glob, &rel) && !wildcard_match(glob, name) {
                continue;
            }
        }
        let Ok(metadata) = std::fs::metadata(&path) else {
            continue;
        };
        if metadata.len() > 2_000_000 {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        for (idx, line) in content.lines().enumerate() {
            let haystack = if case_sensitive {
                line.to_string()
            } else {
                line.to_lowercase()
            };
            if haystack.contains(&needle) {
                results.push(format!("{}:{}:{}", rel, idx + 1, line.trim_end()));
                if results.len() >= 200 {
                    break;
                }
            }
        }
    }

    if results.is_empty() {
        Ok("No matches found".to_string())
    } else {
        Ok(results.join("\n"))
    }
}

fn execute_direct_todowrite(input: &serde_json::Value) -> Result<String, String> {
    let todos = input
        .get("todos")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "Missing todos".to_string())?;
    if todos.len() > 100 {
        return Err("Todo list cannot exceed 100 items".to_string());
    }

    let mut in_progress_count = 0_usize;
    let mut lines = Vec::new();
    for (idx, todo) in todos.iter().enumerate() {
        let content = required_tool_string(todo, "content")
            .map_err(|e| format!("Todo {}: {}", idx + 1, e))?;
        let status = required_tool_string(todo, "status")
            .map_err(|e| format!("Todo {}: {}", idx + 1, e))?;
        if !matches!(status.as_str(), "pending" | "in_progress" | "completed") {
            return Err(format!(
                "Todo {}: status must be pending, in_progress, or completed",
                idx + 1
            ));
        }
        if status == "in_progress" {
            in_progress_count += 1;
        }
        lines.push(format!("{}. [{}] {}", idx + 1, status, content));
    }

    let mut output = if lines.is_empty() {
        "Todo list cleared".to_string()
    } else {
        format!("Todo list updated ({} items).\n{}", todos.len(), lines.join("\n"))
    };
    if in_progress_count > 1 {
        output.push_str("\n\nNote: Keep at most one todo in_progress at a time.");
    }
    Ok(output)
}

fn direct_tool_catalog() -> Vec<(&'static str, &'static str)> {
    vec![
        ("Read", "Read a UTF-8 text file from the current project."),
        ("Write", "Create or replace a UTF-8 text file in the current project."),
        ("Edit", "Replace an exact string in a UTF-8 text file."),
        ("MultiEdit", "Apply multiple exact string replacements to one file."),
        ("LS", "List files and directories in a project directory."),
        ("Glob", "List project files matching a wildcard pattern."),
        ("Grep", "Search project files for a literal substring."),
        ("TodoWrite", "Update a concise multi-step plan."),
        ("TaskCreate", "Create a lightweight session task."),
        ("TaskUpdate", "Update a lightweight session task."),
        ("TaskList", "List lightweight session tasks."),
        ("ToolSearch", "Inspect available local tool names."),
        ("Bash", "Run a shell command in the current project directory."),
    ]
}

fn canonical_direct_tool_name(name: &str) -> Option<&'static str> {
    let normalized = name
        .trim()
        .chars()
        .filter(|c| *c != '_' && *c != '-' && !c.is_whitespace())
        .collect::<String>()
        .to_ascii_lowercase();
    direct_tool_catalog()
        .into_iter()
        .find_map(|(tool_name, _)| {
            let tool_normalized = tool_name.to_ascii_lowercase();
            (tool_normalized == normalized).then_some(tool_name)
        })
}

fn execute_direct_toolsearch(input: &serde_json::Value) -> Result<String, String> {
    let query = required_tool_string(input, "query")?;
    let trimmed = query.trim();
    let catalog = direct_tool_catalog();

    if trimmed.to_ascii_lowercase().starts_with("select:") {
        let selection = &trimmed["select:".len()..];
        let requested = selection
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>();
        if requested.is_empty() {
            return Err("select: query did not include any tool names".to_string());
        }

        let mut found = Vec::new();
        let mut missing = Vec::new();
        for tool_name in requested {
            if let Some(canonical) = canonical_direct_tool_name(tool_name) {
                found.push(canonical.to_string());
            } else {
                missing.push(tool_name.to_string());
            }
        }

        let mut lines = Vec::new();
        if !found.is_empty() {
            lines.push(format!("Selected tools: {}", found.join(", ")));
        }
        if !missing.is_empty() {
            lines.push(format!("Missing tools: {}", missing.join(", ")));
        }
        lines.push("Selected tools are already available in this direct-provider session; no installation step is needed.".to_string());
        return Ok(lines.join("\n"));
    }

    let terms = trimmed
        .to_ascii_lowercase()
        .split_whitespace()
        .map(|value| value.to_string())
        .collect::<Vec<_>>();
    let matches = catalog
        .into_iter()
        .filter(|(name, description)| {
            if terms.is_empty() {
                return true;
            }
            let haystack = format!("{} {}", name, description).to_ascii_lowercase();
            terms.iter().all(|term| haystack.contains(term))
        })
        .map(|(name, description)| format!("- {}: {}", name, description))
        .collect::<Vec<_>>();

    if matches.is_empty() {
        Ok("No matching local tools found. Available core tools include Read, Edit, TodoWrite, TaskCreate, TaskUpdate, TaskList, and Bash.".to_string())
    } else {
        Ok(format!("Available local tools:\n{}", matches.join("\n")))
    }
}

fn normalize_direct_task_status(status: &str) -> Option<&'static str> {
    match status.trim().to_ascii_lowercase().as_str() {
        "pending" | "todo" | "open" => Some("pending"),
        "in_progress" | "in-progress" | "in progress" | "active" | "working" => {
            Some("in_progress")
        }
        "completed" | "complete" | "done" | "resolved" => Some("completed"),
        "deleted" | "delete" | "remove" | "removed" => Some("deleted"),
        _ => None,
    }
}

fn next_direct_task_id(tasks: &[DirectTask]) -> String {
    let next = tasks
        .iter()
        .filter_map(|task| task.id.strip_prefix("task-"))
        .filter_map(|suffix| suffix.parse::<u64>().ok())
        .max()
        .unwrap_or(0)
        + 1;
    format!("task-{}", next)
}

fn format_direct_task(task: &DirectTask) -> String {
    let mut parts = vec![format!(
        "{} [{}] {} - {}",
        task.id, task.status, task.subject, task.description
    )];
    if let Some(owner) = &task.owner {
        parts.push(format!("owner: {}", owner));
    }
    if let Some(active_form) = &task.active_form {
        parts.push(format!("activeForm: {}", active_form));
    }
    parts.join(" | ")
}

async fn execute_direct_task_create(
    state: &ClaudeProcessState,
    session_id: &str,
    input: &serde_json::Value,
) -> Result<String, String> {
    let subject = required_tool_string(input, "subject")?.trim().to_string();
    let description = required_tool_string(input, "description")?.trim().to_string();
    if subject.is_empty() {
        return Err("subject cannot be empty".to_string());
    }
    if description.is_empty() {
        return Err("description cannot be empty".to_string());
    }

    let active_form = optional_tool_string_any(input, &["activeForm", "active_form"]);
    let mut task_lists = state.direct_task_lists.lock().await;
    let tasks = task_lists.entry(session_id.to_string()).or_default();
    let id = next_direct_task_id(tasks);
    let task = DirectTask {
        id: id.clone(),
        subject,
        description,
        active_form,
        status: "pending".to_string(),
        owner: None,
    };
    let line = format_direct_task(&task);
    tasks.push(task);
    Ok(format!(
        "Task created: {}\nUse TaskUpdate to change status or TaskList to review the session task list.",
        line
    ))
}

async fn execute_direct_task_update(
    state: &ClaudeProcessState,
    session_id: &str,
    input: &serde_json::Value,
) -> Result<String, String> {
    let task_id = required_tool_string_any(input, &["taskId", "task_id", "id"])?;
    let mut task_lists = state.direct_task_lists.lock().await;
    let tasks = task_lists.entry(session_id.to_string()).or_default();
    let Some(index) = tasks.iter().position(|task| task.id == task_id) else {
        return Err(format!(
            "Task not found: {}. Use TaskList to see current tasks or TaskCreate to add one.",
            task_id
        ));
    };

    if let Some(status) = optional_tool_string(input, "status") {
        let normalized = normalize_direct_task_status(&status)
            .ok_or_else(|| "status must be pending, in_progress, completed, or deleted".to_string())?;
        if normalized == "deleted" {
            let task = tasks.remove(index);
            return Ok(format!("Task deleted: {}", format_direct_task(&task)));
        }
        tasks[index].status = normalized.to_string();
    }
    if let Some(subject) = optional_tool_string(input, "subject") {
        tasks[index].subject = subject;
    }
    if let Some(description) = optional_tool_string(input, "description") {
        tasks[index].description = description;
    }
    if let Some(active_form) = optional_tool_string_any(input, &["activeForm", "active_form"]) {
        tasks[index].active_form = Some(active_form);
    }
    if let Some(owner) = optional_tool_string(input, "owner") {
        tasks[index].owner = Some(owner);
    }

    let in_progress_count = tasks
        .iter()
        .filter(|task| task.status == "in_progress")
        .count();
    let mut output = format!("Task updated: {}", format_direct_task(&tasks[index]));
    if tasks[index].status == "completed" {
        output.push_str("\nTask completed. Call TaskList to check remaining work.");
    }
    if in_progress_count > 1 {
        output.push_str("\nNote: keep at most one task in_progress at a time.");
    }
    Ok(output)
}

async fn execute_direct_task_list(
    state: &ClaudeProcessState,
    session_id: &str,
    input: &serde_json::Value,
) -> Result<String, String> {
    let status_filter = optional_tool_string(input, "status")
        .map(|status| {
            normalize_direct_task_status(&status)
                .filter(|status| *status != "deleted")
                .ok_or_else(|| "status must be pending, in_progress, or completed".to_string())
        })
        .transpose()?;
    let task_lists = state.direct_task_lists.lock().await;
    let tasks = task_lists.get(session_id).cloned().unwrap_or_default();
    if tasks.is_empty() {
        return Ok("No tasks in this direct-provider session. Use TodoWrite for a concise checklist or TaskCreate to add lightweight tasks.".to_string());
    }

    let lines = tasks
        .iter()
        .filter(|task| {
            status_filter
                .map(|status| task.status == status)
                .unwrap_or(true)
        })
        .map(format_direct_task)
        .collect::<Vec<_>>();

    if lines.is_empty() {
        let status = status_filter.unwrap_or("requested");
        Ok(format!("No tasks match status: {}", status))
    } else {
        Ok(format!("Session tasks:\n{}", lines.join("\n")))
    }
}

async fn execute_direct_bash(project_root: &Path, input: &serde_json::Value) -> Result<String, String> {
    let command = required_tool_string(input, "command")?;
    if command.trim().is_empty() {
        return Err("command cannot be empty".to_string());
    }
    let timeout_ms = input
        .get("timeout_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(120_000)
        .clamp(1_000, 300_000);
    #[cfg(not(target_os = "windows"))]
    let (shell, args) = ("sh", vec!["-c".to_string(), command.clone()]);
    #[cfg(target_os = "windows")]
    let (shell, args) = ("cmd", vec!["/C".to_string(), command.clone()]);

    let cwd = project_root.to_string_lossy().to_string();
    let mut cmd = create_command(shell, args, &cwd, None);
    cmd.kill_on_drop(true);
    let output = tokio::time::timeout(
        std::time::Duration::from_millis(timeout_ms),
        cmd.output(),
    )
    .await
    .map_err(|_| format!("Command timed out after {}ms", timeout_ms))?
    .map_err(|e| format!("Failed to run command: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let exit_code = output.status.code().unwrap_or(-1);
    Ok(truncate_tool_content(
        format!(
            "$ {}\nexit_code: {}\n\nstdout:\n{}\n\nstderr:\n{}",
            command, exit_code, stdout, stderr
        ),
        30000,
    ))
}

async fn execute_direct_provider_tool(
    state: &ClaudeProcessState,
    session_id: &str,
    project_root: &Path,
    name: &str,
    input: &serde_json::Value,
) -> DirectToolOutput {
    let result = match name {
        "Read" | "read" => execute_direct_read(project_root, input),
        "Write" | "write" => execute_direct_write(project_root, input),
        "Edit" | "edit" => execute_direct_edit(project_root, input),
        "MultiEdit" | "multiedit" => execute_direct_multiedit(project_root, input),
        "LS" | "ls" | "List" | "list" => execute_direct_ls(project_root, input),
        "Glob" | "glob" => execute_direct_glob(project_root, input),
        "Grep" | "grep" => execute_direct_grep(project_root, input),
        "TodoWrite" | "todowrite" | "todo_write" => execute_direct_todowrite(input),
        "ToolSearch" | "toolsearch" | "tool_search" => execute_direct_toolsearch(input),
        "TaskCreate" | "taskcreate" | "task_create" => {
            execute_direct_task_create(state, session_id, input).await
        }
        "TaskUpdate" | "taskupdate" | "task_update" => {
            execute_direct_task_update(state, session_id, input).await
        }
        "TaskList" | "tasklist" | "task_list" => {
            execute_direct_task_list(state, session_id, input).await
        }
        "Bash" | "bash" => execute_direct_bash(project_root, input).await,
        other => Err(format!("Unsupported tool: {}", other)),
    };

    match result {
        Ok(content) => DirectToolOutput {
            content,
            is_error: false,
        },
        Err(content) => DirectToolOutput {
            content,
            is_error: true,
        },
    }
}

fn parse_direct_tool_arguments(arguments: &serde_json::Value) -> serde_json::Value {
    if let Some(arguments) = arguments.as_str() {
        return serde_json::from_str::<serde_json::Value>(arguments)
            .unwrap_or_else(|_| json!({ "_raw_arguments": arguments }));
    }
    if arguments.is_object() {
        return arguments.clone();
    }
    json!({})
}

fn parse_direct_tool_calls(response: &serde_json::Value) -> Vec<DirectToolCall> {
    let calls: Vec<DirectToolCall> = response
        .pointer("/choices/0/message/tool_calls")
        .and_then(|v| v.as_array())
        .map(|calls| {
            calls
                .iter()
                .enumerate()
                .filter_map(|(idx, call)| {
                    let name = call.pointer("/function/name")?.as_str()?.to_string();
                    let id = call
                        .get("id")
                        .and_then(|v| v.as_str())
                        .map(|value| value.to_string())
                        .unwrap_or_else(|| format!("toolu_{}", idx + 1));
                    let input = call
                        .pointer("/function/arguments")
                        .map(parse_direct_tool_arguments)
                        .unwrap_or_else(|| json!({}));
                    Some(DirectToolCall {
                        id,
                        name,
                        input,
                        legacy_function_call: false,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    if !calls.is_empty() {
        return calls;
    }

    response
        .pointer("/choices/0/message/function_call")
        .and_then(|call| {
            let name = call.get("name")?.as_str()?.to_string();
            let input = call
                .get("arguments")
                .map(parse_direct_tool_arguments)
                .unwrap_or_else(|| json!({}));
            Some(vec![DirectToolCall {
                id: "function_call_1".to_string(),
                name,
                input,
                legacy_function_call: true,
            }])
        })
        .unwrap_or_default()
}

fn direct_assistant_content(response: &serde_json::Value) -> String {
    let Some(content) = response.pointer("/choices/0/message/content") else {
        return String::new();
    };
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    if let Some(parts) = content.as_array() {
        return parts
            .iter()
            .filter_map(|part| {
                part.get("text")
                    .and_then(|v| v.as_str())
                    .or_else(|| part.get("content").and_then(|v| v.as_str()))
            })
            .collect::<Vec<_>>()
            .join("\n\n");
    }
    String::new()
}

fn direct_assistant_reasoning(response: &serde_json::Value) -> String {
    let Some(message) = response.pointer("/choices/0/message") else {
        return String::new();
    };

    for key in ["reasoning_content", "reasoning", "reasoning_text"] {
        if let Some(text) = message.get(key).and_then(|v| v.as_str()) {
            return text.to_string();
        }
    }

    if let Some(parts) = message.get("content").and_then(|v| v.as_array()) {
        return parts
            .iter()
            .filter(|part| {
                matches!(
                    part.get("type").and_then(|v| v.as_str()),
                    Some("reasoning") | Some("thinking") | Some("reasoning_text")
                )
            })
            .filter_map(|part| {
                part.get("text")
                    .and_then(|v| v.as_str())
                    .or_else(|| part.get("content").and_then(|v| v.as_str()))
            })
            .collect::<Vec<_>>()
            .join("\n\n");
    }

    String::new()
}

fn sanitize_direct_assistant_message_for_history(
    mut message: serde_json::Value,
    _tool_calls: &[DirectToolCall],
    reasoning: &str,
    reasoning_history_mode: DirectReasoningHistoryMode,
) -> serde_json::Value {
    let Some(object) = message.as_object_mut() else {
        return message;
    };

    let preserve_reasoning = reasoning_history_mode == DirectReasoningHistoryMode::Preserve;

    if preserve_reasoning && !reasoning.trim().is_empty() {
        object
            .entry("reasoning_content".to_string())
            .or_insert_with(|| json!(reasoning));
    }

    if !preserve_reasoning {
        object.remove("reasoning_content");
    }
    object.remove("reasoning");
    object.remove("reasoning_text");

    if let Some(content) = object.get_mut("content") {
        if let Some(parts) = content.as_array_mut() {
            parts.retain(|part| {
                !matches!(
                    part.get("type").and_then(|v| v.as_str()),
                    Some("reasoning") | Some("thinking") | Some("reasoning_text")
                )
            });
        }
    }

    message
}

fn direct_chat_response_from_value(
    response: serde_json::Value,
    reasoning_history_mode: DirectReasoningHistoryMode,
) -> DirectChatResponse {
    let content = direct_assistant_content(&response);
    let reasoning = direct_assistant_reasoning(&response);
    let tool_calls = parse_direct_tool_calls(&response);
    let usage = json_usage(&response);
    let message = response
        .pointer("/choices/0/message")
        .cloned()
        .unwrap_or_else(|| json!({ "role": "assistant", "content": content.clone() }));
    let message = sanitize_direct_assistant_message_for_history(
        message,
        &tool_calls,
        &reasoning,
        reasoning_history_mode,
    );
    DirectChatResponse {
        message,
        content,
        reasoning,
        tool_calls,
        usage,
        streamed_text: false,
    }
}

fn direct_stream_text_delta(delta: &serde_json::Value) -> String {
    let Some(content) = delta.get("content") else {
        return String::new();
    };
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    if let Some(parts) = content.as_array() {
        return parts
            .iter()
            .filter_map(|part| {
                part.get("text")
                    .and_then(|v| v.as_str())
                    .or_else(|| part.get("content").and_then(|v| v.as_str()))
            })
            .collect::<Vec<_>>()
            .join("");
    }
    String::new()
}

fn direct_stream_reasoning_delta(delta: &serde_json::Value) -> String {
    for key in ["reasoning_content", "reasoning", "reasoning_text"] {
        if let Some(text) = delta.get(key).and_then(|v| v.as_str()) {
            return text.to_string();
        }
    }

    if let Some(parts) = delta.get("content").and_then(|v| v.as_array()) {
        return parts
            .iter()
            .filter(|part| {
                matches!(
                    part.get("type").and_then(|v| v.as_str()),
                    Some("reasoning") | Some("thinking") | Some("reasoning_text")
                )
            })
            .filter_map(|part| {
                part.get("text")
                    .and_then(|v| v.as_str())
                    .or_else(|| part.get("content").and_then(|v| v.as_str()))
            })
            .collect::<Vec<_>>()
            .join("");
    }

    String::new()
}

fn emit_direct_streaming_delta(
    window: &WebviewWindow,
    tab_id: &str,
    text: &str,
    reasoning: &str,
) {
    if text.is_empty() && reasoning.is_empty() {
        return;
    }
    let mut blocks = Vec::new();
    if !reasoning.is_empty() {
        blocks.push(json!({ "type": "thinking", "thinking": reasoning }));
    }
    if !text.is_empty() {
        blocks.push(json!({ "type": "text", "text": text }));
    }
    emit_direct_output(
        window,
        tab_id,
        &json!({
            "type": "assistant",
            "subtype": "streaming_delta",
            "message": {
                "content": blocks,
            },
        }),
    );
}

fn direct_tool_calls_from_stream(
    calls: HashMap<usize, DirectStreamingToolCall>,
) -> Vec<DirectToolCall> {
    let mut indexed = calls.into_iter().collect::<Vec<_>>();
    indexed.sort_by_key(|(idx, _)| *idx);
    indexed
        .into_iter()
        .filter_map(|(idx, call)| {
            if call.name.trim().is_empty() {
                return None;
            }
            let id = call.id.unwrap_or_else(|| format!("toolu_stream_{}", idx + 1));
            let input = serde_json::from_str::<serde_json::Value>(&call.arguments)
                .unwrap_or_else(|_| json!({ "_raw_arguments": call.arguments }));
            Some(DirectToolCall {
                id,
                name: call.name,
                input,
                legacy_function_call: call.legacy_function_call,
            })
        })
        .collect()
}

fn direct_message_from_parts(
    content: &str,
    reasoning: &str,
    tool_calls: &[DirectToolCall],
    reasoning_history_mode: DirectReasoningHistoryMode,
) -> serde_json::Value {
    let mut message = json!({
        "role": "assistant",
        "content": if content.trim().is_empty() {
            serde_json::Value::Null
        } else {
            json!(content)
        },
    });
    if reasoning_history_mode == DirectReasoningHistoryMode::Preserve
        && !reasoning.trim().is_empty()
    {
        if let Some(object) = message.as_object_mut() {
            object.insert("reasoning_content".to_string(), json!(reasoning));
        }
    }
    if let Some(tool_call) = tool_calls.iter().find(|tool_call| tool_call.legacy_function_call) {
        if let Some(object) = message.as_object_mut() {
            object.insert(
                "function_call".to_string(),
                json!({
                    "name": tool_call.name,
                    "arguments": tool_call.input.to_string(),
                }),
            );
        }
    } else if !tool_calls.is_empty() {
        if let Some(object) = message.as_object_mut() {
            object.insert(
                "tool_calls".to_string(),
                json!(
                    tool_calls
                        .iter()
                        .map(|tool_call| json!({
                            "id": tool_call.id,
                            "type": "function",
                            "function": {
                                "name": tool_call.name,
                                "arguments": tool_call.input.to_string(),
                            },
                        }))
                        .collect::<Vec<_>>()
                ),
            );
        }
    }
    message
}

fn provider_error_allows_toolless_retry(status: reqwest::StatusCode, body: &str) -> bool {
    if !(status == reqwest::StatusCode::BAD_REQUEST
        || status == reqwest::StatusCode::UNPROCESSABLE_ENTITY
        || status == reqwest::StatusCode::NOT_FOUND
        || status == reqwest::StatusCode::METHOD_NOT_ALLOWED)
    {
        return false;
    }
    let body = body.to_ascii_lowercase();
    body.contains("tool")
        || body.contains("tools")
        || body.contains("function")
        || body.contains("tool_choice")
        || body.contains("unsupported parameter")
        || body.contains("unknown parameter")
}

fn add_direct_request_tooling(request_body: &mut serde_json::Value, mode: DirectToolRequestMode) {
    let Some(object) = request_body.as_object_mut() else {
        return;
    };
    match mode {
        DirectToolRequestMode::Tools => {
            object.insert("tools".to_string(), direct_provider_tools());
            object.insert("tool_choice".to_string(), json!("auto"));
        }
        DirectToolRequestMode::Functions => {
            object.insert("functions".to_string(), direct_provider_functions());
            object.insert("function_call".to_string(), json!("auto"));
        }
        DirectToolRequestMode::None => {}
    }
}

fn direct_messages_for_legacy_functions(messages: Vec<serde_json::Value>) -> Vec<serde_json::Value> {
    let mut tool_names: HashMap<String, String> = HashMap::new();
    let mut converted = Vec::new();

    for mut message in messages {
        match message.get("role").and_then(|v| v.as_str()) {
            Some("assistant") => {
                if let Some(tool_calls) = message.get("tool_calls").and_then(|v| v.as_array()) {
                    for tool_call in tool_calls {
                        if let (Some(id), Some(name)) = (
                            tool_call.get("id").and_then(|v| v.as_str()),
                            tool_call.pointer("/function/name").and_then(|v| v.as_str()),
                        ) {
                            tool_names.insert(id.to_string(), name.to_string());
                        }
                    }

                    if let Some((name, arguments)) = tool_calls.first().map(|first| {
                        let name = first
                            .pointer("/function/name")
                            .and_then(|v| v.as_str())
                            .map(|v| v.to_string())
                            .unwrap_or_else(|| "tool".to_string());
                        let arguments = first
                            .pointer("/function/arguments")
                            .and_then(|v| v.as_str())
                            .map(|v| v.to_string())
                            .unwrap_or_else(|| {
                                first
                                    .pointer("/function/arguments")
                                    .map(|v| v.to_string())
                                    .unwrap_or_else(|| "{}".to_string())
                            });
                        (name, arguments)
                    }) {
                        if let Some(object) = message.as_object_mut() {
                            object.remove("tool_calls");
                            object.insert(
                                "function_call".to_string(),
                                json!({
                                    "name": name,
                                    "arguments": arguments,
                                }),
                            );
                            if object.get("content").is_none() {
                                object.insert("content".to_string(), serde_json::Value::Null);
                            }
                        }
                    }
                }
                converted.push(message);
            }
            Some("tool") => {
                let tool_call_id = message
                    .get("tool_call_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let name = tool_names
                    .get(tool_call_id)
                    .cloned()
                    .unwrap_or_else(|| "tool_result".to_string());
                let content = message
                    .get("content")
                    .and_then(|v| v.as_str())
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| {
                        message
                            .get("content")
                            .map(|v| v.to_string())
                            .unwrap_or_default()
                    });
                converted.push(json!({
                    "role": "function",
                    "name": name,
                    "content": content,
                }));
            }
            _ => converted.push(message),
        }
    }

    converted
}

fn direct_messages_for_tool_capability(
    messages: &[serde_json::Value],
    mode: DirectToolRequestMode,
) -> Vec<serde_json::Value> {
    if mode == DirectToolRequestMode::Tools {
        return messages.to_vec();
    }

    let mut messages = messages.to_vec();
    for message in &mut messages {
        let role = message.get("role").and_then(|v| v.as_str());
        if role == Some("system") {
            if let Some(object) = message.as_object_mut() {
                let prompt = if mode == DirectToolRequestMode::Functions {
                    direct_provider_system_prompt()
                } else {
                    direct_provider_no_tools_system_prompt()
                };
                object.insert("content".to_string(), json!(prompt));
            }
            break;
        }
    }

    if !messages
        .iter()
        .any(|message| message.get("role").and_then(|v| v.as_str()) == Some("system"))
    {
        messages.insert(
            0,
            json!({
                "role": "system",
                "content": if mode == DirectToolRequestMode::Functions {
                    direct_provider_system_prompt()
                } else {
                    direct_provider_no_tools_system_prompt()
                },
            }),
        );
    }

    if mode == DirectToolRequestMode::Functions {
        return direct_messages_for_legacy_functions(messages);
    }

    let mut sanitized = Vec::new();
    for mut message in messages {
        match message.get("role").and_then(|v| v.as_str()) {
            Some("assistant") => {
                if let Some(object) = message.as_object_mut() {
                    object.remove("tool_calls");
                    if object.get("content").map(|v| v.is_null()).unwrap_or(false) {
                        object.insert(
                            "content".to_string(),
                            json!("[Assistant requested a tool call, but this provider endpoint does not support tool calls.]"),
                        );
                    }
                }
                sanitized.push(message);
            }
            Some("tool") => {
                let tool_call_id = message
                    .get("tool_call_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                let content = message
                    .get("content")
                    .and_then(|v| v.as_str())
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| {
                        message
                            .get("content")
                            .map(|v| v.to_string())
                            .unwrap_or_default()
                    });
                sanitized.push(json!({
                    "role": "user",
                    "content": format!(
                        "[Previous tool result {}]\n{}",
                        tool_call_id,
                        content
                    ),
                }));
            }
            _ => sanitized.push(message),
        }
    }
    sanitized
}

async fn send_openai_compatible_chat_request(
    client: &reqwest::Client,
    credential: &StoredOpenAiCompatibleCredential,
    messages: &[serde_json::Value],
    window: &WebviewWindow,
    tab_id: &str,
    state: &ClaudeProcessState,
    process_key: &str,
) -> Result<DirectChatResponse, String> {
    match send_openai_compatible_streaming_chat_request(
        client,
        credential,
        messages,
        window,
        tab_id,
        state,
        process_key,
        DirectToolRequestMode::Tools,
    )
    .await
    {
        Ok(response) => Ok(response),
        Err(err) if err.can_retry_non_streaming => {
            eprintln!(
                "[direct-provider] streaming request failed, retrying non-streaming: {}",
                err.message
            );
            match send_openai_compatible_non_streaming_chat_request(
                client,
                credential,
                messages,
                DirectToolRequestMode::Tools,
            )
            .await
            {
                Ok(response) => Ok(response),
                Err(err) if err.can_retry_without_tools => {
                    eprintln!(
                        "[direct-provider] provider rejected modern tools, retrying legacy functions: {}",
                        err.message
                    );
                    send_openai_compatible_with_legacy_functions(
                        client, credential, messages, window, tab_id, state, process_key,
                    )
                    .await
                }
                Err(err) => Err(err.message),
            }
        }
        Err(err) if err.can_retry_without_tools => {
            eprintln!(
                "[direct-provider] provider rejected streaming tools, retrying legacy functions: {}",
                err.message
            );
            send_openai_compatible_with_legacy_functions(
                client, credential, messages, window, tab_id, state, process_key,
            )
            .await
        }
        Err(err) => Err(err.message),
    }
}

async fn send_openai_compatible_with_legacy_functions(
    client: &reqwest::Client,
    credential: &StoredOpenAiCompatibleCredential,
    messages: &[serde_json::Value],
    window: &WebviewWindow,
    tab_id: &str,
    state: &ClaudeProcessState,
    process_key: &str,
) -> Result<DirectChatResponse, String> {
    match send_openai_compatible_streaming_chat_request(
        client,
        credential,
        messages,
        window,
        tab_id,
        state,
        process_key,
        DirectToolRequestMode::Functions,
    )
    .await
    {
        Ok(response) => Ok(response),
        Err(err) if err.can_retry_non_streaming => {
            eprintln!(
                "[direct-provider] legacy function streaming failed, retrying non-streaming: {}",
                err.message
            );
            match send_openai_compatible_non_streaming_chat_request(
                client,
                credential,
                messages,
                DirectToolRequestMode::Functions,
            )
            .await
            {
                Ok(response) => Ok(response),
                Err(err) if err.can_retry_without_tools => {
                    eprintln!(
                        "[direct-provider] provider rejected legacy functions, retrying without tools: {}",
                        err.message
                    );
                    send_openai_compatible_without_tools(
                        client, credential, messages, window, tab_id, state, process_key,
                    )
                    .await
                }
                Err(err) => Err(err.message),
            }
        }
        Err(err) if err.can_retry_without_tools => {
            eprintln!(
                "[direct-provider] provider rejected legacy function streaming, retrying without tools: {}",
                err.message
            );
            send_openai_compatible_without_tools(
                client, credential, messages, window, tab_id, state, process_key,
            )
            .await
        }
        Err(err) => Err(err.message),
    }
}

async fn send_openai_compatible_without_tools(
    client: &reqwest::Client,
    credential: &StoredOpenAiCompatibleCredential,
    messages: &[serde_json::Value],
    window: &WebviewWindow,
    tab_id: &str,
    state: &ClaudeProcessState,
    process_key: &str,
) -> Result<DirectChatResponse, String> {
    match send_openai_compatible_streaming_chat_request(
        client,
        credential,
        messages,
        window,
        tab_id,
        state,
        process_key,
        DirectToolRequestMode::None,
    )
    .await
    {
        Ok(response) => Ok(response),
        Err(err) if err.can_retry_non_streaming => {
            send_openai_compatible_non_streaming_chat_request(
                client,
                credential,
                messages,
                DirectToolRequestMode::None,
            )
            .await
            .map_err(|err| err.message)
        }
        Err(err) => Err(err.message),
    }
}

struct DirectProviderRequestFailure {
    message: String,
    can_retry_without_tools: bool,
}

async fn send_openai_compatible_non_streaming_chat_request(
    client: &reqwest::Client,
    credential: &StoredOpenAiCompatibleCredential,
    messages: &[serde_json::Value],
    mode: DirectToolRequestMode,
) -> Result<DirectChatResponse, DirectProviderRequestFailure> {
    let request_messages = direct_messages_for_tool_capability(messages, mode);
    let mut request_body = json!({
        "model": credential.model.clone(),
        "messages": request_messages,
        "stream": false,
    });
    add_direct_request_tooling(&mut request_body, mode);

    let response = client
        .post(openai_chat_completions_url(&credential.base_url))
        .bearer_auth(&credential.api_key)
        .header("Content-Type", "application/json")
        .body(request_body.to_string())
        .send()
        .await
        .map_err(|err| DirectProviderRequestFailure {
            message: format!("Provider request failed: {}", err),
            can_retry_without_tools: false,
        })?;

    let status = response.status();
    let response_text = response
        .text()
        .await
        .map_err(|err| DirectProviderRequestFailure {
            message: format!("Failed to read provider response: {}", err),
            can_retry_without_tools: false,
        })?;

    if !status.is_success() {
        return Err(DirectProviderRequestFailure {
            message: format!("Provider returned HTTP {}: {}", status, response_text),
            can_retry_without_tools: provider_error_allows_toolless_retry(status, &response_text),
        });
    }

    let response = serde_json::from_str(&response_text).map_err(|err| {
        DirectProviderRequestFailure {
            message: format!("Provider returned invalid JSON: {}", err),
            can_retry_without_tools: false,
        }
    })?;
    Ok(direct_chat_response_from_value(
        response,
        direct_reasoning_history_mode(credential),
    ))
}

async fn send_openai_compatible_streaming_chat_request(
    client: &reqwest::Client,
    credential: &StoredOpenAiCompatibleCredential,
    messages: &[serde_json::Value],
    window: &WebviewWindow,
    tab_id: &str,
    state: &ClaudeProcessState,
    process_key: &str,
    mode: DirectToolRequestMode,
) -> Result<DirectChatResponse, DirectStreamFailure> {
    let request_messages = direct_messages_for_tool_capability(messages, mode);
    let mut request_body = json!({
        "model": credential.model.clone(),
        "messages": request_messages,
        "stream": true,
    });
    add_direct_request_tooling(&mut request_body, mode);

    let mut response = client
        .post(openai_chat_completions_url(&credential.base_url))
        .bearer_auth(&credential.api_key)
        .header("Content-Type", "application/json")
        .body(request_body.to_string())
        .send()
        .await
        .map_err(|err| DirectStreamFailure {
            message: format!("Provider request failed: {}", err),
            can_retry_non_streaming: true,
            can_retry_without_tools: false,
        })?;

    let status = response.status();
    if !status.is_success() {
        let response_text = response.text().await.unwrap_or_default();
        return Err(DirectStreamFailure {
            message: format!("Provider returned HTTP {}: {}", status, response_text),
            can_retry_non_streaming: true,
            can_retry_without_tools: provider_error_allows_toolless_retry(status, &response_text),
        });
    }

    let mut buffer = String::new();
    let mut content = String::new();
    let mut reasoning = String::new();
    let mut tool_calls: HashMap<usize, DirectStreamingToolCall> = HashMap::new();
    let mut usage = json!({ "input_tokens": 0, "output_tokens": 0 });
    let mut streamed_text = false;

    while let Some(chunk) = response.chunk().await.map_err(|err| DirectStreamFailure {
        message: format!("Failed to read provider stream: {}", err),
        can_retry_non_streaming: false,
        can_retry_without_tools: false,
    })? {
        if direct_provider_cancelled(state, process_key).await {
            return Err(DirectStreamFailure {
                message: "Direct provider request cancelled".to_string(),
                can_retry_non_streaming: false,
                can_retry_without_tools: false,
            });
        }
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(pos) = buffer.find('\n') {
            let line = buffer[..pos].trim_end_matches('\r').trim().to_string();
            buffer = buffer[pos + 1..].to_string();
            if line.is_empty() || !line.starts_with("data:") {
                continue;
            }
            let data = line.trim_start_matches("data:").trim();
            if data == "[DONE]" {
                let tool_calls = direct_tool_calls_from_stream(tool_calls);
                let message = direct_message_from_parts(
                    &content,
                    &reasoning,
                    &tool_calls,
                    direct_reasoning_history_mode(credential),
                );
                return Ok(DirectChatResponse {
                    message,
                    content,
                    reasoning,
                    tool_calls,
                    usage,
                    streamed_text,
                });
            }

            let value = serde_json::from_str::<serde_json::Value>(data).map_err(|err| {
                DirectStreamFailure {
                    message: format!("Provider returned invalid stream JSON: {}", err),
                    can_retry_non_streaming: false,
                    can_retry_without_tools: false,
                }
            })?;
            if value.get("usage").is_some() {
                usage = json_usage(&value);
            }
            let Some(delta) = value.pointer("/choices/0/delta") else {
                continue;
            };

            let text_delta = direct_stream_text_delta(delta);
            let reasoning_delta = direct_stream_reasoning_delta(delta);
            if !text_delta.is_empty() {
                content.push_str(&text_delta);
                streamed_text = true;
            }
            if !reasoning_delta.is_empty() {
                reasoning.push_str(&reasoning_delta);
                streamed_text = true;
            }
            emit_direct_streaming_delta(window, tab_id, &text_delta, &reasoning_delta);

            if let Some(calls) = delta.get("tool_calls").and_then(|v| v.as_array()) {
                for (fallback_idx, call) in calls.iter().enumerate() {
                    let idx = call
                        .get("index")
                        .and_then(|v| v.as_u64())
                        .and_then(|v| usize::try_from(v).ok())
                        .unwrap_or(fallback_idx);
                    let entry = tool_calls.entry(idx).or_default();
                    if let Some(id) = call.get("id").and_then(|v| v.as_str()) {
                        if !id.is_empty() {
                            entry.id = Some(id.to_string());
                        }
                    }
                    if let Some(name) = call.pointer("/function/name").and_then(|v| v.as_str()) {
                        entry.name.push_str(name);
                    }
                    if let Some(arguments) =
                        call.pointer("/function/arguments").and_then(|v| v.as_str())
                    {
                        entry.arguments.push_str(arguments);
                    }
                }
            }
            if let Some(function_call) = delta.get("function_call") {
                let entry = tool_calls.entry(0).or_default();
                entry.legacy_function_call = true;
                if entry.id.is_none() {
                    entry.id = Some("function_call_1".to_string());
                }
                if let Some(name) = function_call.get("name").and_then(|v| v.as_str()) {
                    entry.name.push_str(name);
                }
                if let Some(arguments) =
                    function_call.get("arguments").and_then(|v| v.as_str())
                {
                    entry.arguments.push_str(arguments);
                }
            }
        }
    }

    let tool_calls = direct_tool_calls_from_stream(tool_calls);
    let message = direct_message_from_parts(
        &content,
        &reasoning,
        &tool_calls,
        direct_reasoning_history_mode(credential),
    );
    Ok(DirectChatResponse {
        message,
        content,
        reasoning,
        tool_calls,
        usage,
        streamed_text,
    })
}

async fn execute_openai_compatible_provider(
    window: WebviewWindow,
    project_path: String,
    prompt: String,
    tab_id: String,
    session_id: Option<String>,
    credential: StoredOpenAiCompatibleCredential,
) -> Result<(), String> {
    let started = std::time::Instant::now();
    let session_id = session_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let process_key = format!("{}:{}", window.label(), tab_id);
    let project_root = match canonical_project_root(&project_path) {
        Ok(path) => path,
        Err(err) => {
            emit_direct_error(&window, &tab_id, err);
            emit_direct_complete(&window, &tab_id, false);
            return Ok(());
        }
    };

    let init = json!({
        "type": "system",
        "subtype": "init",
        "session_id": session_id,
        "model": credential.model.clone(),
        "cwd": project_path.clone(),
        "tools": ["Read", "Write", "Edit", "MultiEdit", "LS", "Glob", "Grep", "TodoWrite", "ToolSearch", "TaskCreate", "TaskUpdate", "TaskList", "Bash"],
    });
    let state = window.state::<ClaudeProcessState>();
    clear_direct_provider_cancelled(&state, &process_key).await;
    hydrate_direct_task_state(&state, &project_path, &session_id).await;
    emit_and_persist_direct_output(&window, &project_path, &session_id, &tab_id, &init);

    let mut messages = {
        let sessions = state.direct_sessions.lock().await;
        sessions.get(&session_id).cloned().unwrap_or_default()
    };
    if messages.is_empty() {
        messages = load_direct_provider_messages(&project_path, &session_id).unwrap_or_default();
    }

    let mut request_messages = vec![json!({
        "role": "system",
        "content": direct_provider_system_prompt(),
    })];
    request_messages.extend(messages.clone());
    request_messages.push(json!({ "role": "user", "content": prompt.clone() }));
    messages.push(json!({
        "role": "user",
        "content": prompt.clone(),
    }));
    let user_event = json!({
        "type": "user",
        "message": {
            "content": [{ "type": "text", "text": prompt.clone() }],
        },
    });
    if let Err(err) = append_direct_session_event(&project_path, &session_id, &user_event) {
        eprintln!("[direct-provider] failed to persist user event: {}", err);
    }

    let final_content: String;
    let mut final_usage = json!({ "input_tokens": 0, "output_tokens": 0 });
    let mut turns = 0_u64;
    let client = reqwest::Client::new();

    loop {
        turns += 1;
        if turns > 12 {
            let message = "Provider stopped because it used tools too many times without producing a final answer.";
            emit_direct_error(&window, &tab_id, message);
            let result = json!({
                "type": "result",
                "subtype": "error",
                "is_error": true,
                "result": message,
                "duration_ms": started.elapsed().as_millis() as u64,
                "duration_api_ms": started.elapsed().as_millis() as u64,
                "num_turns": turns,
                "usage": final_usage,
            });
            emit_and_persist_direct_output(&window, &project_path, &session_id, &tab_id, &result);
            emit_direct_complete(&window, &tab_id, false);
            return Ok(());
        }

        if direct_provider_cancelled(&state, &process_key).await {
            return Ok(());
        }

        let response = match send_openai_compatible_chat_request(
            &client,
            &credential,
            &request_messages,
            &window,
            &tab_id,
            &state,
            &process_key,
        )
        .await
        {
            Ok(value) => value,
            Err(err) => {
                if direct_provider_cancelled(&state, &process_key).await {
                    return Ok(());
                }
                emit_direct_error(&window, &tab_id, err);
                emit_direct_complete(&window, &tab_id, false);
                return Ok(());
            }
        };

        if direct_provider_cancelled(&state, &process_key).await {
            return Ok(());
        }

        let content = response.content;
        let reasoning = response.reasoning;
        let tool_calls = response.tool_calls;
        let usage = response.usage;
        final_usage = usage.clone();

        let mut content_blocks = Vec::new();
        if !reasoning.trim().is_empty() {
            content_blocks.push(json!({
                "type": "thinking",
                "thinking": reasoning,
            }));
        }
        if !content.trim().is_empty() {
            content_blocks.push(json!({ "type": "text", "text": content.clone() }));
        }
        for tool_call in &tool_calls {
            content_blocks.push(json!({
                "type": "tool_use",
                "id": tool_call.id,
                "name": tool_call.name,
                "input": tool_call.input,
            }));
        }

        if content_blocks.is_empty() {
            let message = "Provider response did not include message content or tool calls";
            emit_direct_error(&window, &tab_id, message);
            emit_direct_complete(&window, &tab_id, false);
            return Ok(());
        }

        let mut assistant_event = json!({
            "type": "assistant",
            "message": {
                "content": content_blocks,
                "usage": usage.clone(),
            },
        });
        if response.streamed_text {
            if let Some(object) = assistant_event.as_object_mut() {
                object.insert("subtype".to_string(), json!("streaming_final"));
            }
        }
        emit_and_persist_direct_output(
            &window,
            &project_path,
            &session_id,
            &tab_id,
            &assistant_event,
        );

        let assistant_message = response.message;
        request_messages.push(assistant_message.clone());
        messages.push(assistant_message);

        if tool_calls.is_empty() {
            final_content = content;
            break;
        }

        let mut tool_result_blocks = Vec::new();
        for tool_call in &tool_calls {
            let output = execute_direct_provider_tool(
                &state,
                &session_id,
                &project_root,
                &tool_call.name,
                &tool_call.input,
            )
            .await;
            if !output.is_error && is_direct_task_mutation_tool(&tool_call.name) {
                persist_direct_task_state(&state, &project_path, &session_id).await;
            }
            tool_result_blocks.push(json!({
                "type": "tool_result",
                "tool_use_id": tool_call.id,
                "content": output.content,
                "is_error": output.is_error,
            }));
            let tool_message = if tool_call.legacy_function_call {
                json!({
                    "role": "function",
                    "name": tool_call.name,
                    "content": output.content,
                })
            } else {
                json!({
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "content": output.content,
                })
            };
            request_messages.push(tool_message.clone());
            messages.push(tool_message);
        }

        let tool_result_event = json!({
            "type": "user",
            "message": {
                "content": tool_result_blocks,
            },
        });
        emit_and_persist_direct_output(
            &window,
            &project_path,
            &session_id,
            &tab_id,
            &tool_result_event,
        );
    }

    {
        let mut sessions = state.direct_sessions.lock().await;
        sessions.insert(session_id.clone(), messages);
    }

    let elapsed_ms = started.elapsed().as_millis() as u64;
    let result = json!({
        "type": "result",
        "subtype": "success",
        "is_error": false,
        "result": final_content,
        "duration_ms": elapsed_ms,
        "duration_api_ms": elapsed_ms,
        "num_turns": turns,
        "usage": final_usage,
    });
    emit_and_persist_direct_output(&window, &project_path, &session_id, &tab_id, &result);
    clear_direct_provider_cancelled(&state, &process_key).await;
    emit_direct_complete(&window, &tab_id, true);

    Ok(())
}

#[tauri::command]
pub async fn execute_claude_code(
    window: WebviewWindow,
    project_path: String,
    prompt: String,
    tab_id: String,
    model: Option<String>,
    effort_level: Option<String>,
) -> Result<(), String> {
    if let Some(credential) = stored_openai_compatible_credential() {
        return execute_openai_compatible_provider(
            window,
            project_path,
            prompt,
            tab_id,
            None,
            credential,
        )
        .await;
    }

    let claude_path = find_claude_binary()?;

    let (mut args, stdin_payload) = with_prompt_transport(Vec::new(), prompt);
    if let Some(m) = model {
        args.push("--model".to_string());
        args.push(m);
    }
    args.extend(common_claude_args());

    let cmd = create_command(&claude_path, args, &project_path, effort_level.as_deref());
    spawn_claude_process(window, cmd, tab_id, stdin_payload).await
}

#[tauri::command]
pub async fn continue_claude_code(
    window: WebviewWindow,
    project_path: String,
    prompt: String,
    tab_id: String,
    model: Option<String>,
    effort_level: Option<String>,
) -> Result<(), String> {
    if let Some(credential) = stored_openai_compatible_credential() {
        return execute_openai_compatible_provider(
            window,
            project_path,
            prompt,
            tab_id,
            None,
            credential,
        )
        .await;
    }

    let claude_path = find_claude_binary()?;

    let (mut args, stdin_payload) = with_prompt_transport(vec!["-c".to_string()], prompt);
    if let Some(m) = model {
        args.push("--model".to_string());
        args.push(m);
    }
    args.extend(common_claude_args());

    let cmd = create_command(&claude_path, args, &project_path, effort_level.as_deref());
    spawn_claude_process(window, cmd, tab_id, stdin_payload).await
}

#[tauri::command]
pub async fn resume_claude_code(
    window: WebviewWindow,
    project_path: String,
    session_id: String,
    prompt: String,
    tab_id: String,
    model: Option<String>,
    effort_level: Option<String>,
) -> Result<(), String> {
    if let Some(credential) = stored_openai_compatible_credential() {
        return execute_openai_compatible_provider(
            window,
            project_path,
            prompt,
            tab_id,
            Some(session_id),
            credential,
        )
        .await;
    }

    let claude_path = find_claude_binary()?;

    let (mut args, stdin_payload) =
        with_prompt_transport(vec!["--resume".to_string(), session_id], prompt);
    if let Some(m) = model {
        args.push("--model".to_string());
        args.push(m);
    }
    args.extend(common_claude_args());

    let cmd = create_command(&claude_path, args, &project_path, effort_level.as_deref());
    spawn_claude_process(window, cmd, tab_id, stdin_payload).await
}

#[tauri::command]
pub async fn cancel_claude_execution(window: WebviewWindow, tab_id: String) -> Result<(), String> {
    let window_label = window.label().to_string();
    let process_key = format!("{}:{}", window_label, tab_id);
    let claude_state = window.state::<ClaudeProcessState>();
    let mut processes = claude_state.processes.lock().await;
    if let Some(mut child) = processes.remove(&process_key) {
        let _ = child.kill().await;
        let _ = window.emit(
            "claude-complete",
            ClaudeCompleteEvent {
                tab_id,
                success: false,
            },
        );
        return Ok(());
    }

    drop(processes);
    claude_state
        .direct_cancellations
        .lock()
        .await
        .insert(process_key);
    let _ = window.emit(
        "claude-complete",
        ClaudeCompleteEvent {
            tab_id,
            success: false,
        },
    );
    Ok(())
}

/// Kill all Claude processes associated with a specific window label.
/// Called when a window is destroyed.
pub async fn kill_process_for_window(state: &ClaudeProcessState, window_label: &str) {
    let mut processes = state.processes.lock().await;
    let prefix = format!("{}:", window_label);
    let keys_to_remove: Vec<String> = processes
        .keys()
        .filter(|k| k.starts_with(&prefix))
        .cloned()
        .collect();
    for key in keys_to_remove {
        if let Some(mut child) = processes.remove(&key) {
            let _ = child.kill().await;
        }
    }
}

// ─── Session Listing ───

#[derive(serde::Serialize)]
pub struct ClaudeSessionInfo {
    pub session_id: String,
    pub title: String,
    pub last_modified: i64,
}

/// Resolve the Claude Code sessions directory for a given project path.
/// Claude Code encodes paths by replacing all non-alphanumeric characters with '-'.
/// e.g. "/Users/dev/my_project" → "-Users-dev-my-project"
fn get_sessions_dir(project_path: &str) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;

    let encoded: String = project_path
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();

    eprintln!(
        "[session] project_path={} encoded={}",
        project_path, encoded
    );

    Ok(home.join(".claude").join("projects").join(&encoded))
}

/// Clean raw user message text into a display title.
fn clean_user_message_title(text: &str) -> Option<String> {
    // Skip IDE context tags
    if text.starts_with("<ide_") || text.starts_with("<system-reminder>") {
        return None;
    }
    // Skip command tags
    if text.starts_with("<command-name>") || text.starts_with("<local-command-stdout>") {
        return None;
    }

    // Strip context prefix like "[Currently open file: ...]\n\n"
    let clean = if let Some(idx) = text.rfind("]\n\n") {
        &text[idx + 3..]
    } else {
        text
    };

    // Skip if still an IDE tag after stripping context
    if clean.starts_with("<ide_") {
        return None;
    }

    let clean = clean.trim();
    if clean.is_empty() {
        return None;
    }

    let title = if clean.chars().count() > 80 {
        let truncated: String = clean.chars().take(77).collect();
        format!("{}...", truncated)
    } else {
        clean.to_string()
    };

    Some(title)
}

/// Extract the first valid user message from a JSONL session file.
/// Handles both string content (stored JSONL) and array content (streaming format).
fn extract_first_user_message(path: &PathBuf) -> (Option<String>, Option<String>) {
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return (None, None),
    };
    let reader = std::io::BufReader::new(file);
    use std::io::BufRead;

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        let msg = match serde_json::from_str::<serde_json::Value>(&line) {
            Ok(m) => m,
            Err(_) => continue,
        };

        if msg.get("type").and_then(|v| v.as_str()) != Some("user") {
            continue;
        }

        let content_val = msg.get("message").and_then(|m| m.get("content"));
        let content_val = match content_val {
            Some(v) => v,
            None => continue,
        };
        let timestamp = msg
            .get("timestamp")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        // Case 1: content is a plain string (Claude Code stored JSONL format)
        if let Some(text) = content_val.as_str() {
            if let Some(title) = clean_user_message_title(text) {
                return (Some(title), timestamp);
            }
            continue;
        }

        // Case 2: content is an array of blocks (streaming format)
        if let Some(blocks) = content_val.as_array() {
            for block in blocks {
                if block["type"] == "text" {
                    if let Some(text) = block["text"].as_str() {
                        if let Some(title) = clean_user_message_title(text) {
                            return (Some(title), timestamp);
                        }
                    }
                }
            }
        }
    }
    (None, None)
}

#[tauri::command]
pub async fn list_claude_sessions(project_path: String) -> Result<Vec<ClaudeSessionInfo>, String> {
    eprintln!(
        "[session] list_claude_sessions called with project_path={}",
        project_path
    );
    let sessions_dir = get_sessions_dir(&project_path)?;
    eprintln!(
        "[session] sessions_dir={:?} exists={}",
        sessions_dir,
        sessions_dir.exists()
    );

    if !sessions_dir.exists() {
        eprintln!("[session] sessions_dir does not exist, returning empty");
        return Ok(Vec::new());
    }

    let mut sessions = Vec::new();
    let entries = std::fs::read_dir(&sessions_dir)
        .map_err(|e| format!("Failed to read sessions directory: {}", e))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }

        let session_id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();

        if session_id.is_empty() {
            continue;
        }

        let metadata = std::fs::metadata(&path).ok();
        let modified = metadata
            .and_then(|m| m.modified().ok())
            .map(|t| {
                t.duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64
            })
            .unwrap_or(0);

        let (first_message, _timestamp) = extract_first_user_message(&path);
        let title = first_message.unwrap_or_else(|| "Untitled session".to_string());

        sessions.push(ClaudeSessionInfo {
            session_id,
            title,
            last_modified: modified,
        });
    }

    sessions.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));

    eprintln!("[session] found {} sessions", sessions.len());
    for s in &sessions {
        eprintln!(
            "[session]   id={} title={} modified={}",
            s.session_id, s.title, s.last_modified
        );
    }

    Ok(sessions)
}

/// Load the full JSONL history for a specific session.
#[tauri::command]
pub async fn load_session_history(
    project_path: String,
    session_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    eprintln!(
        "[session] load_session_history called: session_id={} project_path={}",
        session_id, project_path
    );
    let sessions_dir = get_sessions_dir(&project_path)?;
    let session_path = sessions_dir.join(format!("{}.jsonl", session_id));
    eprintln!(
        "[session] session_path={:?} exists={}",
        session_path,
        session_path.exists()
    );

    if !session_path.exists() {
        return Err(format!("Session file not found: {}", session_id));
    }

    let file = std::fs::File::open(&session_path)
        .map_err(|e| format!("Failed to open session file: {}", e))?;

    let reader = std::io::BufReader::new(file);
    use std::io::BufRead;
    let mut messages = Vec::new();

    for line in reader.lines().map_while(Result::ok) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
            messages.push(json);
        }
    }

    eprintln!(
        "[session] loaded {} messages from session {}",
        messages.len(),
        session_id
    );

    Ok(messages)
}

// ─── Shell Command Execution ───

#[tauri::command]
pub async fn delete_claude_session(project_path: String, session_id: String) -> Result<(), String> {
    if session_id.is_empty()
        || !session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("Invalid session id".to_string());
    }

    let sessions_dir = get_sessions_dir(&project_path)?;
    let session_path = sessions_dir.join(format!("{}.jsonl", session_id));

    if !session_path.exists() {
        return Ok(());
    }

    let canonical_sessions_dir = sessions_dir
        .canonicalize()
        .map_err(|e| format!("Failed to resolve sessions directory: {}", e))?;
    let canonical_session_path = session_path
        .canonicalize()
        .map_err(|e| format!("Failed to resolve session file: {}", e))?;

    if !canonical_session_path.starts_with(&canonical_sessions_dir) {
        return Err("Refusing to delete session outside project history".to_string());
    }

    if canonical_session_path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
        return Err("Refusing to delete non-session file".to_string());
    }

    std::fs::remove_file(&canonical_session_path)
        .map_err(|e| format!("Failed to delete session: {}", e))?;

    Ok(())
}

#[derive(serde::Serialize)]
pub struct ShellCommandResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[tauri::command]
pub async fn run_shell_command(command: String, cwd: String) -> Result<ShellCommandResult, String> {
    #[cfg(not(target_os = "windows"))]
    let (shell, args) = ("sh", vec!["-c".to_string(), command]);
    #[cfg(target_os = "windows")]
    let (shell, args) = ("cmd", vec!["/C".to_string(), command]);
    let mut cmd = create_command(shell, args, &cwd, None);

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn command: {}", e))?;

    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("Failed to wait for command: {}", e))?;

    Ok(ShellCommandResult {
        exit_code: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

// ─── Claude Settings (fast mode, etc.) ───

fn get_claude_settings_path() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    Ok(home.join(".claude").join("settings.json"))
}

#[tauri::command]
pub async fn get_claude_fast_mode() -> Result<bool, String> {
    let path = get_claude_settings_path()?;
    if !path.exists() {
        return Ok(false);
    }
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("Failed to read settings: {}", e))?;
    let settings: serde_json::Value =
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}));
    Ok(settings
        .get("fastMode")
        .and_then(|v| v.as_bool())
        .unwrap_or(false))
}

#[tauri::command]
pub async fn set_claude_fast_mode(enabled: bool) -> Result<(), String> {
    let path = get_claude_settings_path()?;

    // Ensure directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create settings dir: {}", e))?;
    }

    // Read existing settings or create new
    let mut settings: serde_json::Value = if path.exists() {
        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read settings: {}", e))?;
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    // Update fastMode
    if let Some(obj) = settings.as_object_mut() {
        if enabled {
            obj.insert("fastMode".to_string(), serde_json::json!(true));
        } else {
            obj.remove("fastMode");
        }
    }

    // Write back
    let content = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;
    std::fs::write(&path, content).map_err(|e| format!("Failed to write settings: {}", e))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- get_sessions_dir ---

    #[test]
    fn test_get_sessions_dir_encodes_path() {
        let result = get_sessions_dir("/Users/dev/my_project");
        assert!(result.is_ok());
        let path = result.unwrap();
        let dir_name = path.file_name().unwrap().to_str().unwrap();
        // All non-alphanumeric chars should be replaced with '-'
        assert_eq!(dir_name, "-Users-dev-my-project");
    }

    #[test]
    fn test_get_sessions_dir_alphanumeric_only() {
        let result = get_sessions_dir("abc123");
        assert!(result.is_ok());
        let path = result.unwrap();
        let dir_name = path.file_name().unwrap().to_str().unwrap();
        assert_eq!(dir_name, "abc123");
    }

    #[test]
    fn test_get_sessions_dir_special_chars() {
        let result = get_sessions_dir("/a/b c/d@e");
        assert!(result.is_ok());
        let path = result.unwrap();
        let dir_name = path.file_name().unwrap().to_str().unwrap();
        assert_eq!(dir_name, "-a-b-c-d-e");
    }

    // --- clean_user_message_title ---

    #[test]
    fn test_clean_user_message_title_simple() {
        let result = clean_user_message_title("Hello Claude");
        assert_eq!(result, Some("Hello Claude".to_string()));
    }

    #[test]
    fn test_clean_user_message_title_skips_ide_tags() {
        assert_eq!(clean_user_message_title("<ide_something>data"), None);
        assert_eq!(clean_user_message_title("<system-reminder>stuff"), None);
    }

    #[test]
    fn test_clean_user_message_title_skips_command_tags() {
        assert_eq!(clean_user_message_title("<command-name>test"), None);
        assert_eq!(
            clean_user_message_title("<local-command-stdout>output"),
            None
        );
    }

    #[test]
    fn test_clean_user_message_title_strips_context_prefix() {
        let text = "[Currently open file: main.tex]\n\nFix the bibliography";
        let result = clean_user_message_title(text);
        assert_eq!(result, Some("Fix the bibliography".to_string()));
    }

    #[test]
    fn test_clean_user_message_title_truncates_at_80() {
        let long_text = "a".repeat(100);
        let result = clean_user_message_title(&long_text).unwrap();
        assert_eq!(result.len(), 80); // 77 chars + "..."
        assert!(result.ends_with("..."));
    }

    #[test]
    fn test_clean_user_message_title_empty() {
        assert_eq!(clean_user_message_title(""), None);
        assert_eq!(clean_user_message_title("   "), None);
    }

    #[test]
    fn test_clean_user_message_title_exactly_80_chars() {
        let text = "a".repeat(80);
        let result = clean_user_message_title(&text).unwrap();
        assert_eq!(result, text); // No truncation needed
    }

    // --- common_claude_args ---

    #[test]
    fn test_common_claude_args_has_required_flags() {
        let args = common_claude_args();
        assert!(args.contains(&"--output-format".to_string()));
        assert!(args.contains(&"stream-json".to_string()));
        assert!(args.contains(&"--verbose".to_string()));
        assert!(args.contains(&"--dangerously-skip-permissions".to_string()));
        assert!(args.contains(&"--append-system-prompt".to_string()));
    }

    #[test]
    fn test_common_claude_args_system_prompt_mentions_latex() {
        let args = common_claude_args();
        let prompt_idx = args
            .iter()
            .position(|a| a == "--append-system-prompt")
            .unwrap();
        let prompt = &args[prompt_idx + 1];
        assert!(prompt.contains("LaTeX"));
    }

    #[test]
    fn test_with_prompt_transport_always_includes_print_flag() {
        let (args, stdin_payload) =
            with_prompt_transport(vec!["--resume".to_string(), "abc".to_string()], "hello 文件".into());
        assert!(args.contains(&"-p".to_string()));
        #[cfg(target_os = "windows")]
        {
            assert_eq!(stdin_payload.as_deref(), Some("hello 文件"));
            assert!(!args.contains(&"hello 文件".to_string()));
        }
        #[cfg(not(target_os = "windows"))]
        {
            assert_eq!(stdin_payload, None);
            assert_eq!(args.last().map(String::as_str), Some("hello 文件"));
        }
    }

    #[test]
    fn test_openai_chat_completions_url_preserves_full_endpoint() {
        assert_eq!(
            openai_chat_completions_url("https://open.bigmodel.cn/api/paas/v4/chat/completions"),
            "https://open.bigmodel.cn/api/paas/v4/chat/completions"
        );
    }

    #[test]
    fn test_openai_chat_completions_url_supports_common_provider_roots() {
        assert_eq!(
            openai_chat_completions_url("https://dashscope.aliyuncs.com/compatible-mode/v1"),
            "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
        );
        assert_eq!(
            openai_chat_completions_url("https://generativelanguage.googleapis.com/v1beta/openai/"),
            "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
        );
        assert_eq!(
            openai_chat_completions_url("https://open.bigmodel.cn/api/paas/v4"),
            "https://open.bigmodel.cn/api/paas/v4/chat/completions"
        );
        assert_eq!(
            openai_chat_completions_url("https://api.deepseek.com"),
            "https://api.deepseek.com/chat/completions"
        );
    }

    #[test]
    fn test_openai_chat_completions_url_keeps_generic_openai_default() {
        assert_eq!(
            openai_chat_completions_url("https://api.openai.com"),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            openai_chat_completions_url("https://openrouter.ai/api/v1"),
            "https://openrouter.ai/api/v1/chat/completions"
        );
    }

    // --- create_command ---

    #[test]
    fn test_create_command_sets_args_and_cwd() {
        let args = vec!["--version".to_string()];
        let cmd = create_command("/usr/bin/claude", args, "/tmp/project", None);
        // Command is created — we can verify via its Debug representation
        let debug_str = format!("{:?}", cmd);
        assert!(debug_str.contains("--version"));
    }

    #[test]
    fn test_create_command_default_effort_level() {
        let cmd = create_command("/usr/bin/claude", vec![], "/tmp", None);
        let debug_str = format!("{:?}", cmd);
        // The env setup is internal; just verify the command is created
        assert!(debug_str.contains("claude"));
    }

    #[test]
    fn test_create_command_custom_effort_level() {
        let cmd = create_command("/usr/bin/claude", vec![], "/tmp", Some("high"));
        let debug_str = format!("{:?}", cmd);
        assert!(debug_str.contains("claude"));
    }

    // --- clean_user_message_title edge cases ---

    #[test]
    fn test_clean_user_message_title_context_with_nested_brackets() {
        let text = "[File: main.tex]\n[Selection: @main.tex:1:1-5:10]\n\nWrite an abstract";
        let result = clean_user_message_title(text);
        assert_eq!(result, Some("Write an abstract".to_string()));
    }

    #[test]
    fn test_clean_user_message_title_only_context_no_body() {
        // After stripping context prefix, if it becomes an IDE tag, returns None
        let text = "[context info]\n\n<ide_something>hidden";
        let result = clean_user_message_title(text);
        assert_eq!(result, None);
    }

    #[test]
    fn test_clean_user_message_title_only_whitespace_after_strip() {
        let text = "[context]\n\n   ";
        let result = clean_user_message_title(text);
        assert_eq!(result, None);
    }

    #[test]
    fn test_clean_user_message_title_multibyte_truncation() {
        // Truncation counts chars, not bytes
        let text = "あ".repeat(100); // 100 Japanese chars
        let result = clean_user_message_title(&text).unwrap();
        assert!(result.ends_with("..."));
        // 77 chars + "..." = 80 display chars
        assert_eq!(result.chars().count(), 80);
    }

    // --- get_sessions_dir edge cases ---

    #[test]
    fn test_get_sessions_dir_windows_path_style() {
        let result = get_sessions_dir("C:\\Users\\dev\\project").unwrap();
        let dir_name = result.file_name().unwrap().to_str().unwrap();
        assert_eq!(dir_name, "C--Users-dev-project");
    }

    #[test]
    fn test_get_sessions_dir_dots_and_underscores() {
        let result = get_sessions_dir("/home/user/.my_project.v2").unwrap();
        let dir_name = result.file_name().unwrap().to_str().unwrap();
        // dots and underscores are non-alphanumeric → replaced with '-'
        assert_eq!(dir_name, "-home-user--my-project-v2");
    }

    // --- extract_first_user_message integration tests ---

    #[test]
    fn test_extract_first_user_message_string_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let line = r#"{"type":"user","timestamp":"2024-01-01T00:00:00Z","message":{"content":"Fix the bibliography"}}"#;
        std::fs::write(&path, line).unwrap();

        let pb = PathBuf::from(&path);
        let (title, ts) = extract_first_user_message(&pb);
        assert_eq!(title.unwrap(), "Fix the bibliography");
        assert_eq!(ts.unwrap(), "2024-01-01T00:00:00Z");
    }

    #[test]
    fn test_extract_first_user_message_block_array_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let line = r#"{"type":"user","timestamp":"2024-02-01T00:00:00Z","message":{"content":[{"type":"text","text":"Rewrite the abstract"}]}}"#;
        std::fs::write(&path, line).unwrap();

        let pb = PathBuf::from(&path);
        let (title, ts) = extract_first_user_message(&pb);
        assert_eq!(title.unwrap(), "Rewrite the abstract");
        assert_eq!(ts.unwrap(), "2024-02-01T00:00:00Z");
    }

    #[test]
    fn test_extract_first_user_message_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.jsonl");
        std::fs::write(&path, "").unwrap();

        let pb = PathBuf::from(&path);
        let (title, ts) = extract_first_user_message(&pb);
        assert!(title.is_none());
        assert!(ts.is_none());
    }

    #[test]
    fn test_extract_first_user_message_no_user_messages() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let lines = r#"{"type":"system","subtype":"init","session_id":"abc"}
{"type":"assistant","message":{"content":"Hello"}}"#;
        std::fs::write(&path, lines).unwrap();

        let pb = PathBuf::from(&path);
        let (title, ts) = extract_first_user_message(&pb);
        assert!(title.is_none());
        assert!(ts.is_none());
    }

    #[test]
    fn test_extract_first_user_message_nonexistent_path() {
        let pb = PathBuf::from("/tmp/nonexistent_session_file_12345.jsonl");
        let (title, ts) = extract_first_user_message(&pb);
        assert!(title.is_none());
        assert!(ts.is_none());
    }

    #[test]
    fn test_extract_first_user_message_skips_ide_tags() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        // First user message is an IDE tag (should skip), second is real
        let lines = r#"{"type":"user","timestamp":"2024-01-01T00:00:00Z","message":{"content":"<ide_context>data"}}
{"type":"user","timestamp":"2024-01-02T00:00:00Z","message":{"content":"Add a new section"}}"#;
        std::fs::write(&path, lines).unwrap();

        let pb = PathBuf::from(&path);
        let (title, ts) = extract_first_user_message(&pb);
        assert_eq!(title.unwrap(), "Add a new section");
        assert_eq!(ts.unwrap(), "2024-01-02T00:00:00Z");
    }

    // --- direct provider tools ---

    async fn execute_test_direct_provider_tool(
        project_root: &Path,
        name: &str,
        input: &serde_json::Value,
    ) -> DirectToolOutput {
        let state = ClaudeProcessState::default();
        execute_direct_provider_tool(&state, "test-session", project_root, name, input).await
    }

    #[tokio::test]
    async fn test_direct_provider_tools_read_edit_and_grep_project_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical_project_root(dir.path().to_str().unwrap()).unwrap();
        let main = root.join("main.tex");
        std::fs::write(&main, "\\section{Old Title}\nBody text").unwrap();

        let read = execute_test_direct_provider_tool(
            &root,
            "Read",
            &json!({ "file_path": "main.tex", "limit": 1 }),
        )
        .await;
        assert!(!read.is_error);
        assert!(read.content.contains("\\section{Old Title}"));

        let edit = execute_test_direct_provider_tool(
            &root,
            "Edit",
            &json!({
                "file_path": "main.tex",
                "old_string": "Old Title",
                "new_string": "New Title",
            }),
        )
        .await;
        assert!(!edit.is_error);
        assert!(std::fs::read_to_string(&main).unwrap().contains("New Title"));

        let grep = execute_test_direct_provider_tool(
            &root,
            "Grep",
            &json!({ "pattern": "New Title", "glob": "*.tex" }),
        )
        .await;
        assert!(!grep.is_error);
        assert!(grep.content.contains("main.tex:1"));
    }

    #[tokio::test]
    async fn test_direct_provider_read_pdf_uses_text_sidecar() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical_project_root(dir.path().to_str().unwrap()).unwrap();
        std::fs::create_dir_all(root.join("attachments")).unwrap();
        std::fs::write(root.join("attachments").join("paper.pdf"), b"%PDF-1.7\n").unwrap();
        std::fs::write(
            root.join("attachments").join("paper.pdf.txt"),
            "# Extracted PDF Text: attachments/paper.pdf\n\n## Page 1\n\nFlashVID summary",
        )
        .unwrap();

        let read = execute_test_direct_provider_tool(
            &root,
            "Read",
            &json!({ "file_path": "attachments/paper.pdf" }),
        )
        .await;

        assert!(!read.is_error);
        assert!(read.content.contains("PDF text sidecar"));
        assert!(read.content.contains("attachments/paper.pdf.txt"));
        assert!(read.content.contains("FlashVID summary"));
    }

    #[tokio::test]
    async fn test_direct_provider_read_pdf_without_sidecar_guides_model() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical_project_root(dir.path().to_str().unwrap()).unwrap();
        std::fs::create_dir_all(root.join("attachments")).unwrap();
        std::fs::write(root.join("attachments").join("paper.pdf"), b"%PDF-1.7\n").unwrap();

        let read = execute_test_direct_provider_tool(
            &root,
            "Read",
            &json!({ "file_path": "attachments/paper.pdf" }),
        )
        .await;

        assert!(!read.is_error);
        assert!(read.content.contains("PDF files are binary"));
        assert!(read.content.contains("attachments/paper.pdf.txt"));
        assert!(read.content.contains("generate the sidecar"));
    }

    #[tokio::test]
    async fn test_direct_provider_tools_reject_paths_outside_project() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical_project_root(dir.path().to_str().unwrap()).unwrap();

        let write = execute_test_direct_provider_tool(
            &root,
            "Write",
            &json!({ "file_path": "../outside.tex", "content": "nope" }),
        )
        .await;
        assert!(write.is_error);
        assert!(write.content.contains("outside the project"));
    }

    #[tokio::test]
    async fn test_direct_provider_glob_lists_matching_project_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical_project_root(dir.path().to_str().unwrap()).unwrap();
        std::fs::create_dir_all(root.join("chapters")).unwrap();
        std::fs::write(root.join("main.tex"), "main").unwrap();
        std::fs::write(root.join("chapters").join("intro.tex"), "intro").unwrap();
        std::fs::write(root.join("notes.md"), "notes").unwrap();

        let glob = execute_test_direct_provider_tool(&root, "Glob", &json!({ "pattern": "*.tex" }))
            .await;
        assert!(!glob.is_error);
        assert!(glob.content.contains("main.tex"));
        assert!(glob.content.contains("chapters/intro.tex"));
        assert!(!glob.content.contains("notes.md"));
    }

    #[tokio::test]
    async fn test_direct_provider_ls_lists_project_directory() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical_project_root(dir.path().to_str().unwrap()).unwrap();
        std::fs::create_dir_all(root.join("chapters")).unwrap();
        std::fs::write(root.join("main.tex"), "main").unwrap();
        std::fs::write(root.join("chapters").join("intro.tex"), "intro").unwrap();

        let ls = execute_test_direct_provider_tool(&root, "LS", &json!({})).await;
        assert!(!ls.is_error);
        assert!(ls.content.contains("chapters/"));
        assert!(ls.content.contains("main.tex"));

        let nested = execute_test_direct_provider_tool(&root, "LS", &json!({ "path": "chapters" }))
            .await;
        assert!(!nested.is_error);
        assert!(nested.content.contains("chapters/intro.tex"));
    }

    #[tokio::test]
    async fn test_direct_provider_todowrite_tracks_plan_items() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical_project_root(dir.path().to_str().unwrap()).unwrap();

        let todos = execute_test_direct_provider_tool(
            &root,
            "TodoWrite",
            &json!({
                "todos": [
                    { "content": "Inspect project", "status": "completed" },
                    { "content": "Edit main.tex", "status": "in_progress" },
                    { "content": "Verify build", "status": "pending" }
                ]
            }),
        )
        .await;
        assert!(!todos.is_error);
        assert!(todos.content.contains("Todo list updated (3 items)"));
        assert!(todos.content.contains("[in_progress] Edit main.tex"));

        let invalid = execute_test_direct_provider_tool(
            &root,
            "TodoWrite",
            &json!({ "todos": [{ "content": "Oops", "status": "blocked" }] }),
        )
        .await;
        assert!(invalid.is_error);
        assert!(invalid.content.contains("status must be pending"));
    }

    #[tokio::test]
    async fn test_direct_provider_toolsearch_selects_compat_tools() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical_project_root(dir.path().to_str().unwrap()).unwrap();

        let result = execute_test_direct_provider_tool(
            &root,
            "ToolSearch",
            &json!({ "query": "select:TaskCreate,TaskUpdate,TaskList" }),
        )
        .await;

        assert!(!result.is_error);
        assert!(result.content.contains("TaskCreate"));
        assert!(result.content.contains("TaskUpdate"));
        assert!(result.content.contains("TaskList"));
        assert!(result.content.contains("already available"));
    }

    #[tokio::test]
    async fn test_direct_provider_task_tools_track_lightweight_tasks() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical_project_root(dir.path().to_str().unwrap()).unwrap();
        let state = ClaudeProcessState::default();

        let created = execute_direct_provider_tool(
            &state,
            "session-a",
            &root,
            "TaskCreate",
            &json!({
                "subject": "Inspect paper draft",
                "description": "Read main.tex and identify missing citations",
                "activeForm": "Inspecting paper draft"
            }),
        )
        .await;
        assert!(!created.is_error);
        assert!(created.content.contains("task-1"));

        let listed = execute_direct_provider_tool(&state, "session-a", &root, "TaskList", &json!({}))
            .await;
        assert!(!listed.is_error);
        assert!(listed.content.contains("Inspect paper draft"));
        assert!(listed.content.contains("[pending]"));

        let updated = execute_direct_provider_tool(
            &state,
            "session-a",
            &root,
            "TaskUpdate",
            &json!({ "taskId": "task-1", "status": "completed" }),
        )
        .await;
        assert!(!updated.is_error);
        assert!(updated.content.contains("Task completed"));

        let completed = execute_direct_provider_tool(
            &state,
            "session-a",
            &root,
            "TaskList",
            &json!({ "status": "completed" }),
        )
        .await;
        assert!(!completed.is_error);
        assert!(completed.content.contains("[completed]"));
    }

    #[test]
    fn test_direct_task_state_loads_latest_jsonl_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let first = direct_task_state_event(&[DirectTask {
            id: "task-1".to_string(),
            subject: "First".to_string(),
            description: "Old state".to_string(),
            active_form: None,
            status: "pending".to_string(),
            owner: None,
        }]);
        let latest = direct_task_state_event(&[DirectTask {
            id: "task-1".to_string(),
            subject: "First".to_string(),
            description: "Latest state".to_string(),
            active_form: Some("Checking latest state".to_string()),
            status: "completed".to_string(),
            owner: Some("assistant".to_string()),
        }]);
        let content = [
            serde_json::to_string(&json!({ "type": "user", "message": { "content": "hi" } }))
                .unwrap(),
            serde_json::to_string(&first).unwrap(),
            "not json".to_string(),
            serde_json::to_string(&latest).unwrap(),
        ]
        .join("\n");
        std::fs::write(&path, content).unwrap();

        let tasks = load_direct_task_state_from_path(&path).unwrap();

        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].description, "Latest state");
        assert_eq!(tasks[0].status, "completed");
        assert_eq!(tasks[0].owner.as_deref(), Some("assistant"));
    }

    #[tokio::test]
    async fn test_restored_direct_task_state_is_visible_to_tasklist() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical_project_root(dir.path().to_str().unwrap()).unwrap();
        let state = ClaudeProcessState::default();

        {
            let mut task_lists = state.direct_task_lists.lock().await;
            task_lists.insert(
                "session-a".to_string(),
                vec![DirectTask {
                    id: "task-1".to_string(),
                    subject: "Resume task".to_string(),
                    description: "Loaded from prior session state".to_string(),
                    active_form: None,
                    status: "in_progress".to_string(),
                    owner: None,
                }],
            );
        }

        let listed = execute_direct_provider_tool(&state, "session-a", &root, "TaskList", &json!({}))
            .await;

        assert!(!listed.is_error);
        assert!(listed.content.contains("Resume task"));
        assert!(listed.content.contains("[in_progress]"));
    }

    #[test]
    fn test_direct_provider_parses_tool_arguments_string_and_object() {
        let response = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [
                        {
                            "id": "call-1",
                            "type": "function",
                            "function": {
                                "name": "Read",
                                "arguments": "{\"file_path\":\"main.tex\"}"
                            }
                        },
                        {
                            "id": "call-2",
                            "type": "function",
                            "function": {
                                "name": "Grep",
                                "arguments": { "pattern": "Intro", "glob": "*.tex" }
                            }
                        }
                    ]
                }
            }]
        });

        let calls = parse_direct_tool_calls(&response);
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].input["file_path"], "main.tex");
        assert_eq!(calls[1].input["pattern"], "Intro");
    }

    #[test]
    fn test_direct_provider_parses_legacy_function_call() {
        let response = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": null,
                    "function_call": {
                        "name": "Read",
                        "arguments": "{\"file_path\":\"main.tex\"}"
                    }
                }
            }]
        });

        let calls = parse_direct_tool_calls(&response);

        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "function_call_1");
        assert_eq!(calls[0].name, "Read");
        assert_eq!(calls[0].input["file_path"], "main.tex");
        assert!(calls[0].legacy_function_call);
    }

    #[test]
    fn test_direct_provider_reconstructs_streamed_tool_calls() {
        let mut calls = HashMap::new();
        calls.insert(
            0,
            DirectStreamingToolCall {
                id: Some("call-1".to_string()),
                name: "Read".to_string(),
                arguments: "{\"file_path\":\"main.tex\"}".to_string(),
                legacy_function_call: false,
            },
        );

        let calls = direct_tool_calls_from_stream(calls);
        let message = direct_message_from_parts(
            "Checking the file",
            "Thinking aloud",
            &calls,
            DirectReasoningHistoryMode::Strip,
        );

        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "Read");
        assert_eq!(calls[0].input["file_path"], "main.tex");
        assert_eq!(message["content"], "Checking the file");
        assert!(message.get("reasoning_content").is_none());
        assert_eq!(message["tool_calls"][0]["function"]["name"], "Read");
    }

    #[test]
    fn test_direct_provider_reconstructs_streamed_legacy_function_call() {
        let mut calls = HashMap::new();
        calls.insert(
            0,
            DirectStreamingToolCall {
                id: Some("function_call_1".to_string()),
                name: "Read".to_string(),
                arguments: "{\"file_path\":\"main.tex\"}".to_string(),
                legacy_function_call: true,
            },
        );

        let calls = direct_tool_calls_from_stream(calls);
        let message =
            direct_message_from_parts("", "", &calls, DirectReasoningHistoryMode::Strip);

        assert_eq!(calls.len(), 1);
        assert!(calls[0].legacy_function_call);
        assert!(message.get("tool_calls").is_none());
        assert_eq!(message["function_call"]["name"], "Read");
        assert_eq!(
            message["function_call"]["arguments"],
            "{\"file_path\":\"main.tex\"}"
        );
    }

    #[test]
    fn test_direct_provider_extracts_reasoning_content() {
        let response = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "reasoning_content": "First reason about structure.",
                    "content": "Then answer."
                }
            }]
        });

        assert_eq!(
            direct_assistant_reasoning(&response),
            "First reason about structure."
        );
        assert_eq!(direct_assistant_content(&response), "Then answer.");
    }

    #[test]
    fn test_direct_provider_strips_reasoning_from_request_history() {
        let response = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "reasoning_content": "Hidden chain.",
                    "reasoning": "Alternate hidden chain.",
                    "content": "Visible answer."
                }
            }]
        });

        let parsed = direct_chat_response_from_value(response, DirectReasoningHistoryMode::Strip);

        assert_eq!(parsed.reasoning, "Hidden chain.");
        assert_eq!(parsed.message["content"], "Visible answer.");
        assert!(parsed.message.get("reasoning_content").is_none());
        assert!(parsed.message.get("reasoning").is_none());
    }

    #[test]
    fn test_direct_provider_preserves_deepseek_tool_reasoning_in_history() {
        let response = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "reasoning_content": "Need to inspect the source file first.",
                    "content": "",
                    "tool_calls": [{
                        "id": "call-1",
                        "type": "function",
                        "function": {
                            "name": "Read",
                            "arguments": "{\"file_path\":\"main.tex\"}"
                        }
                    }]
                }
            }]
        });

        let parsed = direct_chat_response_from_value(
            response,
            DirectReasoningHistoryMode::Preserve,
        );

        assert_eq!(parsed.reasoning, "Need to inspect the source file first.");
        assert_eq!(
            parsed.message["reasoning_content"],
            "Need to inspect the source file first."
        );
        assert_eq!(parsed.message["tool_calls"][0]["function"]["name"], "Read");
    }

    #[test]
    fn test_direct_provider_stream_preserves_deepseek_tool_reasoning_in_history() {
        let mut calls = HashMap::new();
        calls.insert(
            0,
            DirectStreamingToolCall {
                id: Some("call-1".to_string()),
                name: "Read".to_string(),
                arguments: "{\"file_path\":\"main.tex\"}".to_string(),
                legacy_function_call: false,
            },
        );

        let calls = direct_tool_calls_from_stream(calls);
        let message = direct_message_from_parts(
            "",
            "Need to inspect the source file first.",
            &calls,
            DirectReasoningHistoryMode::Preserve,
        );

        assert_eq!(
            message["reasoning_content"],
            "Need to inspect the source file first."
        );
        assert_eq!(message["tool_calls"][0]["function"]["name"], "Read");
    }

    #[test]
    fn test_direct_provider_preserves_deepseek_final_reasoning_in_history() {
        let response = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "reasoning_content": "Now synthesize the inspected file.",
                    "content": "Here is the final answer."
                }
            }]
        });

        let parsed = direct_chat_response_from_value(response, DirectReasoningHistoryMode::Preserve);

        assert_eq!(parsed.reasoning, "Now synthesize the inspected file.");
        assert_eq!(
            parsed.message["reasoning_content"],
            "Now synthesize the inspected file."
        );
        assert_eq!(parsed.message["content"], "Here is the final answer.");
    }

    #[test]
    fn test_direct_provider_extracts_stream_reasoning_delta() {
        let delta = json!({
            "reasoning_content": "Step one.",
            "content": "Answer part."
        });

        assert_eq!(direct_stream_reasoning_delta(&delta), "Step one.");
        assert_eq!(direct_stream_text_delta(&delta), "Answer part.");
    }

    #[test]
    fn test_direct_provider_detects_tool_unsupported_errors() {
        assert!(provider_error_allows_toolless_retry(
            reqwest::StatusCode::BAD_REQUEST,
            "unknown parameter: tools"
        ));
        assert!(provider_error_allows_toolless_retry(
            reqwest::StatusCode::UNPROCESSABLE_ENTITY,
            "tool_choice is not supported"
        ));
        assert!(!provider_error_allows_toolless_retry(
            reqwest::StatusCode::UNAUTHORIZED,
            "invalid api key"
        ));
    }

    #[test]
    fn test_direct_provider_selects_reasoning_history_mode_by_provider() {
        let deepseek = StoredOpenAiCompatibleCredential {
            api_key: "sk-test".to_string(),
            base_url: "https://api.deepseek.com".to_string(),
            model: "deepseek-v4-pro".to_string(),
        };
        let qwen = StoredOpenAiCompatibleCredential {
            api_key: "sk-test".to_string(),
            base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1".to_string(),
            model: "qwen3-coder-plus".to_string(),
        };

        assert!(
            direct_reasoning_history_mode(&deepseek) == DirectReasoningHistoryMode::Preserve
        );
        assert!(direct_reasoning_history_mode(&qwen) == DirectReasoningHistoryMode::Strip);
    }

    #[test]
    fn test_direct_provider_no_tools_prompt_replaces_system_message() {
        let messages = vec![
            json!({ "role": "system", "content": direct_provider_system_prompt() }),
            json!({ "role": "user", "content": "Please edit main.tex" }),
        ];

        let no_tools = direct_messages_for_tool_capability(&messages, DirectToolRequestMode::None);
        let content = no_tools[0]["content"].as_str().unwrap();

        assert!(content.contains("does not support tool calls"));
        assert!(!content.contains("You can inspect and edit files through the provided tools"));
        assert_eq!(no_tools[1]["content"], "Please edit main.tex");
    }

    #[test]
    fn test_direct_provider_no_tools_sanitizes_tool_history() {
        let messages = vec![
            json!({ "role": "system", "content": direct_provider_system_prompt() }),
            json!({
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": "call-1",
                    "type": "function",
                    "function": { "name": "Read", "arguments": "{\"file_path\":\"main.tex\"}" }
                }]
            }),
            json!({ "role": "tool", "tool_call_id": "call-1", "content": "main.tex contents" }),
        ];

        let no_tools = direct_messages_for_tool_capability(&messages, DirectToolRequestMode::None);

        assert!(no_tools[1].get("tool_calls").is_none());
        assert_eq!(no_tools[1]["role"], "assistant");
        assert_eq!(no_tools[2]["role"], "user");
        assert!(no_tools[2]["content"]
            .as_str()
            .unwrap()
            .contains("Previous tool result call-1"));
    }

    #[test]
    fn test_direct_provider_legacy_function_messages_convert_tool_history() {
        let messages = vec![
            json!({ "role": "system", "content": direct_provider_system_prompt() }),
            json!({
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": "call-1",
                    "type": "function",
                    "function": { "name": "Read", "arguments": "{\"file_path\":\"main.tex\"}" }
                }]
            }),
            json!({ "role": "tool", "tool_call_id": "call-1", "content": "main.tex contents" }),
        ];

        let function_messages =
            direct_messages_for_tool_capability(&messages, DirectToolRequestMode::Functions);

        assert!(function_messages[1].get("tool_calls").is_none());
        assert_eq!(function_messages[1]["function_call"]["name"], "Read");
        assert_eq!(function_messages[2]["role"], "function");
        assert_eq!(function_messages[2]["name"], "Read");
        assert_eq!(function_messages[2]["content"], "main.tex contents");
    }

    // --- claude_required_dirs ---

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn test_claude_required_dirs_has_all_paths() {
        let home = PathBuf::from("/Users/test");
        let dirs = claude_required_dirs(&home);
        assert_eq!(dirs.len(), 4);
        assert!(dirs.contains(&home.join(".local").join("bin")));
        assert!(dirs.contains(&home.join(".local").join("share").join("claude")));
        assert!(dirs.contains(&home.join(".local").join("state").join("claude")));
        assert!(dirs.contains(&home.join(".claude")));
    }

    #[test]
    fn test_unix_claude_candidate_paths_include_pnpm_locations() {
        let home = PathBuf::from("/Users/test");
        let paths = unix_claude_candidate_paths(
            &home,
            Some(std::ffi::OsString::from("/custom/pnpm")),
        );
        assert!(paths.contains(&PathBuf::from("/custom/pnpm").join("claude")));
        assert!(paths.contains(&home.join("Library").join("pnpm").join("claude")));
        assert!(paths.contains(&home.join(".local").join("share").join("pnpm").join("claude")));
        assert!(paths.contains(&home.join(".pnpm").join("claude")));
        assert!(paths.contains(&home.join(".claude").join("local").join("claude")));
    }

    #[test]
    fn test_unix_claude_path_from_bin_dir_appends_claude() {
        assert_eq!(
            unix_claude_path_from_bin_dir("/custom/bin"),
            PathBuf::from("/custom/bin").join("claude")
        );
    }

    #[test]
    fn test_unix_claude_path_from_npm_prefix_appends_bin_claude() {
        assert_eq!(
            unix_claude_path_from_npm_prefix("/custom/prefix"),
            PathBuf::from("/custom/prefix").join("bin").join("claude")
        );
    }

    #[test]
    fn test_unix_known_pnpm_claude_paths_include_known_layouts() {
        let home = PathBuf::from("/Users/test");
        let paths = unix_known_pnpm_claude_paths(&home);
        assert!(paths.contains(&home.join("Library").join("pnpm").join("claude")));
        assert!(paths.contains(
            &home
                .join("Library")
                .join("pnpm")
                .join("global")
                .join("bin")
                .join("claude")
        ));
        assert!(paths.contains(&home.join(".local").join("share").join("pnpm").join("claude")));
        assert!(paths.contains(
            &home
                .join(".local")
                .join("share")
                .join("pnpm")
                .join("global")
                .join("bin")
                .join("claude")
        ));
        assert!(paths.contains(&home.join(".pnpm").join("claude")));
        assert!(paths.contains(
            &home.join(".pnpm").join("global").join("bin").join("claude")
        ));
    }

    #[test]
    fn test_unix_extra_tool_dirs_include_pnpm_dirs() {
        let home = PathBuf::from("/Users/test");
        let dirs = unix_extra_tool_dirs(&home, Some(std::ffi::OsString::from("/custom/pnpm")));
        assert_eq!(dirs.first(), Some(&PathBuf::from("/custom/pnpm")));
        assert!(dirs.contains(&home.join("Library").join("pnpm")));
        assert!(dirs.contains(&home.join("Library").join("pnpm").join("global").join("bin")));
        assert!(dirs.contains(&home.join(".local").join("share").join("pnpm")));
        assert!(dirs.contains(
            &home
                .join(".local")
                .join("share")
                .join("pnpm")
                .join("global")
                .join("bin")
        ));
        assert!(dirs.contains(&home.join(".pnpm")));
        assert!(dirs.contains(&home.join(".pnpm").join("global").join("bin")));
    }

    // --- try_create_dirs ---

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn test_try_create_dirs_succeeds_in_temp() {
        let tmp = tempfile::tempdir().unwrap();
        let dirs = vec![tmp.path().join("a").join("b"), tmp.path().join("c")];
        assert!(try_create_dirs(&dirs));
        assert!(dirs[0].exists());
        assert!(dirs[1].exists());
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn test_try_create_dirs_fails_for_invalid_path() {
        let dirs = vec![PathBuf::from("/nonexistent_root_path/test/dir")];
        assert!(!try_create_dirs(&dirs));
    }

    // --- verify_dirs_writable ---

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn test_verify_dirs_writable_success() {
        let tmp = tempfile::tempdir().unwrap();
        let dirs = vec![tmp.path().to_path_buf()];
        assert!(verify_dirs_writable(&dirs).is_ok());
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn test_verify_dirs_writable_nonexistent() {
        let dirs = vec![PathBuf::from("/tmp/nonexistent_dir_prism_test_12345")];
        let result = verify_dirs_writable(&dirs);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("does not exist"));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn test_verify_dirs_writable_cleans_up_test_file() {
        let tmp = tempfile::tempdir().unwrap();
        let dirs = vec![tmp.path().to_path_buf()];
        verify_dirs_writable(&dirs).unwrap();
        // The .prism_write_test file should be cleaned up
        assert!(!tmp.path().join(".prism_write_test").exists());
    }

    // --- build_elevation_script ---

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn test_build_elevation_script_format() {
        let dirs = vec![
            PathBuf::from("/Users/test/.local/bin"),
            PathBuf::from("/Users/test/.claude"),
        ];
        let script = build_elevation_script(
            &dirs,
            "testuser",
            std::path::Path::new("/Users/test/.local"),
        );
        assert!(script.contains("mkdir -p"));
        assert!(script.contains("'/Users/test/.local/bin'"));
        assert!(script.contains("'/Users/test/.claude'"));
        assert!(script.contains("chown -R testuser"));
        assert!(script.contains("'/Users/test/.local'"));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn test_build_elevation_script_handles_spaces_in_path() {
        let dirs = vec![PathBuf::from("/Users/my user/.local/bin")];
        let script = build_elevation_script(
            &dirs,
            "myuser",
            std::path::Path::new("/Users/my user/.local"),
        );
        // Paths are single-quoted to handle spaces
        assert!(script.contains("'/Users/my user/.local/bin'"));
        assert!(script.contains("'/Users/my user/.local'"));
    }
}
