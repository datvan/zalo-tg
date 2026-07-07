use serde_json::Value;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

const WORKER_SCRIPT: &str = "zalo-worker.mjs";

#[derive(Debug, Clone)]
pub(crate) struct WorkerCmd {
    pub program: String,
    pub args: Vec<String>,
}

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
    cmd: Option<WorkerCmd>,
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
            cmd: None,
        }
    }

    /// Create a ZaloClient that runs an arbitrary command instead of the
    /// default `node --import tsx/esm zalo-worker.mjs`. Used for testing.
    #[allow(dead_code)]
    pub fn from_custom(program: &str, args: &[&str]) -> Self {
        Self {
            child: Mutex::new(None),
            stdin_w: Mutex::new(None),
            stdout_r: Mutex::new(None),
            stderr_r: Mutex::new(None),
            state: Mutex::new(ZaloState::Disconnected),
            worker_path: String::new(),
            cmd: Some(WorkerCmd {
                program: program.to_string(),
                args: args.iter().map(|a| a.to_string()).collect(),
            }),
        }
    }

    pub async fn start(&self) -> Result<(), String> {
        if self.child.lock().await.is_some() {
            return Err("Worker is already running".into());
        }
        let mut cmd = match &self.cmd {
            Some(custom) => {
                let mut c = Command::new(&custom.program);
                for arg in &custom.args {
                    c.arg(arg);
                }
                c
            }
            None => {
                let mut c = Command::new("node");
                c.arg("--import").arg("tsx/esm").arg(&self.worker_path);
                c
            }
        };

        let mut child = cmd
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_new_client_disconnected() {
        let zc = ZaloClient::new("/tmp");
        assert_eq!(zc.state().await, ZaloState::Disconnected);
        assert!(zc.child_id().await.is_none());
    }

    #[tokio::test]
    async fn test_start_stop_echo() {
        // Start a bash process that echoes stdin as JSON lines, simulating
        // the zalo-worker protocol.
        let zc = ZaloClient::from_custom("bash", &[
            "-c",
            "while IFS= read -r line; do echo \"{\\\"type\\\":\\\"response\\\",\\\"cmd\\\":\\\"echo\\\",\\\"result\\\":\\\"$line\\\"}\"; done",
        ]);
        zc.start().await.expect("start");
        assert_eq!(zc.state().await, ZaloState::Connecting);

        // Send a command
        let cmd = serde_json::json!({"cmd": "echo", "msg": "hello"});
        zc.send_raw(&cmd).await.expect("send");

        // Stop
        zc.stop().await.expect("stop");
        assert_eq!(zc.state().await, ZaloState::Disconnected);
    }

    #[tokio::test]
    async fn test_double_start_fails() {
        let zc = ZaloClient::from_custom("bash", &["-c", "sleep 10"]);
        zc.start().await.expect("first start");
        let err = zc.start().await.unwrap_err();
        // The second start will try to spawn a new process — may fail, but
        // the existing child's stdin/stdout/stderr were already taken so it
        // will error on "no stdin".
        assert!(!err.is_empty());
        zc.stop().await.ok();
    }

    #[tokio::test]
    async fn test_stop_without_start() {
        let zc = ZaloClient::new("/tmp");
        // Should not panic
        zc.stop().await.expect("stop unstarted");
        assert_eq!(zc.state().await, ZaloState::Disconnected);
    }

    #[tokio::test]
    async fn test_send_raw_without_start() {
        let zc = ZaloClient::new("/tmp");
        let cmd = serde_json::json!({"cmd": "ping"});
        let err = zc.send_raw(&cmd).await.unwrap_err();
        assert!(err.contains("not started"));
    }

    #[tokio::test]
    async fn test_take_handles_none() {
        let zc = ZaloClient::new("/tmp");
        assert!(zc.take_stdin().await.is_none());
        assert!(zc.take_stdout().await.is_none());
        assert!(zc.take_stderr().await.is_none());
    }

    #[tokio::test]
    async fn test_state_persistence() {
        let zc = ZaloClient::new("/tmp");
        zc.set_state(ZaloState::Connecting).await;
        assert_eq!(zc.state().await, ZaloState::Connecting);
        zc.set_state(ZaloState::Ready).await;
        assert_eq!(zc.state().await, ZaloState::Ready);
        zc.set_state(ZaloState::NeedLogin).await;
        assert_eq!(zc.state().await, ZaloState::NeedLogin);
        zc.set_state(ZaloState::Error("oops".into())).await;
        assert_eq!(zc.state().await, ZaloState::Error("oops".into()));
    }
}

