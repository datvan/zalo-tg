use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

pub const PROJECT_ROOT: &str = env!("CARGO_MANIFEST_DIR");

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AppConfig {
    pub env_path: String,
    pub vars: HashMap<String, String>,
    pub editable_keys: Vec<String>,
}

pub fn load_env(path: &PathBuf) -> HashMap<String, String> {
    let mut vars = HashMap::new();
    if !path.exists() {
        return vars;
    }
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return vars,
    };
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            let key = k.trim().to_string();
            let val = v.trim().to_string();
            vars.insert(key, val);
        }
    }
    vars
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

pub fn editable_keys() -> Vec<String> {
    vec![
        "TG_TOKEN".into(),
        "TG_GROUP_ID".into(),
        "ZALO_QR_CODE_PATH".into(),
        "FORUM_TOPIC_TTL_HOURS".into(),
        "LOG_LEVEL".into(),
    ]
}
