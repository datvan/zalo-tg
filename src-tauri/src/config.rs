#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn test_parse_env_empty() {
        let vars = parse_env("");
        assert!(vars.is_empty());
    }

    #[test]
    fn test_parse_env_comment() {
        let vars = parse_env("# comment\n# another");
        assert!(vars.is_empty());
    }

    #[test]
    fn test_parse_env_simple() {
        let vars = parse_env("KEY=value\nFOO=bar");
        assert_eq!(vars.get("KEY").unwrap(), "value");
        assert_eq!(vars.get("FOO").unwrap(), "bar");
    }

    #[test]
    fn test_parse_env_whitespace() {
        let vars = parse_env("  KEY = value with space  ");
        assert_eq!(vars.get("KEY").unwrap(), "value with space");
    }

    #[test]
    fn test_parse_env_blank_lines() {
        let vars = parse_env("A=1\n\n\nB=2\n");
        assert_eq!(vars.len(), 2);
    }

    #[test]
    fn test_parse_env_empty_value() {
        let vars = parse_env("EMPTY=");
        assert_eq!(vars.get("EMPTY").unwrap(), "");
    }

    #[test]
    fn test_load_merged_env_base_only() {
        let dir = std::env::temp_dir().join("test_zalotg_config");
        let _ = std::fs::create_dir_all(&dir);
        let base = dir.join(".env");
        std::fs::write(&base, "A=1\nB=2\n").unwrap();
        let local = dir.join(".env.local");

        let (vars, sources) = load_merged_env(&base, &local);
        assert_eq!(vars.get("A").unwrap(), "1");
        assert_eq!(vars.get("B").unwrap(), "2");
        assert_eq!(sources.len(), 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_load_merged_env_local_overrides() {
        let dir = std::env::temp_dir().join("test_zalotg_config_local");
        let _ = std::fs::create_dir_all(&dir);
        let base = dir.join(".env");
        std::fs::write(&base, "A=1\nB=2\n").unwrap();
        let local = dir.join(".env.local");
        std::fs::write(&local, "B=overridden\nC=3\n").unwrap();

        let (vars, sources) = load_merged_env(&base, &local);
        assert_eq!(vars.get("A").unwrap(), "1");
        assert_eq!(vars.get("B").unwrap(), "overridden"); // local wins
        assert_eq!(vars.get("C").unwrap(), "3");
        assert_eq!(sources.len(), 2);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_load_merged_env_neither_exists() {
        let dir = std::env::temp_dir().join("test_zalotg_config_nonexist");
        let base = dir.join(".env");
        let local = dir.join(".env.local");
        let (vars, sources) = load_merged_env(&base, &local);
        assert!(vars.is_empty());
        assert!(sources.is_empty());
    }

    #[test]
    fn test_bridge_config_from_vars() {
        let mut vars = HashMap::new();
        vars.insert("TG_TOKEN".into(), "123:abc".into());
        vars.insert("TG_GROUP_ID".into(), "-100123".into());
        vars.insert("DATA_DIR".into(), "/custom/data".into());
        vars.insert("ZALO_CREDENTIALS_PATH".into(), "/path/creds".into());
        vars.insert("LOCAL_BOT_API".into(), "http://localhost:8081".into());
        vars.insert("ZALO_SKIP_MUTED_GROUPS".into(), "true".into());
        vars.insert("ZALO_MUTE_SILENT".into(), "1".into());

        let cfg = BridgeConfig::from_vars(&vars);
        assert_eq!(cfg.tg_token, "123:abc");
        assert_eq!(cfg.tg_group_id, -100123);
        assert_eq!(cfg.data_dir, PathBuf::from("/custom/data"));
        assert_eq!(cfg.zalo_credentials_path, Some(PathBuf::from("/path/creds")));
        assert_eq!(cfg.local_bot_api, Some("http://localhost:8081".into()));
        assert!(cfg.skip_muted_groups);
        assert!(cfg.mute_silent);
    }

    #[test]
    fn test_bridge_config_defaults() {
        let vars = HashMap::new();
        let cfg = BridgeConfig::from_vars(&vars);
        assert_eq!(cfg.tg_token, "");
        assert_eq!(cfg.tg_group_id, 0);
        assert_eq!(cfg.data_dir, PathBuf::from(PROJECT_ROOT).join("data"));
        assert!(cfg.zalo_credentials_path.is_none());
        assert!(cfg.local_bot_api.is_none());
        assert!(!cfg.skip_muted_groups);
        assert!(!cfg.mute_silent);
    }

    #[test]
    fn test_save_env_roundtrip() {
        let dir = std::env::temp_dir().join("test_zalotg_save_env");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join(".env.test");
        let mut vars = HashMap::new();
        vars.insert("A".into(), "1".into());
        vars.insert("B".into(), "hello world".into());
        save_env(&path, &vars).unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("A=1"));
        assert!(content.contains("B=hello world"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

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
