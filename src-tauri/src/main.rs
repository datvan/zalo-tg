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
mod store;

use bridge::BridgeOrchestrator;
use config::AppConfig;
use store::Database;

fn base_paths(project_dir: &PathBuf) -> (PathBuf, PathBuf) {
    (project_dir.join(".env"), project_dir.join(".env.local"))
}

struct AppState {
    bridge: BridgeOrchestrator,
    project_dir: PathBuf,
}

fn db_path(project_dir: &PathBuf) -> PathBuf {
    project_dir.join("data").join("bridge.db")
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
    Ok(state.bridge.status())
}

#[tauri::command]
async fn get_logs(
    state: tauri::State<'_, Mutex<AppState>>,
    limit: usize,
) -> Result<Vec<bridge::LogEntry>, ()> {
    let state = state.lock().await;
    Ok(state.bridge.get_logs(limit))
}

#[tauri::command]
async fn get_config(
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<AppConfig, String> {
    let state = state.lock().await;
    let (base, local) = base_paths(&state.project_dir);
    let (vars, source_files) = config::load_merged_env(&base, &local);
    let env_path = if source_files.is_empty() {
        base.to_string_lossy().to_string()
    } else {
        source_files.join(", ")
    };
    Ok(AppConfig {
        env_path,
        source_files,
        vars,
    })
}

#[tauri::command]
async fn load_custom_env(
    path: String,
) -> Result<AppConfig, String> {
    let file_path = PathBuf::from(&path);
    let (vars, found) = config::load_file(&file_path);
    if !found {
        return Err("File not found".into());
    }
    Ok(AppConfig {
        env_path: path.clone(),
        source_files: vec![path],
        vars,
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
async fn list_env_files(
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<Vec<String>, String> {
    let state = state.lock().await;
    let dir = std::fs::read_dir(&state.project_dir).map_err(|e| format!("read dir: {e}"))?;
    let mut files: Vec<String> = dir
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name().to_string_lossy().to_lowercase();
            name == ".env" || name == ".env.local" || name.starts_with(".env.")
        })
        .map(|e| e.path().to_string_lossy().to_string())
        .collect();
    files.sort();
    Ok(files)
}

#[tauri::command]
async fn open_env_file(
    state: tauri::State<'_, Mutex<AppState>>,
) -> Result<(), String> {
    let state = state.lock().await;
    let base = state.project_dir.join(".env");
    let local = state.project_dir.join(".env.local");
    let target = if local.exists() { local } else { base };
    drop(state);
    if target.exists() {
        std::process::Command::new("open")
            .arg(target.to_str().unwrap_or(""))
            .status()
            .map_err(|e| format!("open env: {e}"))?;
    }
    Ok(())
}

#[derive(serde::Serialize)]
struct FsEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[tauri::command]
async fn scan_dir(
    dir: String,
) -> Result<Vec<FsEntry>, String> {
    let path = PathBuf::from(&dir);
    let mut entries: Vec<FsEntry> = std::fs::read_dir(&path)
        .map_err(|e| format!("read dir {dir}: {e}"))?
        .filter_map(|e| e.ok())
        .map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let path = e.path().to_string_lossy().to_string();
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            FsEntry { name, path, is_dir }
        })
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[tauri::command]
async fn get_topics(state: tauri::State<'_, Mutex<AppState>>) -> Result<Vec<store::topics::TopicEntry>, ()> {
    let state = state.lock().await;
    Ok(state.bridge.db().list_topics())
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::new("info"))
        .compact()
        .init();

    let project_dir = PathBuf::from(config::PROJECT_ROOT);

    let db = Database::open(&db_path(&project_dir)).expect("Failed to open database");

    let bridge = BridgeOrchestrator::new(db);

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
            load_custom_env,
            save_config,
            list_env_files,
            open_env_file,
            toggle_window,
            scan_dir,
            get_topics,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
