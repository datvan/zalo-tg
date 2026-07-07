use std::io::BufRead;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[derive(Debug, Clone, serde::Serialize)]
pub struct LogEntry {
    pub timestamp: String,
    pub level: String,
    pub text: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct BridgeStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub uptime_secs: Option<u64>,
    pub log_count: usize,
}

fn shlex(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

pub struct BridgeProcess {
    child: Mutex<Option<Child>>,
    logs: Arc<Mutex<Vec<LogEntry>>>,
    started_at: Mutex<Option<Instant>>,
}

impl Default for BridgeProcess {
    fn default() -> Self {
        Self::new()
    }
}

impl BridgeProcess {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            logs: Arc::new(Mutex::new(Vec::with_capacity(1000))),
            started_at: Mutex::new(None),
        }
    }

    pub async fn start(&self, project_dir: &str) -> Result<(), String> {
        {
            let child_lock = self.child.lock().map_err(|e| format!("lock: {e}"))?;
            if child_lock.is_some() {
                return Err("Bridge is already running".into());
            }
        }

        let mut child = Command::new("bash")
            .args(["-l", "-c", &format!(
                "cd {} && node --import tsx/esm src/index.ts",
                shlex(&project_dir)
            )])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null())
            .spawn()
            .map_err(|e| format!("spawn bridge: {e}"))?;

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        {
            let mut child_lock = self.child.lock().map_err(|e| format!("lock: {e}"))?;
            *child_lock = Some(child);
        }
        {
            let mut started = self.started_at.lock().map_err(|e| format!("lock: {e}"))?;
            *started = Some(Instant::now());
        }

        if let Some(stderr) = stderr {
            let logs = self.logs.clone();
            tokio::task::spawn_blocking(move || {
                let reader = std::io::BufReader::new(stderr);
                for line in reader.lines() {
                    match line {
                        Ok(l) => {
                            push_log(&logs, LogEntry {
                                timestamp: now_str(),
                                level: infer_level(&l),
                                text: l,
                            });
                        }
                        Err(_) => break,
                    }
                }
            });
        }

        if let Some(stdout) = stdout {
            let logs = self.logs.clone();
            tokio::task::spawn_blocking(move || {
                let reader = std::io::BufReader::new(stdout);
                for line in reader.lines() {
                    match line {
                        Ok(l) => {
                            push_log(&logs, LogEntry {
                                timestamp: now_str(),
                                level: infer_level(&l),
                                text: l,
                            });
                        }
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

        {
            let mut started = self.started_at.lock().map_err(|e| format!("lock: {e}"))?;
            *started = None;
        }

        let pid = child.id();
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg(pid.to_string())
            .status();

        let start = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return Ok(()),
                Ok(None) => {
                    if start.elapsed() > std::time::Duration::from_secs(5) {
                        let _ = Command::new("kill")
                            .arg("-KILL")
                            .arg(pid.to_string())
                            .status();
                        let _ = child.wait();
                        return Ok(());
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(_) => return Ok(()),
            }
        }
    }

    pub fn status_sync(&self) -> BridgeStatus {
        let mut child_lock = self.child.lock().ok();
        let running = child_lock
            .as_mut()
            .and_then(|c| c.as_mut())
            .map(|c| c.try_wait().ok().flatten().is_none())
            .unwrap_or(false);
        let pid = child_lock
            .as_ref()
            .and_then(|c| c.as_ref().map(|c| c.id()));
        drop(child_lock);

        let uptime = self
            .started_at
            .lock()
            .ok()
            .and_then(|s| *s)
            .map(|t| t.elapsed().as_secs());
        let log_count = self.logs.lock().map(|l| l.len()).unwrap_or(0);

        BridgeStatus {
            running,
            pid,
            uptime_secs: uptime,
            log_count,
        }
    }

    pub fn get_logs_sync(&self, limit: usize) -> Vec<LogEntry> {
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

fn push_log(logs: &Arc<Mutex<Vec<LogEntry>>>, entry: LogEntry) {
    if let Ok(mut guard) = logs.lock() {
        if guard.len() >= 1000 {
            guard.remove(0);
        }
        guard.push(entry);
    }
}

fn now_str() -> String {
    let d = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = d.as_secs();
    let h = (secs / 3600) % 24;
    let m = (secs / 60) % 60;
    let s = secs % 60;
    format!("{h:02}:{m:02}:{s:02}")
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
