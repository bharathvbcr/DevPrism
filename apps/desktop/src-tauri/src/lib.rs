mod agent;
mod agent_runtime;
mod history;
mod latex;
mod skills;
mod slash_commands;
mod uv;
mod zotero;

use std::path::Path;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_fs::FsExt;

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgebaseBundle {
    version: u32,
    exported_at: String,
    linked_projects: Vec<agent::knowledge::LinkedProject>,
    #[serde(default)]
    project_summaries: Vec<agent::knowledge::cache::ProjectSummaryRecord>,
    settings: serde_json::Value,
}

const KNOWLEDGEBASE_IMPORT_KEYS: &[&str] = &[
    "agentProvider",
    "agentModel",
    "agentBackendMode",
    "geminiCliModel",
    "ollamaBaseUrl",
    "ollamaModel",
    "resumeProfile",
    "manualExperience",
    "evidenceEntries",
    "personalBio",
    "redactSecrets",
    "safeMode",
];

fn portable_knowledgebase_settings(settings: serde_json::Value) -> serde_json::Value {
    let Some(settings_obj) = settings.as_object() else {
        return serde_json::json!({});
    };

    let mut portable = serde_json::Map::new();
    for key in KNOWLEDGEBASE_IMPORT_KEYS {
        if let Some(value) = settings_obj.get(*key) {
            portable.insert((*key).to_string(), value.clone());
        }
    }
    portable.insert(
        "geminiApiKey".to_string(),
        serde_json::Value::String(String::new()),
    );
    serde_json::Value::Object(portable)
}

fn merge_imported_knowledgebase_settings(
    current: serde_json::Value,
    imported: serde_json::Value,
) -> serde_json::Value {
    let mut merged = current
        .as_object()
        .cloned()
        .unwrap_or_else(serde_json::Map::new);

    if let Some(imported_obj) = imported.as_object() {
        for key in KNOWLEDGEBASE_IMPORT_KEYS {
            if let Some(value) = imported_obj.get(*key) {
                merged.insert((*key).to_string(), value.clone());
            }
        }
    }

    serde_json::Value::Object(merged)
}

#[cfg(test)]
mod knowledgebase_tests {
    use super::*;

    #[test]
    fn portable_settings_exclude_secrets_and_unlisted_keys() {
        let portable = portable_knowledgebase_settings(serde_json::json!({
            "geminiApiKey": "secret-key",
            "resumeProfile": "Staff Engineer",
            "ollamaModel": "llama3.1",
            "unrelated": "do-not-export"
        }));

        assert_eq!(portable["geminiApiKey"], "");
        assert_eq!(portable["resumeProfile"], "Staff Engineer");
        assert_eq!(portable["ollamaModel"], "llama3.1");
        assert!(portable.get("unrelated").is_none());
    }

    #[test]
    fn imported_settings_merge_without_overwriting_api_key() {
        let merged = merge_imported_knowledgebase_settings(
            serde_json::json!({
                "geminiApiKey": "keep-me",
                "safeMode": false,
                "unrelated": "keep"
            }),
            serde_json::json!({
                "geminiApiKey": "do-not-import",
                "safeMode": true,
                "resumeProfile": "Research engineer"
            }),
        );

        assert_eq!(merged["geminiApiKey"], "keep-me");
        assert_eq!(merged["safeMode"], true);
        assert_eq!(merged["resumeProfile"], "Research engineer");
        assert_eq!(merged["unrelated"], "keep");
    }
}

/// Entry point for the `--tectonic-compile` subprocess mode.
/// Runs tectonic compilation in an isolated process so that C-level global state
/// (font cache, etc.) is cleaned up on exit, preventing assertion failures on retry.
pub fn tectonic_compile_subprocess(work_dir: &Path, main_file: &str) -> Result<(), String> {
    latex::compile_with_tectonic(work_dir, main_file)
}

pub async fn run_repl(model: Option<String>) -> Result<(), String> {
    agent::cli::run_repl(model).await
}

pub async fn run_chat(prompt: String, model: Option<String>) -> Result<(), String> {
    agent::cli::run_chat(prompt, model).await
}

// --- External editor detection & opening ---

#[derive(serde::Serialize, Clone)]
struct EditorInfo {
    id: String,
    name: String,
}

