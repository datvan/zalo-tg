use serde_json::Value;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

const WORKER_SCRIPT: &str = "zalo-worker.mjs";

#[derive(Debug, Clone, PartialEq)]
pub enum ZaloState {
    Disconnected,
    Connecting,
    Ready,
    NeedLogin,
    Error(String),
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ZaloEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub event: Option<String>,
    pub cmd: Option<String>,
    pub data: Option<Value>,
    pub result: Option<Value>,
    pub error: Option<String>,
}

pub struct ZaloClient {
    child: Mutex<Option<Child>>,
    stdin_w: Mutex<Option<ChildStdin>>,
    stdout_r: Mutex<Option<ChildStdout>>,
    stderr_r: Mutex<Option<ChildStderr>>,
    state: Mutex<ZaloState>,
    worker_path: String,
}

impl ZaloClient {
    pub fn new(project_dir: &str) -> Self {
        Self {
            child: Mutex::new(None),
            stdin_w: Mutex::new(None),
            stdout_r: Mutex::new(None),
            stderr_r: Mutex::new(None),
            state: Mutex::new(ZaloState::Disconnected),
            worker_path: format!("{}/{}", project_dir, WORKER_SCRIPT),
        }
    }

    pub async fn start(&self) -> Result<(), String> {
        let mut child = Command::new("node")
            .arg("--import")
            .arg("tsx/esm")
            .arg(&self.worker_path)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .stdin(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("spawn zalo-worker: {e}"))?;

        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;

        *self.stdin_w.lock().await = Some(stdin);
        *self.stdout_r.lock().await = Some(stdout);
        *self.stderr_r.lock().await = Some(stderr);
        *self.child.lock().await = Some(child);
        *self.state.lock().await = ZaloState::Connecting;

        Ok(())
    }

    pub async fn stop(&self) -> Result<(), String> {
        *self.stdin_w.lock().await = None;
        *self.stdout_r.lock().await = None;
        *self.stderr_r.lock().await = None;
        let mut child_lock = self.child.lock().await;
        if let Some(ref mut child) = *child_lock {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        *child_lock = None;
        *self.state.lock().await = ZaloState::Disconnected;
        Ok(())
    }

    pub async fn child_id(&self) -> Option<u32> {
        self.child.lock().await.as_ref()?.id()
    }

    pub async fn try_wait(&self) -> Option<std::process::ExitStatus> {
        self.child
            .lock()
            .await
            .as_mut()?
            .try_wait()
            .ok()?
    }

    pub async fn take_stdin(&self) -> Option<ChildStdin> {
        self.stdin_w.lock().await.take()
    }

    pub async fn take_stdout(&self) -> Option<ChildStdout> {
        self.stdout_r.lock().await.take()
    }

    pub async fn take_stderr(&self) -> Option<ChildStderr> {
        self.stderr_r.lock().await.take()
    }

    pub async fn send_raw(&self, cmd: &Value) -> Result<(), String> {
        let mut w = self.stdin_w.lock().await;
        let writer = w.as_mut().ok_or("worker not started")?;
        let line = serde_json::to_string(cmd).map_err(|e| format!("serialize: {e}"))?;
        writer
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("stdin write: {e}"))?;
        writer
            .write_all(b"\n")
            .await
            .map_err(|e| format!("stdin write: {e}"))?;
        Ok(())
    }

    pub async fn state(&self) -> ZaloState {
        self.state.lock().await.clone()
    }

    pub async fn set_state(&self, s: ZaloState) {
        *self.state.lock().await = s;
    }

    pub async fn send_message(&self, thread_id: &str, text: &str) -> Result<(), String> {
        let cmd = serde_json::json!({
            "cmd": "sendMessage",
            "threadId": thread_id,
            "text": text,
        });
        self.send_raw(&cmd).await
    }

    pub async fn send_attachment(
        &self,
        thread_id: &str,
        file_path: &str,
        msg_type: Option<&str>,
    ) -> Result<(), String> {
        let mut cmd = serde_json::json!({
            "cmd": "sendAttachment",
            "threadId": thread_id,
            "attachments": [file_path],
        });
        if let Some(mt) = msg_type {
            cmd["msgType"] = serde_json::json!(mt);
        }
        self.send_raw(&cmd).await
    }

    pub async fn send_reaction(&self, msg_id: &str, reaction_type: i64) -> Result<(), String> {
        let cmd = serde_json::json!({
            "cmd": "addReaction",
            "msgId": msg_id,
            "reactionType": reaction_type,
        });
        self.send_raw(&cmd).await
    }

    pub async fn recall_message(&self, msg_id: &str) -> Result<(), String> {
        let cmd = serde_json::json!({
            "cmd": "deleteMessage",
            "msgId": msg_id,
        });
        self.send_raw(&cmd).await
    }

    pub async fn get_user_info(&self, user_id: &str) -> Result<(), String> {
        let cmd = serde_json::json!({
            "cmd": "getUserInfo",
            "userId": user_id,
        });
        self.send_raw(&cmd).await
    }

    pub async fn get_group_info(&self, group_id: &str) -> Result<(), String> {
        let cmd = serde_json::json!({
            "cmd": "getGroupInfo",
            "groupId": group_id,
        });
        self.send_raw(&cmd).await
    }

    pub async fn trigger_login(&self) -> Result<(), String> {
        let cmd = serde_json::json!({"cmd": "login"});
        self.send_raw(&cmd).await
    }
}
