use crate::config::BridgeConfig;
use crate::store::Database;
use crate::telegram::client::TelegramClient;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
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

#[derive(serde::Deserialize)]
struct SidecarEvent {
    #[serde(rename = "type")]
    event_type: String,
    state: Option<String>,
}

pub struct BridgeOrchestrator {
    child: Mutex<Option<Child>>,
    state: Mutex<BridgeState>,
    logs: LogBuf,
    started_at: Mutex<Option<Instant>>,
    db: Arc<Database>,
    tg_client: Arc<Mutex<Option<TelegramClient>>>,
    tg_offset: Arc<Mutex<i64>>,
    stdin_writer: Arc<Mutex<Option<tokio::process::ChildStdin>>>,
}

impl BridgeOrchestrator {
    pub fn new(db: Database) -> Self {
        Self {
            child: Mutex::new(None),
            state: Mutex::new(BridgeState::Stopped),
            logs: Arc::new(Mutex::new(Vec::with_capacity(1000))),
            started_at: Mutex::new(None),
            db: Arc::new(db),
            tg_client: Arc::new(Mutex::new(None)),
            tg_offset: Arc::new(Mutex::new(0)),
            stdin_writer: Arc::new(Mutex::new(None)),
        }
    }

    pub fn db(&self) -> &Database {
        &self.db
    }