struct EditorDef {
    id: &'static str,
    name: &'static str,
    cli: &'static str,
}

const KNOWN_EDITORS: &[EditorDef] = &[
    EditorDef {
        id: "cursor",
        name: "Cursor",
        cli: "cursor",
    },
    EditorDef {
        id: "vscode",
        name: "VS Code",
        cli: "code",
    },
    EditorDef {
        id: "zed",
        name: "Zed",
        cli: "zed",
    },
    EditorDef {
        id: "sublime",
        name: "Sublime Text",
        cli: "subl",
    },
];

#[cfg(target_os = "macos")]
const MACOS_APP_PATHS: &[(&str, &str)] = &[
    ("cursor", "/Applications/Cursor.app"),
    ("vscode", "/Applications/Visual Studio Code.app"),
    ("zed", "/Applications/Zed.app"),
    ("sublime", "/Applications/Sublime Text.app"),
];

#[tauri::command]
fn detect_editors() -> Vec<EditorInfo> {
    KNOWN_EDITORS
        .iter()
        .filter(|e| is_editor_installed(e))
        .map(|e| EditorInfo {
            id: e.id.to_string(),
            name: e.name.to_string(),
        })
        .collect()
}

fn is_editor_installed(editor: &EditorDef) -> bool {
    #[cfg(target_os = "macos")]
    {
        if let Some((_, app_path)) = MACOS_APP_PATHS.iter().find(|(id, _)| *id == editor.id) {
            return Path::new(app_path).exists();
        }
    }
    // Fallback / Windows / Linux: check if CLI is on PATH
    which::which(editor.cli).is_ok()
}

#[tauri::command]
fn open_in_editor(
    editor_id: String,
    project_path: String,
    file_path: Option<String>,
    line: Option<u32>,
) -> Result<(), String> {
    let editor = KNOWN_EDITORS
        .iter()
        .find(|e| e.id == editor_id)
        .ok_or_else(|| format!("Unknown editor: {}", editor_id))?;

    // On macOS, GUI apps don't inherit the shell's PATH, so CLI tools like
    // "code", "cursor", etc. won't be found. Use the login shell to resolve them.
    let cli_path = resolve_editor_cli(editor.cli)?;

    let mut cmd = std::process::Command::new(&cli_path);

    // Open the project folder
    cmd.arg(&project_path);

    // If a specific file is given, open it (with optional line number via -g)
    if let Some(ref fp) = file_path {
        let full_path = Path::new(&project_path).join(fp);
        if let Some(ln) = line {
            cmd.arg("-g");
            cmd.arg(format!("{}:{}", full_path.display(), ln));
        } else {
            cmd.arg(full_path);
        }
    }

    cmd.spawn()
        .map_err(|e| format!("Failed to open {}: {}", editor.name, e))?;
    Ok(())
}

/// Resolve an editor CLI command to its full path.
/// On macOS, GUI apps lack the user's shell PATH, so we ask the login shell.
fn resolve_editor_cli(cli: &str) -> Result<String, String> {
    // First try the inherited PATH (works when launched from terminal)
    if let Ok(path) = which::which(cli) {
        return Ok(path.to_string_lossy().into_owned());
    }

    // On macOS, ask the login shell for the full PATH
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("/bin/zsh")
            .args(["-l", "-c", &format!("which {}", cli)])
            .output()
            .map_err(|e| format!("Failed to resolve {}: {}", cli, e))?;
        if output.status.success() {
            let resolved = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !resolved.is_empty() && Path::new(&resolved).exists() {
                return Ok(resolved);
            }
        }
    }

    // Fallback: return bare name and hope for the best
    Ok(cli.to_string())
}

#[cfg(target_os = "macos")]
fn set_macos_app_icon() {
    use objc2::{AnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;

    let icon_bytes = include_bytes!("../icons/icon.png");

    if let Some(mtm) = MainThreadMarker::new() {
        unsafe {
            let data = NSData::with_bytes(icon_bytes);
            if let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) {
                let app = NSApplication::sharedApplication(mtm);
                app.setApplicationIconImage(Some(&image));
            }
        }
    }
}

