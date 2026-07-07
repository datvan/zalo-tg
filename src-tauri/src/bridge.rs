use crate::store::Database;
use std::io::BufRead;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Instant;

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
    child: Mutex<Option<Child>>,
    state: Mutex<BridgeState>,
    logs: Arc<Mutex<Vec<LogEntry>>>,
    started_at: Mutex<Option<Instant>>,
    db: Arc<Database>,
}

impl BridgeOrchestrator {
    pub fn new(db: Database) -> Self {
        Self {
            child: Mutex::new(None),
            state: Mutex::new(BridgeState::Stopped),
            logs: Arc::new(Mutex::new(Vec::with_capacity(1000))),
            started_at: Mutex::new(None),
            db: Arc::new(db),
        }
    }

    pub fn db(&self) -> &Database {
        &self.db
    }

    pub async fn start(&self, project_dir: &str) -> Result<(), String> {
        {
            let child_lock = self.child.lock().map_err(|e| format!("lock: {e}"))?;
            if child_lock.is_some() {
                return Err("Bridge is already running".into());
            }
        }

        *self.state.lock().map_err(|e| format!("lock: {e}"))? = BridgeState::Starting;

        let script = format!(
            "cd {} && node --import tsx/esm src/index.ts 2>&1",
            shlex(project_dir)
        );

        let child = Command::new("bash")
            .args(["-l", "-c", &script])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null())
            .spawn()
            .map_err(|e| {
                *self.state.lock().unwrap() = BridgeState::Error(e.to_string());
                format!("spawn bridge: {e}")
            })?;

        {
            let mut child_lock = self.child.lock().map_err(|e| format!("lock: {e}"))?;
            *child_lock = Some(child);
        }
        {
            let mut started = self.started_at.lock().map_err(|e| format!("lock: {e}"))?;
            *started = Some(Instant::now());
        }
        *self.state.lock().map_err(|e| format!("lock: {e}"))? = BridgeState::Running;

        let logs = self.logs.clone();
        let child_stdout = {
            let mut child_lock = self.child.lock().map_err(|e| format!("lock: {e}"))?;
            child_lock.as_mut().and_then(|c| c.stdout.take())
        };
        let child_stderr = {
            let mut child_lock = self.child.lock().map_err(|e| format!("lock: {e}"))?;
            child_lock.as_mut().and_then(|c| c.stderr.take())
        };

        if let Some(out) = child_stdout {
            let logs_clone = logs.clone();
            tokio::task::spawn_blocking(move || {
                let reader = std::io::BufReader::new(out);
                for line in reader.lines() {
                    match line {
                        Ok(l) => push_log(&logs_clone, l),
                        Err(_) => break,
                    }
                }
            });
        }
        if let Some(err) = child_stderr {
            let logs_clone = logs.clone();
            tokio::task::spawn_blocking(move || {
                let reader = std::io::BufReader::new(err);
                for line in reader.lines() {
                    match line {
                        Ok(l) => push_log(&logs_clone, l),
                        Err(_) => break,
                    }
                }
            });
        }

        Ok(())
    }

    pub async fn stop(&self) -> Result<(), String> {
        let mut child_lock = self.child.lock().map_err(|e| format!("lock: {e}"))?;
        let mut child = child_lock.take().ok_or("Bridge is not running")?;
        drop(child_lock);

        *self.state.lock().map_err(|e| format!("lock: {e}"))? = BridgeState::Stopping;
        {
            let mut started = self.started_at.lock().map_err(|e| format!("lock: {e}"))?;
            *started = None;
        }

        let pid = child.id();
        let _ = Command::new("kill").arg("-TERM").arg(pid.to_string()).status();

        let start = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => {
                    *self.state.lock().unwrap() = BridgeState::Stopped;
                    return Ok(());
                }
                Ok(None) => {
                    if start.elapsed() > std::time::Duration::from_secs(5) {
                        let _ = Command::new("kill").arg("-KILL").arg(pid.to_string()).status();
                        let _ = child.wait();
                        *self.state.lock().unwrap() = BridgeState::Stopped;
                        return Ok(());
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(_) => {
                    *self.state.lock().unwrap() = BridgeState::Stopped;
                    return Ok(());
                }
            }
        }
    }

    pub fn status(&self) -> BridgeStatus {
        let mut child_guard = self.child.lock().ok();
        let running = child_guard
            .as_mut()
            .and_then(|g| g.as_mut())
            .map(|c| c.try_wait().ok().flatten().is_none())
            .unwrap_or(false);
        let pid = child_guard
            .as_ref()
            .and_then(|g| g.as_ref())
            .filter(|_| running)
            .map(|c| c.id());

        if !running {
            if let Ok(mut guard) = self.child.lock() {
                *guard = None;
            }
        }

        let uptime = self
            .started_at
            .lock()
            .ok()
            .and_then(|s| *s)
            .map(|t| t.elapsed().as_secs());

        let log_count = self.logs.lock().map(|l| l.len()).unwrap_or(0);

        if !running {
            if let Ok(mut s) = self.state.lock() {
                *s = BridgeState::Stopped;
            }
        }

        BridgeStatus {
            state: self.state.lock().map(|s| s.clone()).unwrap_or(BridgeState::Stopped),
            pid,
            uptime_secs: uptime,
            log_count,
            topic_count: self.db.topic_count(),
            msg_count: self.db.msg_map_count(),
        }
    }

    pub fn get_logs(&self, limit: usize) -> Vec<LogEntry> {
        self.logs
            .lock()
            .map(|logs| {
                let len = logs.len();
                if len <= limit {
                    logs.clone()
                } else {
                    logs[len - limit..].to_vec()
                }
            })
            .unwrap_or_default()
    }
}

fn push_log(logs: &Arc<Mutex<Vec<LogEntry>>>, line: String) {
    if let Ok(mut guard) = logs.lock() {
        if guard.len() >= 1000 {
            guard.remove(0);
        }
        guard.push(LogEntry {
            timestamp: now_str(),
            level: infer_level(&line),
            text: line,
        });
    }
}

fn shlex(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn now_str() -> String {
    let d = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = d.as_secs();
    format!(
        "{:02}:{:02}:{:02}",
        (secs / 3600) % 24,
        (secs / 60) % 60,
        secs % 60
    )
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
