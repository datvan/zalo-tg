use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

pub const PROJECT_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/..");

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AppConfig {
    pub env_path: String,
    pub source_files: Vec<String>,
    pub vars: HashMap<String, String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BridgeConfig {
    pub tg_token: String,
    pub tg_group_id: i64,
    pub data_dir: PathBuf,
    pub zalo_credentials_path: Option<PathBuf>,
    pub local_bot_api: Option<String>,
    pub skip_muted_groups: bool,
    pub mute_silent: bool,
}

impl Default for BridgeConfig {
    fn default() -> Self {
        Self {
            tg_token: String::new(),
            tg_group_id: 0,
            data_dir: PathBuf::from(PROJECT_ROOT).join("data"),
            zalo_credentials_path: None,
            local_bot_api: None,
            skip_muted_groups: false,
            mute_silent: false,
        }
    }
}

impl BridgeConfig {
    pub fn from_vars(vars: &HashMap<String, String>) -> Self {
        Self {
            tg_token: vars.get("TG_TOKEN").cloned().unwrap_or_default(),
            tg_group_id: vars
                .get("TG_GROUP_ID")
                .and_then(|v| v.parse().ok())
                .unwrap_or(0),
            data_dir: vars
                .get("DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(PROJECT_ROOT).join("data")),
            zalo_credentials_path: vars
                .get("ZALO_CREDENTIALS_PATH")
                .map(PathBuf::from),
            local_bot_api: vars.get("LOCAL_BOT_API").cloned(),
            skip_muted_groups: vars
                .get("ZALO_SKIP_MUTED_GROUPS")
                .map(|v| v == "1" || v == "true")
                .unwrap_or(false),
            mute_silent: vars
                .get("ZALO_MUTE_SILENT")
                .map(|v| v == "1" || v == "true")
                .unwrap_or(false),
        }
    }
}

pub fn parse_env(content: &str) -> HashMap<String, String> {
    let mut vars = HashMap::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            vars.insert(k.trim().to_string(), v.trim().to_string());
        }
    }
    vars
}

pub fn load_file(path: &PathBuf) -> (HashMap<String, String>, bool) {
    match fs::read_to_string(path) {
        Ok(c) => (parse_env(&c), true),
        Err(_) => (HashMap::new(), false),
    }
}

pub fn load_merged_env(base: &PathBuf, local: &PathBuf) -> (HashMap<String, String>, Vec<String>) {
    let mut sources = Vec::new();
    let mut vars = HashMap::new();

    let (base_vars, base_ok) = load_file(base);
    if base_ok {
        vars.extend(base_vars);
        sources.push(base.to_string_lossy().to_string());
    }

    let (local_vars, local_ok) = load_file(local);
    if local_ok {
        vars.extend(local_vars);
        sources.push(local.to_string_lossy().to_string());
    }

    (vars, sources)
}

pub fn save_env(path: &PathBuf, vars: &HashMap<String, String>) -> Result<(), String> {
    let content = vars
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    fs::write(path, content).map_err(|e| format!("write .env: {e}"))
}
