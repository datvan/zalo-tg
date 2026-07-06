use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

pub const PROJECT_ROOT: &str = env!("CARGO_MANIFEST_DIR");

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AppConfig {
    pub env_path: String,
    pub source_files: Vec<String>,
    pub vars: HashMap<String, String>,
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
