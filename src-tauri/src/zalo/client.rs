use crate::zalo::api::login::{self, ZaloCredentials};
use crate::zalo::api::message;
use crate::zalo::api::ZaloSession;
use crate::zalo::ws::{self, WsEvent};
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};

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
    session: Mutex<Option<ZaloSession>>,
    state: Mutex<ZaloState>,
    event_tx: Mutex<Option<mpsc::Sender<WsEvent>>>,
    shutdown_tx: Mutex<Option<mpsc::Sender<()>>>,
    _worker_path: String,
}

impl ZaloClient {
    /// Create a new ZaloClient. Does not connect until `login()` is called.
    pub fn new(project_dir: &str) -> Self {
        Self {
            session: Mutex::new(None),
            state: Mutex::new(ZaloState::Disconnected),
            event_tx: Mutex::new(None),
            shutdown_tx: Mutex::new(None),
            _worker_path: project_dir.to_string(),
        }
    }

    /// Login to Zalo with saved credentials and start listening for events.
    pub async fn login(&self, credentials: &ZaloCredentials) -> Result<(), String> {
        *self.state.lock().await = ZaloState::Connecting;

        let session = match login::login(credentials).await {
            Ok(s) => s,
            Err(e) => {
                *self.state.lock().await = ZaloState::Error(e.clone());
                return Err(e);
            }
        };

        *self.session.lock().await = Some(session);

        // Start WebSocket listener
        self.start_ws_listener().await?;

        *self.state.lock().await = ZaloState::Ready;
        Ok(())
    }

    /// Start the WebSocket event listener in a background task.
    async fn start_ws_listener(&self) -> Result<(), String> {
        let session = self
            .session
            .lock()
            .await
            .clone()
            .ok_or("not logged in")?;
        let (event_tx, _event_rx) = mpsc::channel::<WsEvent>(256);
        let event_tx_clone = event_tx.clone();
        let (shutdown_tx, shutdown_rx) = mpsc::channel::<()>(1);

        let ws_urls = session.zpw_ws.clone();
        tokio::spawn(async move {
            let _ = ws::run_listener(session, ws_urls, event_tx_clone, shutdown_rx).await;
        });

        *self.event_tx.lock().await = Some(event_tx);
        *self.shutdown_tx.lock().await = Some(shutdown_tx);
        // event_rx can be obtained via take_event_rx()

        Ok(())
    }

    /// Stop the client: disconnect WebSocket and clear session.
    pub async fn stop(&self) -> Result<(), String> {
        if let Some(shutdown) = self.shutdown_tx.lock().await.take() {
            let _ = shutdown.send(()).await;
        }
        *self.event_tx.lock().await = None;
        *self.session.lock().await = None;
        *self.state.lock().await = ZaloState::Disconnected;
        Ok(())
    }

    /// Current connection state.
    pub async fn state(&self) -> ZaloState {
        self.state.lock().await.clone()
    }

    /// Set state (used by bridge layer).
    pub async fn set_state(&self, s: ZaloState) {
        *self.state.lock().await = s;
    }

    /// Send a raw JSON command to the zalo-worker (kept for backward compat).
    pub async fn send_raw(&self, cmd: &Value) -> Result<(), String> {
        match cmd["cmd"].as_str() {
            Some("sendMessage") => {
                let thread_id = cmd["threadId"].as_str().unwrap_or("");
                let text = cmd["text"].as_str().unwrap_or("");
                self.send_message(thread_id, text).await?;
            }
            Some("addReaction") => {
                let msg_id = cmd["msgId"].as_str().unwrap_or("");
                let rtype = cmd["reactionType"].as_i64().unwrap_or(0);
                self.send_reaction(msg_id, rtype).await?;
            }
            Some("deleteMessage") => {
                let msg_id = cmd["msgId"].as_str().unwrap_or("");
                self.recall_message(msg_id).await?;
            }
            Some("getUserInfo") => {
                let user_id = cmd["userId"].as_str().unwrap_or("");
                self.get_user_info(user_id).await?;
            }
            Some("getGroupInfo") => {
                let group_id = cmd["groupId"].as_str().unwrap_or("");
                self.get_group_info(group_id).await?;
            }
            Some("login") => {
                return Err("use login() method instead".into());
            }
            _ => {
                return Err(format!("unknown cmd: {:?}", cmd["cmd"]));
            }
        }
        Ok(())
    }