    pub async fn start(&self, project_dir: &str, config: BridgeConfig) -> Result<(), String> {
        {
            let child_lock = self.child.lock().await;
            if child_lock.is_some() {
                return Err("Bridge is already running".into());
            }
        }

        *self.state.lock().await = BridgeState::Starting;

        let tg = match config.local_bot_api.as_ref() {
            Some(u) => TelegramClient::new_with_local(&config.tg_token, u),
            None => TelegramClient::new(&config.tg_token),
        };
        *self.tg_client.lock().await = Some(tg);

        let script = format!(
            "cd {} && node --import tsx/esm src/sidecar.ts 2>&1",
            shlex(project_dir)
        );

        let mut child = Command::new("bash")
            .args(["-l", "-c", &script])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .stdin(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| {
                *self.state.blocking_lock() = BridgeState::Error(e.to_string());
                format!("spawn sidecar: {e}")
            })?;

        let child_stdout = child.stdout.take().ok_or("no stdout")?;
        let child_stdin = child.stdin.take().ok_or("no stdin")?;
        let child_stderr = child.stderr.take().ok_or("no stderr")?;

        *self.child.lock().await = Some(child);
        *self.started_at.lock().await = Some(Instant::now());
        *self.state.lock().await = BridgeState::Running;
        *self.stdin_writer.lock().await = Some(child_stdin);

        // ── Stdout reader (JSON events from sidecar) ──────────────────────
        let l1 = self.logs.clone();
        let db1 = self.db.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(child_stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log_line(&l1, format!("[SC] {line}")).await;
                if let Ok(ev) = serde_json::from_str::<SidecarEvent>(&line) {
                    if ev.event_type == "state" {
                        if let Some(s) = &ev.state {
                            log_line(&l1, format!("[SIDECAR] state: {s}")).await;
                        }
                    }
                }
            }
            log_line(&l1, "[SIDECAR] stdout closed".into()).await;
        });

        // ── Stderr reader ────────────────────────────────────────────────
        let l2 = self.logs.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(child_stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log_line(&l2, format!("[SC-ERR] {line}")).await;
            }
        });

        // ── Telegram polling loop (TG→Zalo) ──────────────────────────────
        let tgc = self.tg_client.clone();
        let tgo = self.tg_offset.clone();
        let l3 = self.logs.clone();
        let sw = self.stdin_writer.clone();
        let _tg_group = config.tg_group_id;
        tokio::spawn(async move {
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
                            handle_tg_update(&l3, &sw, &u).await;
                        }
                        *tgo.lock().await = max_id;
                    }
                    Err(e) => {
                        log_line(&l3, format!("[TG] polling error: {e}")).await;
                        tokio::time::sleep(Duration::from_secs(5)).await;
                    }
                }
                drop(client_lock);

                // Small delay between polling cycles
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
        });

        Ok(())
    }

    pub async fn stop(&self) -> Result<(), String> {
        let mut child_lock = self.child.lock().await;
        let mut child = child_lock.take().ok_or("Bridge is not running")?;
        *self.stdin_writer.lock().await = None;
        drop(child_lock);

        *self.state.lock().await = BridgeState::Stopping;
        *self.started_at.lock().await = None;

        let pid = child.id().ok_or("no pid")?;
        let _ = std::process::Command::new("kill")
            .arg("-TERM")
            .arg(pid.to_string())
            .status();

        let start = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => {
                    *self.state.lock().await = BridgeState::Stopped;
                    return Ok(());
                }
                Ok(None) => {
                    if start.elapsed() > Duration::from_secs(5) {
                        let _ = std::process::Command::new("kill")
                            .arg("-KILL")
                            .arg(pid.to_string())
                            .status();
                        let _ = child.wait().await;
                        *self.state.lock().await = BridgeState::Stopped;
                        return Ok(());
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                Err(_) => {
                    *self.state.lock().await = BridgeState::Stopped;
                    return Ok(());
                }
            }
        }
    }

    pub async fn status(&self) -> BridgeStatus {
        let mut child_guard = self.child.lock().await;
        let running = child_guard
            .as_mut()
            .and_then(|c| c.try_wait().ok().flatten())
            .is_none();
        let pid = child_guard.as_ref().filter(|_| running).and_then(|c| c.id());
        if !running {
            *child_guard = None;
        }
        drop(child_guard);

        if !running {
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

    pub async fn send_stdin(&self, cmd: &str) -> Result<(), String> {
        let mut w = self.stdin_writer.lock().await;
        let writer = w.as_mut().ok_or("stdin not available")?;
        writer
            .write_all(cmd.as_bytes())
            .await
            .map_err(|e| format!("stdin write: {e}"))?;
        writer
            .write_all(b"\n")
            .await
            .map_err(|e| format!("stdin write: {e}"))?;
        Ok(())
    }

    pub fn get_logs(&self, limit: usize) -> Vec<LogEntry> {
        let logs = self.logs.blocking_lock();
        let len = logs.len();
        if len <= limit {
            logs.clone()
        } else {
            logs[len - limit..].to_vec()
        }
    }
}

// ── Telegram update handler ───────────────────────────────────────────────

async fn handle_tg_update(
    logs: &LogBuf,
    stdin_w: &Mutex<Option<tokio::process::ChildStdin>>,
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
                    let cmd = serde_json::json!({"cmd": "trigger_login"});
                    send_stdin_cmd(stdin_w, &cmd).await;
                }
                "/status" => {
                    log_line(logs, "[TG] Status requested".into()).await;
                }
                _ => {
                    log_line(logs, format!("[TG] unhandled: {cmd_name}")).await;
                }
            }
        } else if !text.is_empty() {
            if let Some(ref from) = msg.from {
                let cmd = serde_json::json!({
                    "cmd": "send_message",
                    "data": {
                        "threadId": msg.chat.id.to_string(),
                        "text": text,
                        "fromId": from.id.to_string(),
                    }
                });
                send_stdin_cmd(stdin_w, &cmd).await;
            }
        }
    }

    if let Some(ref cq) = update.callback_query {
        if let Some(ref data) = cq.data {
            log_line(logs, format!("[TG] callback: {data}")).await;
        }
    }
}

async fn send_stdin_cmd(
    stdin_w: &Mutex<Option<tokio::process::ChildStdin>>,
    cmd: &serde_json::Value,
) {
    let mut w = stdin_w.lock().await;
    if let Some(ref mut writer) = *w {
        let line = serde_json::to_string(cmd).unwrap_or_default();
        let _ = writer.write_all(line.as_bytes()).await;
        let _ = writer.write_all(b"\n").await;
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

fn shlex(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}