#[tauri::command]
fn create_new_window(app: tauri::AppHandle) -> Result<(), String> {
    let label = format!(
        "window-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );

    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::default())
        .title("DevPrism")
        .inner_size(1400.0, 900.0)
        .min_inner_size(800.0, 600.0)
        .visible(false);

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .traffic_light_position(tauri::LogicalPosition::new(12.0, 12.0));
    }

    builder
        .build()
        .map_err(|e| format!("Failed to create window: {}", e))?;

    Ok(())
}

#[tauri::command]
fn allow_project_directory(app: tauri::AppHandle, root_path: String) -> Result<(), String> {
    let fs_scope = app.fs_scope();
    fs_scope
        .allow_directory(&root_path, true)
        .map_err(|e| format!("Failed to allow project directory: {}", e))?;

    let asset_scope = app.state::<tauri::scope::Scopes>();
    asset_scope
        .allow_directory(&root_path, true)
        .map_err(|e| format!("Failed to allow project assets: {}", e))?;

    Ok(())
}

// --- Debug logging from JS (survives white-screen crashes) ---

#[tauri::command]
fn js_log(msg: String) {
    eprintln!("[js] {}", msg);
}

// --- Debug window ---

#[tauri::command]
fn open_debug_window(app: tauri::AppHandle) -> Result<(), String> {
    // If a debug window already exists, just focus it
    if let Some(win) = app.get_webview_window("debug") {
        win.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let url = WebviewUrl::App("index.html?debug=1".into());
    WebviewWindowBuilder::new(&app, "debug", url)
        .title("DevPrism - Debug")
        .inner_size(560.0, 700.0)
        .min_inner_size(400.0, 400.0)
        .visible(true)
        .build()
        .map_err(|e| format!("Failed to create debug window: {}", e))?;

    Ok(())
}

// --- System info for debug panel & bug reports ---

#[derive(serde::Serialize)]
struct SystemInfo {
    os: String,
    os_version: String,
    arch: String,
    app_version: String,
}

#[tauri::command]
async fn add_linked_project(
    state: tauri::State<'_, agent::knowledge::ProjectState>,
    name: String,
    path: String,
    tech_stack: Vec<String>,
    tags: Option<Vec<String>>,
    role: Option<String>,
    start_date: Option<String>,
    end_date: Option<String>,
    description: Option<String>,
    notes: Option<String>,
) -> Result<agent::knowledge::LinkedProject, String> {
    Ok(state
        .add_project_detailed(
            name,
            std::path::PathBuf::from(path),
            tech_stack,
            tags.unwrap_or_default(),
            role,
            start_date,
            end_date,
            description,
            notes,
        )
        .await)
}

#[tauri::command]
async fn remove_linked_project(
    state: tauri::State<'_, agent::knowledge::ProjectState>,
    id: String,
) -> Result<(), String> {
    let uuid = uuid::Uuid::parse_str(&id).map_err(|e| e.to_string())?;
    state.remove_project(uuid).await;
    Ok(())
}

#[tauri::command]
async fn list_linked_projects(
    state: tauri::State<'_, agent::knowledge::ProjectState>,
) -> Result<Vec<agent::knowledge::LinkedProject>, String> {
    Ok(state.list_projects().await)
}

#[tauri::command]
async fn analyze_linked_project(
    state: tauri::State<'_, agent::knowledge::ProjectState>,
    id: String,
) -> Result<agent::knowledge::LinkedProject, String> {
    let uuid = uuid::Uuid::parse_str(&id).map_err(|e| e.to_string())?;
    state
        .analyze_project(uuid)
        .await
        .ok_or_else(|| format!("Linked project not found: {}", id))
}

#[tauri::command]
async fn list_project_summaries(
) -> Result<Vec<agent::knowledge::cache::ProjectSummaryRecord>, String> {
    agent::knowledge::cache::list_project_summaries().map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_project_summary(
    project_id: String,
    summary: String,
) -> Result<agent::knowledge::cache::ProjectSummaryRecord, String> {
    agent::knowledge::cache::upsert_project_summary(&project_id, &summary)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_project_observations(
    project_id: String,
) -> Result<Vec<agent::knowledge::cache::Observation>, String> {
    agent::knowledge::cache::list_observations_for_project(&project_id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn export_knowledgebase(
    state: tauri::State<'_, agent::knowledge::ProjectState>,
    path: String,
) -> Result<(), String> {
    let settings_path = dirs::home_dir()
        .ok_or_else(|| "Could not find home directory".to_string())?
        .join(".devcouncil")
        .join("settings.json");
    let settings = match std::fs::read_to_string(&settings_path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_else(|_| serde_json::json!({})),
        Err(_) => serde_json::json!({}),
    };
    let bundle = KnowledgebaseBundle {
        version: 1,
        exported_at: chrono::Utc::now().to_rfc3339(),
        linked_projects: state.list_projects().await,
        project_summaries: agent::knowledge::cache::list_project_summaries().unwrap_or_default(),
        settings: portable_knowledgebase_settings(settings),
    };
    let content = serde_json::to_string_pretty(&bundle)
        .map_err(|e| format!("Failed to serialize knowledgebase: {}", e))?;
    std::fs::write(path, content).map_err(|e| format!("Failed to export knowledgebase: {}", e))
}

#[tauri::command]
async fn import_knowledgebase(
    state: tauri::State<'_, agent::knowledge::ProjectState>,
    path: String,
) -> Result<Vec<agent::knowledge::LinkedProject>, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read knowledgebase: {}", e))?;
    let bundle: KnowledgebaseBundle = serde_json::from_str(&content)
        .map_err(|e| format!("Invalid knowledgebase export: {}", e))?;
    let settings_path = dirs::home_dir()
        .ok_or_else(|| "Could not find home directory".to_string())?
        .join(".devcouncil")
        .join("settings.json");
    if let Some(parent) = settings_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create settings directory: {}", e))?;
    }
    let current_settings = match std::fs::read_to_string(&settings_path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_else(|_| serde_json::json!({})),
        Err(_) => serde_json::json!({}),
    };
    let merged_settings = merge_imported_knowledgebase_settings(current_settings, bundle.settings);
    let settings = serde_json::to_string_pretty(&merged_settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;
    std::fs::write(settings_path, settings)
        .map_err(|e| format!("Failed to import settings: {}", e))?;
    let _ = agent::knowledge::cache::sync_project_summaries(&bundle.project_summaries);
    Ok(state.upsert_projects(bundle.linked_projects).await)
}

#[tauri::command]
async fn resolve_agent_approval(
    state: tauri::State<'_, agent::ApprovalState>,
    action_id: String,
    approved: bool,
) -> Result<(), String> {
    let sender = state.pending.lock().await.remove(&action_id);
    if let Some(sender) = sender {
        let _ = sender.send(approved);
    }
    Ok(())
}

#[tauri::command]
async fn list_authorized_paths(
    state: tauri::State<'_, agent::knowledge::ProjectState>,
) -> Result<Vec<String>, String> {
    let paths = state.list_authorized_paths().await;
    Ok(paths
        .into_iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect())
}

#[tauri::command]
async fn add_authorized_path(
    state: tauri::State<'_, agent::knowledge::ProjectState>,
    path: String,
) -> Result<(), String> {
    state
        .add_authorized_path(std::path::PathBuf::from(path))
        .await;
    Ok(())
}

#[tauri::command]
async fn remove_authorized_path(
    state: tauri::State<'_, agent::knowledge::ProjectState>,
    path: String,
) -> Result<(), String> {
    state
        .remove_authorized_path(std::path::PathBuf::from(path))
        .await;
    Ok(())
}

#[tauri::command]
fn get_system_info(app: tauri::AppHandle) -> SystemInfo {
    // Get OS version from uname on unix, or fallback to "unknown"
    let os_version = {
        #[cfg(unix)]
        {
            std::process::Command::new("uname")
                .arg("-r")
                .output()
                .ok()
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|s| s.trim().to_string())
                .unwrap_or_else(|| "unknown".to_string())
        }
        #[cfg(not(unix))]
        {
            "unknown".to_string()
        }
    };

    SystemInfo {
        os: std::env::consts::OS.to_string(),
        os_version,
        arch: std::env::consts::ARCH.to_string(),
        app_version: app.package_info().version.to_string(),
    }
}

// --- Clipboard file paths (for Cmd+V paste in file tree) ---

#[tauri::command]
async fn read_clipboard_file_paths() -> Result<Vec<String>, String> {
    #[cfg(target_os = "macos")]
    {
        tokio::task::spawn_blocking(|| {
            let script = concat!(
                "set thePaths to \"\"\n",
                "try\n",
                "\tset theFiles to the clipboard as \u{00ab}class furl\u{00bb}\n",
                "\tset thePaths to POSIX path of theFiles\n",
                "on error\n",
                "\ttry\n",
                "\t\trepeat with f in (the clipboard as list)\n",
                "\t\t\ttry\n",
                "\t\t\t\tset thePaths to thePaths & POSIX path of (f as \u{00ab}class furl\u{00bb}) & linefeed\n",
                "\t\t\tend try\n",
                "\t\tend repeat\n",
                "\tend try\n",
                "end try\n",
                "return thePaths",
            );

            let output = std::process::Command::new("osascript")
                .arg("-e")
                .arg(script)
                .output()
                .map_err(|e| e.to_string())?;

            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if stdout.is_empty() {
                Ok(vec![])
            } else {
                Ok(stdout.lines().filter(|l| !l.is_empty()).map(|s| s.to_string()).collect())
            }
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(vec![])
    }
}

fn migrate_config_directory() {
    if let Some(home) = dirs::home_dir() {
        let legacy_dev_prism_dir = home.join(format!(".{}{}", "dev", "prism"));
        let legacy_agent_dir = home.join(format!(".{}{}", "clau", "de"));
        let new_dir = home.join(".devcouncil");

        let source = if legacy_dev_prism_dir.exists() {
            Some(legacy_dev_prism_dir)
        } else if legacy_agent_dir.exists() {
            Some(legacy_agent_dir)
        } else {
            None
        };

        if let Some(old_dir) = source {
            if !new_dir.exists() {
                eprintln!(
                    "[migration] Found legacy {} directory, migrating to .devcouncil",
                    old_dir.display()
                );
                if let Err(e) = std::fs::rename(&old_dir, &new_dir) {
                    eprintln!("[migration] Failed to rename directory: {}", e);
                }
            } else {
                eprintln!(
                    "[migration] Keeping legacy {} because .devcouncil already exists",
                    old_dir.display()
                );
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Migrate legacy configuration if present
    migrate_config_directory();

    // Load .env file (walks up from cwd to find it)
    let _ = dotenvy::dotenv();

    #[allow(clippy::expect_used)]
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .manage(agent_runtime::AgentProcessState::default())
        .manage(agent::AgentState::default())
        .manage(agent::ApprovalState::default())
        .manage(agent::knowledge::ProjectState::default())
        .manage(latex::LatexCompilerState::default())
        .manage(zotero::ZoteroOAuthState::default())
        .setup(|app| {
            // Initialize knowledge state (managed state)
            match agent::knowledge::cache::KnowledgeState::new() {
                Ok(state) => {
                    app.manage(state);
                }
                Err(e) => {
                    eprintln!("[knowledge] Failed to initialize database: {}", e);
                }
            }

            // Safety net: force-show the main window after a timeout if the
            // frontend JS never calls `getCurrentWindow().show()`.
            // This prevents the window from staying permanently hidden when
            // WKWebView fails to execute JS (e.g. WebKit top-level-await bug
            // on macOS 12). See https://bugs.webkit.org/show_bug.cgi?id=242740
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(8)).await;
                if let Some(window) = handle.get_webview_window("main") {
                    if !window.is_visible().unwrap_or(true) {
                        eprintln!("[safety] Main window still hidden after 8s, force-showing");
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_new_window,
            allow_project_directory,
            detect_editors,
            open_in_editor,
            js_log,
            read_clipboard_file_paths,
            latex::compile_latex,
            latex::synctex_edit,
            latex::detect_texlive,
            agent_runtime::execute_agent_code,
            agent_runtime::continue_agent_code,
            agent_runtime::resume_agent_code,
            agent_runtime::cancel_agent_execution,
            agent_runtime::run_shell_command,
            agent_runtime::get_agent_fast_mode,
            agent_runtime::set_agent_fast_mode,
            agent_runtime::get_redact_secrets,
            agent_runtime::set_redact_secrets,
            agent_runtime::get_safe_mode,
            agent_runtime::set_safe_mode,
            agent_runtime::get_agent_provider_settings,
            agent_runtime::set_agent_provider_settings,
            agent_runtime::check_gemini_api_status,
            agent_runtime::check_gemini_cli_status,
            agent_runtime::check_codex_cli_status,
            agent_runtime::check_ollama_status,
            agent_runtime::get_resume_knowledge_settings,
            agent_runtime::set_resume_knowledge_settings,
            agent_runtime::get_personal_bio,
            agent_runtime::set_personal_bio,
            agent_runtime::list_agent_sessions,
            agent_runtime::load_session_history,
            zotero::zotero_start_oauth,
            zotero::zotero_complete_oauth,
            zotero::zotero_cancel_oauth,
            history::history_init,
            history::history_snapshot,
            history::history_list,
            history::history_diff,
            history::history_file_at,
            history::history_restore,
            history::history_add_label,
            history::history_remove_label,
            slash_commands::slash_commands_list,
            slash_commands::slash_command_get,
            slash_commands::slash_command_save,
            slash_commands::slash_command_delete,
            slash_commands::manual_skill_save,
            slash_commands::manual_skill_delete,
            skills::install_scientific_skills,
            skills::install_scientific_skills_global,
            skills::check_skills_installed,
            skills::list_installed_skills,
            skills::uninstall_scientific_skills,
            skills::get_skill_categories,
            skills::get_skill_content,
            uv::check_uv_status,
            uv::install_uv,
            uv::setup_project_venv,
            uv::uv_add_packages,
            uv::uv_run_command,
            add_linked_project,
            remove_linked_project,
            list_linked_projects,
            analyze_linked_project,
            export_knowledgebase,
            import_knowledgebase,
            list_project_summaries,
            save_project_summary,
            list_project_observations,
            resolve_agent_approval,
            add_authorized_path,
            remove_authorized_path,
            list_authorized_paths,
            get_system_info,
            open_debug_window,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        match event {
            // Set the dock icon after the app is fully initialized.
            // Doing this in setup() causes SIGBUS on first launch from signed
            // binaries due to Gatekeeper App Translocation (#38).
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Ready => {
                set_macos_app_icon();
            }
            // Workaround: WKWebView sometimes fails to repaint after the app
            // returns from background, leaving a black screen.  We apply two
            // complementary fixes on focus-restore:
            //   1. Nudge the window size by 1 px and back (forces native
            //      compositing layer to re-composite).
            //   2. Trigger a DOM reflow via JS (forces WKWebView render tree
            //      rebuild without losing app state).
            // Either one alone may not cover all cases.
            // See https://github.com/tauri-apps/tauri/issues/5226
            //     https://github.com/tauri-apps/tauri/issues/14843
            tauri::RunEvent::WindowEvent {
                ref label,
                event: tauri::WindowEvent::Focused(true),
                ..
            } => {
                if let Some(window) = app_handle.get_webview_window(label) {
                    // macOS: nudge window size to fix black screen after wake/focus
                    // See https://github.com/tauri-apps/tauri/issues/5226
                    #[cfg(target_os = "macos")]
                    {
                        if let Ok(size) = window.inner_size() {
                            let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize {
                                width: size.width + 1,
                                height: size.height,
                            }));
                            let _ = window.set_size(tauri::Size::Physical(size));
                        }
                        let _ = window.eval(
                            "document.body.style.display='none';\
                             document.body.offsetHeight;\
                             document.body.style.display='';",
                        );
                    }
                    let _ = window.emit("window-focus-restored", ());
                }
            }
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } => {
                // Kill agent process associated with this window
                let handle_clone = app_handle.clone();
                let label_clone = label.clone();
                tauri::async_runtime::spawn(async move {
                    agent_runtime::kill_process_for_window(&handle_clone, &label_clone).await;
                });

                // Quit the app when the last window is closed
                if app_handle.webview_windows().is_empty() {
                    app_handle.exit(0);
                }
            }
            tauri::RunEvent::ExitRequested { .. } => {
                // Clean up LaTeX build temp directories
                let latex_state = app_handle.state::<latex::LatexCompilerState>();
                let state_clone = latex_state.inner().clone();
                tauri::async_runtime::spawn(async move {
                    latex::cleanup_all_builds(&state_clone).await;
                });
            }
            _ => {}
        }
    });
}