    /// Send a text message to a thread.
    pub async fn send_message(&self, thread_id: &str, text: &str) -> Result<Value, String> {
        let session = self
            .session
            .lock()
            .await
            .as_ref()
            .ok_or("not logged in")?
            .clone();
        message::send_message(&session, thread_id, text, None).await
    }

    /// Send a text message with type.
    pub async fn send_message_with_type(
        &self,
        thread_id: &str,
        text: &str,
        msg_type: &str,
    ) -> Result<Value, String> {
        let session = self
            .session
            .lock()
            .await
            .as_ref()
            .ok_or("not logged in")?
            .clone();
        message::send_message(&session, thread_id, text, Some(msg_type)).await
    }

    /// Send a reaction to a message.
    pub async fn send_reaction(&self, _msg_id: &str, _reaction_type: i64) -> Result<Value, String> {
        let _session = self.session.lock().await.as_ref().ok_or("not logged in")?.clone();
        // TODO: implement api/message.rs addReaction endpoint
        Err("reaction not yet implemented in native client".into())
    }

    /// Recall/delete a message.
    pub async fn recall_message(&self, _msg_id: &str) -> Result<Value, String> {
        let _session = self.session.lock().await.as_ref().ok_or("not logged in")?.clone();
        // TODO: implement api/message.rs deleteMessage endpoint
        Err("recall not yet implemented in native client".into())
    }

    /// Get user info.
    pub async fn get_user_info(&self, _user_id: &str) -> Result<Value, String> {
        let _session = self.session.lock().await.as_ref().ok_or("not logged in")?.clone();
        Err("getUserInfo not yet implemented in native client".into())
    }

    /// Get group info.
    pub async fn get_group_info(&self, _group_id: &str) -> Result<Value, String> {
        let _session = self.session.lock().await.as_ref().ok_or("not logged in")?.clone();
        Err("getGroupInfo not yet implemented in native client".into())
    }

    /// Trigger login via zalo-worker (in native mode, login is done via `login()`).
    pub async fn trigger_login(&self) -> Result<(), String> {
        Err("use login() with credentials instead".into())
    }

    // ── Legacy subprocess stubs (kept for bridge.rs compat during transition) ──

    /// Old start method — no-op in native mode. Use `login()` instead.
    pub async fn start(&self) -> Result<(), String> {
        Ok(())
    }

    pub async fn child_id(&self) -> Option<u32> {
        None
    }

    pub async fn try_wait(&self) -> Option<std::process::ExitStatus> {
        None
    }

    pub async fn take_stdin(&self) -> Option<tokio::process::ChildStdin> {
        None
    }

    pub async fn take_stdout(&self) -> Option<tokio::process::ChildStdout> {
        None
    }

    pub async fn take_stderr(&self) -> Option<tokio::process::ChildStderr> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_new_client_disconnected() {
        let zc = ZaloClient::new("/tmp");
        assert_eq!(zc.state().await, ZaloState::Disconnected);
    }

    #[tokio::test]
    async fn test_stop_without_start() {
        let zc = ZaloClient::new("/tmp");
        zc.stop().await.expect("stop unstarted");
        assert_eq!(zc.state().await, ZaloState::Disconnected);
    }

    #[tokio::test]
    async fn test_send_raw_without_login() {
        let zc = ZaloClient::new("/tmp");
        let cmd = serde_json::json!({"cmd": "sendMessage", "threadId": "1", "text": "hi"});
        let err = zc.send_raw(&cmd).await.unwrap_err();
        assert!(err.contains("not logged in"));
    }

    #[tokio::test]
    async fn test_trigger_login_unsupported() {
        let zc = ZaloClient::new("/tmp");
        let err = zc.trigger_login().await.unwrap_err();
        assert!(err.contains("use login() with credentials"));
    }

    #[tokio::test]
    async fn test_legacy_start_noop() {
        let zc = ZaloClient::new("/tmp");
        assert!(zc.start().await.is_ok());
        assert_eq!(zc.state().await, ZaloState::Disconnected);
    }

    #[tokio::test]
    async fn test_legacy_take_none() {
        let zc = ZaloClient::new("/tmp");
        assert!(zc.take_stdin().await.is_none());
        assert!(zc.take_stdout().await.is_none());
        assert!(zc.take_stderr().await.is_none());
    }
}
