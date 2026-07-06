use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};
use tokio::sync::Mutex;

mod bridge;
mod config;

use config::AppConfig;

struct AppState {
    bridge: bridge::BridgeProcess,
    project_dir: PathBuf,
}

#[tauri::command]
async fn start_bridge(state: tauri::State<'_, Mutex<AppState>>) -> Result<(), String> {
    let state = state.lock().await;
    let dir = state.project_dir.to_str().unwrap_or(".");
    state.bridge.start(dir).await
}

#[tauri::command]
async fn stop_bridge(state: tauri::State<'_, Mutex<AppState>>) -> Result<(), String> {
    let state = state.lock().await;
    state.bridge.stop().await
}

#[tauri::command]
async fn get_bridge_status(
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<bridge::BridgeStatus, ()> {
    let state = state.lock().await;
    Ok(state.bridge.status_sync())
}

#[tauri::command]
async fn get_logs(
    state: tauri::State<'_, Mutex<AppState>>,
    limit: usize,
) -> Result<Vec<bridge::LogEntry>, ()> {
    let state = state.lock().await;
    Ok(state.bridge.get_logs_sync(limit))
}

#[tauri::command]
async fn get_config(
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<AppConfig, String> {
    let state = state.lock().await;
    let env_path = state.project_dir.join(".env");
    let vars = config::load_env(&env_path);
    Ok(AppConfig {
        env_path: env_path.to_string_lossy().to_string(),
        vars,
        editable_keys: config::editable_keys(),
    })
}

#[tauri::command]
async fn save_config(
    state: tauri::State<'_, Mutex<AppState>>,
    vars: HashMap<String, String>,
) -> Result<(), String> {
    let state = state.lock().await;
    let env_path = state.project_dir.join(".env");
    if !env_path.exists() {
        std::fs::File::create(&env_path)
            .map_err(|e| format!("create .env: {e}"))?;
    }
    config::save_env(&env_path, &vars)
}

#[tauri::command]
async fn toggle_window(app: tauri::AppHandle) -> Result<(), ()> {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
    Ok(())
}

#[tauri::command]
async fn open_env_file(
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<(), String> {
    let state = state.lock().await;
    let env_path = state.project_dir.join(".env");
    drop(state);
    if env_path.exists() {
        std::process::Command::new("open")
            .arg(env_path.to_str().unwrap_or(""))
            .status()
            .map_err(|e| format!("open .env: {e}"))?;
    }
    Ok(())
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::new("info"))
        .compact()
        .init();

    let bridge = bridge::BridgeProcess::new();
    let project_dir = PathBuf::from(config::PROJECT_ROOT);

    tauri::Builder::default()
        .manage(Mutex::new(AppState {
            bridge,
            project_dir,
        }))
        .setup(|app| {
            let toggle = MenuItem::with_id(app, "toggle", "Show/Hide", true, None::<&str>)?;
            let start_item =
                MenuItem::with_id(app, "start", "Start Bridge", true, None::<&str>)?;
            let stop_item =
                MenuItem::with_id(app, "stop", "Stop Bridge", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, Some("Cmd+Q"))?;

            let menu = Menu::with_items(app, &[&toggle, &start_item, &stop_item, &quit])?;

            TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("zalo-tg Bridge")
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "toggle" => {
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                    "start" => {
                        let handle = app.app_handle().clone();
                        tauri::async_runtime::spawn(async move {
                            let state = handle.state::<Mutex<AppState>>();
                            let s = state.lock().await;
                            let dir = s.project_dir.to_str().unwrap_or(".");
                            let _ = s.bridge.start(dir).await;
                        });
                    }
                    "stop" => {
                        let handle = app.app_handle().clone();
                        tauri::async_runtime::spawn(async move {
                            let state = handle.state::<Mutex<AppState>>();
                            let s = state.lock().await;
                            let _ = s.bridge.stop().await;
                        });
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_bridge,
            stop_bridge,
            get_bridge_status,
            get_logs,
            get_config,
            save_config,
            open_env_file,
            toggle_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
