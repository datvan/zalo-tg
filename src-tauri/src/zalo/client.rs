use crate::zalo::types::*;
use serde_json::Value;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

const WORKER_SCRIPT: &str = "zalo-worker.mjs";

#[derive(Debug, Clone)]
pub enum ZaloState {
    Disconnected,
    Connecting,
    Ready,
    NeedLogin,
    Error(String),
}

#[derive(Debug)]
pub struct ZaloEvent {
    pub event_type: String,
    pub data: Value,
}

pub struct ZaloClient {
    child: Mutex<Option<Child>>,
    stdin_w: Mutex<Option<ChildStdin>>,
    state: Mutex<ZaloState>,
    worker_path: String,
}

impl ZaloClient {
    pub fn new(project_dir: &str) -> Self {
        Self {
            child: Mutex::new(None),
            stdin_w: Mutex::new(None),
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
        *self.stdin_w.lock().await = Some(stdin);
        *self.child.lock().await = Some(child);
        *self.state.lock().await = ZaloState::Connecting;

        Ok(())
    }

    pub async fn stop(&self) -> Result<(), String> {
        *self.stdin_w.lock().await = None;
        let mut child_lock = self.child.lock().await;
        if let Some(ref mut child) = *child_lock {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        *child_lock = None;
        *self.state.lock().await = ZaloState::Disconnected;
        Ok(())
    }

    pub async fn send_raw(&self, cmd: &Value) -> Result<Value, String> {
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
        // TODO: read response from stdout
        Ok(Value::Null)
    }

    pub async fn state(&self) -> ZaloState {
        let alive = self
            .child
            .lock()
            .await
            .as_mut()
            .and_then(|c| c.try_wait().ok().flatten())
            .is_none();
        if !alive {
            *self.state.lock().await = ZaloState::Disconnected;
        }
        self.state.lock().await.clone()
    }

    pub async fn send_message(&self, thread_id: &str, text: &str) -> Result<Value, String> {
        let cmd = serde_json::json!({
            "cmd": "sendMessage",
            "threadId": thread_id,
            "text": text,
        });
        self.send_raw(&cmd).await
    }

    pub async fn send_reaction(
        &self,
        msg_id: &str,
        reaction_type: i64,
    ) -> Result<Value, String> {
        let cmd = serde_json::json!({
            "cmd": "addReaction",
            "msgId": msg_id,
            "reactionType": reaction_type,
        });
        self.send_raw(&cmd).await
    }

    pub async fn recall_message(&self, msg_id: &str) -> Result<Value, String> {
        let cmd = serde_json::json!({
            "cmd": "deleteMessage",
            "msgId": msg_id,
        });
        self.send_raw(&cmd).await
    }

    pub async fn get_user_info(&self, user_id: &str) -> Result<Value, String> {
        let cmd = serde_json::json!({
            "cmd": "getUserInfo",
            "userId": user_id,
        });
        self.send_raw(&cmd).await
    }

    pub async fn get_group_info(&self, group_id: &str) -> Result<Value, String> {
        let cmd = serde_json::json!({
            "cmd": "getGroupInfo",
            "groupId": group_id,
        });
        self.send_raw(&cmd).await
    }

    pub async fn trigger_login(&self) -> Result<(), String> {
        let cmd = serde_json::json!({"cmd": "login"});
        self.send_raw(&cmd).await?;
        Ok(())
    }
}
