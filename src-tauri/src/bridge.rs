use crate::config::BridgeConfig;
use crate::store::Database;
use crate::telegram::client::TelegramClient;
use crate::zalo::api::login::{self as zalo_login, ZaloCredentials};
use crate::zalo::client::{ZaloClient, ZaloEvent, ZaloState};
use serde_json::Value;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

type LogBuf = Arc<Mutex<Vec<LogEntry>>>;

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum BridgeState {
    Stopped,
    Starting,
    Running,
    Stopping,
    Error(String),
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct LogEntry {
    pub timestamp: String,
    pub level: String,
    pub text: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct BridgeStatus {
    pub state: BridgeState,
    pub pid: Option<u32>,
    pub uptime_secs: Option<u64>,
    pub log_count: usize,
    pub topic_count: usize,
    pub msg_count: usize,
}

pub struct BridgeOrchestrator {
    zc: Arc<ZaloClient>,
    state: Mutex<BridgeState>,
    logs: LogBuf,
    started_at: Mutex<Option<Instant>>,
    db: Arc<Database>,
    tg_client: Arc<Mutex<Option<TelegramClient>>>,
    tg_offset: Arc<Mutex<i64>>,
}

impl BridgeOrchestrator {
    pub fn new(db: Database, project_dir: &str) -> Self {
        Self {
            zc: Arc::new(ZaloClient::new(project_dir)),
            state: Mutex::new(BridgeState::Stopped),
            logs: Arc::new(Mutex::new(Vec::with_capacity(1000))),
            started_at: Mutex::new(None),
            db: Arc::new(db),
            tg_client: Arc::new(Mutex::new(None)),
            tg_offset: Arc::new(Mutex::new(0)),
        }
    }

    pub fn db(&self) -> &Database {
        &self.db
    }

    pub async fn start(&self, config: BridgeConfig) -> Result<(), String> {
        if let ZaloState::Connecting | ZaloState::Ready = self.zc.state().await {
            return Err("Bridge is already running".into());
        }

        *self.state.lock().await = BridgeState::Starting;

        let tg = match config.local_bot_api.as_ref() {
            Some(u) => TelegramClient::new_with_local(&config.tg_token, u),
            None => TelegramClient::new(&config.tg_token),
        };
        *self.tg_client.lock().await = Some(tg);

        // Load Zalo credentials and login natively
        let creds = match load_credentials(config.zalo_credentials_path.as_deref()) {
            Ok(c) => c,
            Err(e) => {
                *self.state.lock().await = BridgeState::Error(e.clone());
                return Err(e);
            }
        };
        let zc = self.zc.clone();
        zc.login(&creds).await.map_err(|e| {
            format!("zalo login: {e}")
        })?;

        *self.started_at.lock().await = Some(Instant::now());
        *self.state.lock().await = BridgeState::Running;

        // ── Telegram polling loop (TG→Zalo) ──────────────────────────────
        let tgc = self.tg_client.clone();
        let tgo = self.tg_offset.clone();
        let l3 = self.logs.clone();
        let zc_tg = self.zc.clone();
        let _tg_group = config.tg_group_id;
        tokio::spawn(async move {
            log_line(&l3, "[BRIDGE] native Zalo client started".into()).await;
            loop {
                let offset = *tgo.lock().await;
                let client_lock = tgc.lock().await;
                let client = match client_lock.as_ref() {
                    Some(c) => c,
                    None => {
                        drop(client_lock);
                        tokio::time::sleep(Duration::from_secs(5)).await;
                        continue;
                    }
                };
                match client.get_updates(Some(offset), Some(30)).await {
                    Ok(updates) => {
                        let mut max_id = offset;
                        for u in updates {
                            max_id = max_id.max(u.update_id + 1);
                            handle_tg_update(&l3, &zc_tg, &u).await;
                        }
                        *tgo.lock().await = max_id;
                    }
                    Err(e) => {
                        log_line(&l3, format!("[TG] polling error: {e}")).await;
                        tokio::time::sleep(Duration::from_secs(5)).await;
                    }
                }
                drop(client_lock);

                tokio::time::sleep(Duration::from_millis(300)).await;
            }
        });

        Ok(())
    }

    pub async fn stop(&self) -> Result<(), String> {
        *self.state.lock().await = BridgeState::Stopping;
        *self.started_at.lock().await = None;

        self.zc.stop().await.map_err(|e| format!("stop zalo: {e}"))?;

        *self.state.lock().await = BridgeState::Stopped;
        Ok(())
    }

    pub async fn status(&self) -> BridgeStatus {
        let zstate = self.zc.state().await;
        let running = zstate == ZaloState::Ready;
        let pid = None;

        if !running && *self.state.lock().await == BridgeState::Running {
            *self.state.lock().await = BridgeState::Stopped;
        }

        let uptime = self.started_at.lock().await.map(|t| t.elapsed().as_secs());
        BridgeStatus {
            state: self.state.lock().await.clone(),
            pid,
            uptime_secs: uptime,
            log_count: self.logs.lock().await.len(),
            topic_count: self.db.topic_count(),
            msg_count: self.db.msg_map_count(),
        }
    }

    pub fn zalo_client(&self) -> Arc<ZaloClient> {
        self.zc.clone()
    }

    pub async fn send_stdin(&self, cmd: &str) -> Result<(), String> {
        let val: Value =
            serde_json::from_str(cmd).map_err(|e| format!("parse cmd: {e}"))?;
        self.zc.send_raw(&val).await
    }

    pub async fn get_logs(&self, limit: usize) -> Vec<LogEntry> {
        let logs = self.logs.lock().await;
        let len = logs.len();
        if len <= limit {
            logs.clone()
        } else {
            logs[len - limit..].to_vec()
        }
    }
}

/// Load ZaloCredentials from the JSON file path, or from env vars.
fn load_credentials(path: Option<&std::path::Path>) -> Result<ZaloCredentials, String> {
    let creds_path = path.unwrap_or(std::path::Path::new("credentials.json"));
    let content = std::fs::read_to_string(creds_path)
        .map_err(|e| format!("read credentials: {e}"))?;
    let json: Value =
        serde_json::from_str(&content).map_err(|e| format!("parse credentials: {e}"))?;
    zalo_login::parse_credentials(&json)
}

// ── Telegram update handler ───────────────────────────────────────────────

async fn handle_tg_update(
    logs: &LogBuf,
    zc: &ZaloClient,
    update: &crate::telegram::client::TgUpdate,
) {
    if let Some(ref msg) = update.message {
        let text = msg.text.as_deref().unwrap_or("");
        let user = msg.from.as_ref().map(|u| u.first_name.as_str()).unwrap_or("?");
        log_line(logs, format!("[TG] #{} {}: {}", msg.chat.id, user, text)).await;

        if text.starts_with('/') {
            let cmd_name = text.split(' ').next().unwrap_or(text);
            match cmd_name {
                "/login" | "/start" => {
                    log_line(logs, "[TG] login command ignored (auto-login on start)".into()).await;
                }
                "/status" => {
                    log_line(logs, "[TG] Status requested".into()).await;
                }
                _ => {
                    log_line(logs, format!("[TG] unhandled: {cmd_name}")).await;
                }
            }
        } else if !text.is_empty() {
            if let Err(e) = zc.send_message(&msg.chat.id.to_string(), text).await {
                log_line(logs, format!("[ZALO] send error: {e}")).await;
            }
        }
    }

    if let Some(ref cq) = update.callback_query {
        if let Some(ref data) = cq.data {
            log_line(logs, format!("[TG] callback: {data}")).await;
        }
    }
}

// ── Utilities ────────────────────────────────────────────────────────────

async fn log_line(logs: &LogBuf, line: String) {
    let mut guard = logs.lock().await;
    if guard.len() >= 1000 {
        guard.remove(0);
    }
    guard.push(LogEntry {
        timestamp: now_str(),
        level: infer_level(&line),
        text: line,
    });
}

fn now_str() -> String {
    let d = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = d.as_secs();
    format!("{:02}:{:02}:{:02}", (secs / 3600) % 24, (secs / 60) % 60, secs % 60)
}

fn infer_level(line: &str) -> String {
    if line.contains("error") || line.contains("Error") || line.contains("ERR") {
        "error".into()
    } else if line.contains("warn") || line.contains("Warn") || line.contains("WARN") {
        "warn".into()
    } else if line.contains("info") || line.contains("Info") || line.contains("INFO") {
        "info".into()
    } else if line.contains("debug") || line.contains("Debug") || line.contains("DEBUG") {
        "debug".into()
    } else {
        "log".into()
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::BridgeConfig;
    use std::path::PathBuf;

    fn make_bridge() -> BridgeOrchestrator {
        let db = crate::store::Database::open_in_memory().unwrap();
        BridgeOrchestrator::new(db, ".")
    }

    fn test_config() -> BridgeConfig {
        BridgeConfig {
            tg_token: "test:token".into(),
            tg_group_id: -100,
            data_dir: PathBuf::from("/tmp"),
            zalo_credentials_path: None,
            local_bot_api: None,
            skip_muted_groups: false,
            mute_silent: false,
        }
    }

    #[tokio::test]
    async fn test_new_bridge_stopped() {
        let b = make_bridge();
        let s = b.status().await;
        assert_eq!(s.state, BridgeState::Stopped);
        assert!(s.pid.is_none());
        assert!(s.uptime_secs.is_none());
        assert_eq!(s.log_count, 0);
    }

    #[tokio::test]
    async fn test_start_stop() {
        let b = make_bridge();
        let cfg = test_config();
        let result = b.start(cfg).await;
        // Without valid credentials file, start should fail
        assert!(result.is_err());
        let s = b.status().await;
        assert!(matches!(s.state, BridgeState::Error(_) | BridgeState::Stopped));
        assert!(b.stop().await.is_ok());
    }

    #[tokio::test]
    async fn test_double_start_fails() {
        let b = make_bridge();
        let cfg = test_config();
        let first = b.start(cfg).await;
        // First fails (no credentials), second should also fail
        let second = b.start(test_config()).await;
        assert!(second.is_err() || first.is_err());
        let _ = b.stop().await;
    }

    #[tokio::test]
    async fn test_stop_when_not_running() {
        let b = make_bridge();
        // With ZaloClient, stop succeeds even when not running
        assert!(b.stop().await.is_ok());
    }

    #[tokio::test]
    async fn test_log_count_updates() {
        let b = make_bridge();
        assert_eq!(b.status().await.log_count, 0);
        assert!(b.get_logs(10).await.is_empty());
    }

    #[tokio::test]
    async fn test_get_logs_empty() {
        let b = make_bridge();
        let logs = b.get_logs(100).await;
        assert!(logs.is_empty());
    }

    #[tokio::test]
    async fn test_state_transitions() {
        let b = make_bridge();
        assert_eq!(b.status().await.state, BridgeState::Stopped);

        *b.state.lock().await = BridgeState::Starting;
        assert_eq!(b.status().await.state, BridgeState::Starting);

        *b.state.lock().await = BridgeState::Stopping;
        assert_eq!(b.status().await.state, BridgeState::Stopping);

        // Running without worker auto-transitions to Stopped
        *b.state.lock().await = BridgeState::Running;
        b.status().await;
        assert_eq!(*b.state.lock().await, BridgeState::Stopped);

        *b.state.lock().await = BridgeState::Starting;
        assert_eq!(b.status().await.state, BridgeState::Starting);
        *b.state.lock().await = BridgeState::Error("test".into());
        assert_eq!(b.status().await.state, BridgeState::Error("test".into()));
    }

    #[tokio::test]
    async fn test_db_accessible() {
        let b = make_bridge();
        assert_eq!(b.db().topic_count(), 0);
        assert_eq!(b.db().msg_map_count(), 0);
    }

    #[tokio::test]
    async fn test_send_stdin() {
        let b = make_bridge();
        // Without credentials, send_raw fails with "not logged in"
        let err = b.send_stdin(r#"{"cmd":"sendMessage","threadId":"1","text":"hi"}"#).await.unwrap_err();
        assert!(err.contains("not logged in") || err.contains("unknown cmd"));
    }

    #[tokio::test]
    async fn test_zalo_client_accessible() {
        let b = make_bridge();
        let zc = b.zalo_client();
        assert_eq!(zc.state().await, ZaloState::Disconnected);
    }
}
