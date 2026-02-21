mod claude;
mod history;
mod zotero;

use std::process::Command;
use std::sync::Mutex;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "macos")]
fn set_macos_app_icon() {
    use objc2::{AnyThread, MainThreadMarker};
    use objc2_foundation::NSData;
    use objc2_app_kit::{NSApplication, NSImage};

    let icon_bytes = include_bytes!("../icons/icon.png");

    // We're in the setup callback which runs on the main thread
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

struct SidecarState {
    child: Option<std::process::Child>,
}

fn start_sidecar(sidecar_path: &str, port: u16) -> Option<std::process::Child> {
    let child = Command::new("node")
        .arg(sidecar_path)
        .env("PORT", port.to_string())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn();

    match child {
        Ok(child) => {
            println!("Sidecar started with PID: {}", child.id());
            Some(child)
        }
        Err(e) => {
            eprintln!("Failed to start sidecar: {}", e);
            None
        }
    }
}

#[tauri::command]
fn get_sidecar_url() -> String {
    "http://localhost:3001".to_string()
}

#[tauri::command]
fn create_new_window(app: tauri::AppHandle) -> Result<(), String> {
    let label = format!("window-{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis());

    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::default())
        .title("ClaudePrism")
        .inner_size(1400.0, 900.0)
        .min_inner_size(800.0, 600.0)
        .visible(false)
        .hidden_title(true);

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .traffic_light_position(tauri::LogicalPosition::new(12.0, 12.0));
    }

    builder.build().map_err(|e| format!("Failed to create window: {}", e))?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Load .env file (walks up from cwd to find it)
    let _ = dotenvy::dotenv();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .manage(Mutex::new(SidecarState { child: None }))
        .manage(claude::ClaudeProcessState::default())
        .manage(zotero::ZoteroOAuthState::default())
        .setup(|app| {
            // Set macOS Dock icon (dev mode doesn't use bundle, so set it at runtime)
            #[cfg(target_os = "macos")]
            set_macos_app_icon();

            // In dev mode, the sidecar is started separately (via pnpm dev:desktop)
            // In production, start the sidecar from the bundled resources
            let sidecar_path = if let Ok(path) = std::env::var("SIDECAR_PATH") {
                Some(path)
            } else if cfg!(not(debug_assertions)) {
                let resource_dir = app
                    .path()
                    .resource_dir()
                    .unwrap_or_else(|_| std::path::PathBuf::from("."));
                Some(
                    resource_dir
                        .join("sidecar")
                        .join("index.js")
                        .to_string_lossy()
                        .to_string(),
                )
            } else {
                // Dev mode: sidecar is managed by the dev script
                println!("Dev mode: expecting sidecar on port 3001 (start with pnpm dev:desktop)");
                None
            };

            if let Some(path) = sidecar_path {
                let child = start_sidecar(&path, 3001);
                let state = app.state::<Mutex<SidecarState>>();
                let mut state = state.lock().unwrap();
                state.child = child;
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_sidecar_url,
            create_new_window,
            claude::execute_claude_code,
            claude::continue_claude_code,
            claude::resume_claude_code,
            claude::cancel_claude_execution,
            claude::run_shell_command,
            claude::list_claude_sessions,
            claude::load_session_history,
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
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        match event {
            tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } => {
                // Kill Claude process associated with this window
                let claude_state = app_handle.state::<claude::ClaudeProcessState>();
                let label_clone = label.clone();
                let state_clone = claude_state.inner().clone();
                tauri::async_runtime::spawn(async move {
                    claude::kill_process_for_window(&state_clone, &label_clone).await;
                });

                // Quit the app when the last window is closed
                if app_handle.webview_windows().is_empty() {
                    app_handle.exit(0);
                }
            }
            tauri::RunEvent::ExitRequested { .. } => {
                // Kill sidecar on exit
                let state = app_handle.state::<Mutex<SidecarState>>();
                if let Ok(mut guard) = state.lock() {
                    if let Some(ref mut child) = guard.child {
                        let _ = child.kill();
                        println!("Sidecar process killed");
                    }
                };
            }
            _ => {}
        }
    });
}
