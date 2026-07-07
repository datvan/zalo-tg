use crate::zalo::api::friends;
use crate::zalo::api::groups;
use crate::zalo::api::login::{self, ZaloCredentials};
use crate::zalo::api::message;
use crate::zalo::api::message::MentionData;
use crate::zalo::api::ZaloSession;
use crate::zalo::types::ThreadType;
use crate::zalo::ws::{self, WsEvent};
use serde_json::Value;
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
    event_rx: Mutex<Option<mpsc::Receiver<WsEvent>>>,
    shutdown_tx: Mutex<Option<mpsc::Sender<()>>>,
    project_dir: String,
}

impl ZaloClient {
    /// Create a new ZaloClient. Does not connect until `login()` is called.
    pub fn new(project_dir: &str) -> Self {
        Self {
            session: Mutex::new(None),
            state: Mutex::new(ZaloState::Disconnected),
            event_tx: Mutex::new(None),
            event_rx: Mutex::new(None),
            shutdown_tx: Mutex::new(None),
            project_dir: project_dir.to_string(),
        }
    }

    /// Access the project directory.
    pub fn project_dir(&self) -> &str {
        &self.project_dir
    }

    // ── Session management ────────────────────────────────────────────────

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

        self.start_ws_listener().await?;

        *self.state.lock().await = ZaloState::Ready;
        Ok(())
    }

    async fn with_session_async<Fut, R>(&self, f: impl FnOnce(ZaloSession) -> Fut) -> Result<R, String>
    where
        Fut: std::future::Future<Output = Result<R, String>>,
    {
        let session = self.session.lock().await.clone().ok_or("not logged in")?;
        f(session).await
    }

    /// Start the WebSocket event listener in a background task.
    async fn start_ws_listener(&self) -> Result<(), String> {
        let session = self.session.lock().await.clone().ok_or("not logged in")?;
        let (event_tx, event_rx) = mpsc::channel::<WsEvent>(256);
        let event_tx_clone = event_tx.clone();
        let (shutdown_tx, shutdown_rx) = mpsc::channel::<()>(1);

        let ws_urls = session.zpw_ws.clone();
        tokio::spawn(async move {
            let _ = ws::run_listener(session, ws_urls, event_tx_clone, shutdown_rx).await;
        });

        *self.event_tx.lock().await = Some(event_tx);
        *self.event_rx.lock().await = Some(event_rx);
        *self.shutdown_tx.lock().await = Some(shutdown_tx);

        Ok(())
    }

    /// Take the event receiver (can only be called once after login).
    /// The bridge uses this to consume incoming Zalo events.
    pub async fn take_event_receiver(&self) -> Option<mpsc::Receiver<WsEvent>> {
        self.event_rx.lock().await.take()
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

    pub async fn set_state(&self, s: ZaloState) {
        *self.state.lock().await = s;
    }

    // ── Message operations ────────────────────────────────────────────────

    /// Send a text message. Detects thread type automatically (user vs group).
    pub async fn send_message(&self, thread_id: &str, text: &str) -> Result<Value, String> {
        let ttype = detect_thread_type(thread_id);
        self.with_session_async(|session| async move {
            message::send_message(&session, thread_id, text, None, ttype).await
        }).await
    }

    /// Send a message with a quote (reply).
    pub async fn send_quote_message(
        &self,
        thread_id: &str,
        text: &str,
        quote_msg_id: &str,
        quote_cli_msg_id: &str,
        quote_uid_from: &str,
        quote_ts: &str,
        quote_content: &Value,
        quote_msg_type: &str,
    ) -> Result<Value, String> {
        let ttype = detect_thread_type(thread_id);
        self.with_session_async(|session| async move {
            message::send_quote_message(
                &session, thread_id, text,
                quote_msg_id, quote_cli_msg_id,
                quote_uid_from, quote_ts,
                quote_content, quote_msg_type, ttype,
            ).await
        }).await
    }

    /// Send a message with mentions.
    pub async fn send_mention_message(
        &self,
        thread_id: &str,
        text: &str,
        mentions: &[MentionData],
    ) -> Result<Value, String> {
        let ttype = detect_thread_type(thread_id);
        self.with_session_async(|session| async move {
            message::send_mention_message(&session, thread_id, text, mentions, ttype).await
        }).await
    }

    /// Send a reaction to a message.
    pub async fn send_reaction(
        &self,
        msg_id: &str,
        cli_msg_id: &str,
        reaction_type: i64,
        icon: &str,
        thread_id: &str,
    ) -> Result<Value, String> {
        let ttype = detect_thread_type(thread_id);
        self.with_session_async(|session| async move {
            message::add_reaction(&session, msg_id, cli_msg_id, reaction_type, icon, thread_id, ttype).await
        }).await
    }

    /// Simple API for backward compat.
    pub async fn send_reaction_simple(&self, msg_id: &str, rtype: i64) -> Result<Value, String> {
        let session = self.session.lock().await.clone().ok_or("not logged in")?;
        let icon = reaction_icon(rtype);
        message::add_reaction(&session, msg_id, "0", rtype, &icon, "", ThreadType::User).await
    }

    /// Recall/undo a message.
    pub async fn recall_message(&self, msg_id: &str, cli_msg_id: &str, thread_id: &str) -> Result<Value, String> {
        let ttype = detect_thread_type(thread_id);
        self.with_session_async(|session| async move {
            message::undo_message(&session, msg_id, cli_msg_id, thread_id, ttype).await
        }).await
    }

    // ── Info operations ───────────────────────────────────────────────────

    /// Get info for one or more users.
    pub async fn get_user_info(&self, user_ids: &[String]) -> Result<Value, String> {
        self.with_session_async(|session| async move {
            message::get_user_info(&session, user_ids).await
        }).await
    }

    /// Get info for one or more groups.
    pub async fn get_group_info(&self, group_ids: &[String]) -> Result<Value, String> {
        self.with_session_async(|session| async move {
            message::get_group_info(&session, group_ids).await
        }).await
    }

    /// Get all groups the user is a member of.
    pub async fn get_all_groups(&self) -> Result<Value, String> {
        self.with_session_async(|session| async move {
            groups::get_all_groups(&session).await
        }).await
    }

    // ── Friend operations ─────────────────────────────────────────────────

    /// Find a user by phone number.
    pub async fn find_user(&self, phone: &str) -> Result<Value, String> {
        self.with_session_async(|session| async move {
            friends::find_user(&session, phone).await
        }).await
    }

    /// Find a user by username.
    pub async fn find_user_by_username(&self, username: &str) -> Result<Value, String> {
        self.with_session_async(|session| async move {
            friends::find_user_by_username(&session, username).await
        }).await
    }

    /// Get all friends list.
    pub async fn get_all_friends(&self) -> Result<Value, String> {
        self.with_session_async(|session| async move {
            friends::get_all_friends(&session).await
        }).await
    }

    /// Get alias list (contact names).
    pub async fn get_alias_list(&self) -> Result<Value, String> {
        self.with_session_async(|session| async move {
            friends::get_alias_list(&session).await
        }).await
    }

    /// Get friend request status for a user.
    pub async fn get_friend_request_status(&self, user_id: &str) -> Result<Value, String> {
        self.with_session_async(|session| async move {
            friends::get_friend_request_status(&session, user_id).await
        }).await
    }

    /// Send a friend request.
    pub async fn send_friend_request(&self, user_id: &str, msg: &str) -> Result<Value, String> {
        self.with_session_async(|session| async move {
            friends::send_friend_request(&session, user_id, msg).await
        }).await
    }

    /// Get incoming friend recommendations.
    pub async fn get_friend_recommendations(&self) -> Result<Value, String> {
        self.with_session_async(|session| async move {
            friends::get_friend_recommendations(&session).await
        }).await
    }

    /// Get sent friend requests.
    pub async fn get_sent_friend_requests(&self) -> Result<Value, String> {
        self.with_session_async(|session| async move {
            friends::get_sent_friend_requests(&session).await
        }).await
    }

    /// Get group invitation box list.
    pub async fn get_group_invite_box_list(&self) -> Result<Value, String> {
        self.with_session_async(|session| async move {
            friends::get_group_invite_box_list(&session).await
        }).await
    }

    /// Accept a friend request.
    pub async fn accept_friend_request(&self, user_id: &str) -> Result<Value, String> {
        self.with_session_async(|session| async move {
            friends::accept_friend_request(&session, user_id).await
        }).await
    }

    /// Reject a friend request.
    pub async fn reject_friend_request(&self, user_id: &str) -> Result<Value, String> {
        self.with_session_async(|session| async move {
            friends::reject_friend_request(&session, user_id).await
        }).await
    }

    // ── Mute operations ───────────────────────────────────────────────────

    /// Get mute status.
    pub async fn get_mute(&self) -> Result<Value, String> {
        self.with_session_async(|session| async move {
            groups::get_mute(&session).await
        }).await
    }

    /// Set mute for a conversation.
    pub async fn set_mute(&self, thread_id: &str, duration: i64) -> Result<Value, String> {
        let ttype = detect_thread_type(thread_id);
        self.with_session_async(|session| async move {
            groups::set_mute(&session, thread_id, duration, ttype).await
        }).await
    }

    /// Unmute a conversation.
    pub async fn unmute(&self, thread_id: &str) -> Result<Value, String> {
        let ttype = detect_thread_type(thread_id);
        self.with_session_async(|session| async move {
            groups::unmute(&session, thread_id, ttype).await
        }).await
    }

    // ── Backward-compat methods ───────────────────────────────────────────

    pub async fn send_raw(&self, cmd: &Value) -> Result<(), String> {
        let session = self.session.lock().await.clone().ok_or("not logged in")?;
        let ttype = detect_thread_type(cmd["threadId"].as_str().unwrap_or(""));
        match cmd["cmd"].as_str() {
            Some("sendMessage") => {
                let thread_id = cmd["threadId"].as_str().unwrap_or("");
                let text = cmd["text"].as_str().unwrap_or("");
                message::send_message(&session, thread_id, text, None, ttype).await?;
            }
            Some("addReaction") => {
                let msg_id = cmd["msgId"].as_str().unwrap_or("");
                let cli = cmd["cliMsgId"].as_str().unwrap_or("0");
                let rtype = cmd["reactionType"].as_i64().unwrap_or(0);
                let icon_default = reaction_icon(rtype);
                let icon = cmd["icon"].as_str().unwrap_or(&icon_default);
                let thread_id = cmd["threadId"].as_str().unwrap_or("");
                message::add_reaction(&session, msg_id, cli, rtype, icon, thread_id, ttype).await?;
            }
            Some("deleteMessage") | Some("undo") => {
                let msg_id = cmd["msgId"].as_str().unwrap_or("");
                let cli = cmd["cliMsgId"].as_str().unwrap_or("0");
                let thread_id = cmd["threadId"].as_str().unwrap_or("");
                message::undo_message(&session, msg_id, cli, thread_id, ttype).await?;
            }
            Some("getUserInfo") => {
                let uid = cmd["userId"].as_str().unwrap_or("");
                message::get_user_info(&session, &[uid.to_string()]).await?;
            }
            Some("getGroupInfo") => {
                let gid = cmd["groupId"].as_str().unwrap_or("");
                message::get_group_info(&session, &[gid.to_string()]).await?;
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

    /// Legacy methods kept for bridge compat.
    pub async fn trigger_login(&self) -> Result<(), String> {
        Err("use login() with credentials instead".into())
    }

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

/// Detect thread type from thread_id format.
/// Group IDs on Zalo are typically numeric > 10 digits, while user UIDs can be
/// alphanumeric. Heuristic: if it looks like a large number, treat as group.
fn detect_thread_type(thread_id: &str) -> ThreadType {
    if thread_id.is_empty() {
        return ThreadType::User;
    }
    if let Ok(n) = thread_id.parse::<i64>() {
        if n > 9999999999 {
            return ThreadType::Group;
        }
    }
    ThreadType::User
}

/// Map numeric reaction type to icon string.
fn reaction_icon(rtype: i64) -> String {
    match rtype {
        0 => "",
        1 => "\u{1f44d}",
        2 => "\u{1f642}",
        3 => "\u{1f602}",
        4 => "\u{1f62e}",
        5 => "\u{2764}",
        6 => "\u{1f621}",
        7 => "\u{1f618}",
        8 => "\u{1f60d}",
        9 => "\u{1f637}",
        10 => "\u{1f595}",
        11 => "\u{1f44e}",
        12 => "\u{1f44f}",
        _ => "\u{2764}",
    }
    .to_string()
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
    async fn test_send_message_without_login() {
        let zc = ZaloClient::new("/tmp");
        let err = zc.send_message("1", "hi").await.unwrap_err();
        assert!(err.contains("not logged in"));
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
    async fn test_get_all_groups_without_login() {
        let zc = ZaloClient::new("/tmp");
        let err = zc.get_all_groups().await.unwrap_err();
        assert!(err.contains("not logged in"));
    }

    #[tokio::test]
    async fn test_get_all_friends_without_login() {
        let zc = ZaloClient::new("/tmp");
        let err = zc.get_all_friends().await.unwrap_err();
        assert!(err.contains("not logged in"));
    }

    #[tokio::test]
    async fn test_get_mute_without_login() {
        let zc = ZaloClient::new("/tmp");
        let err = zc.get_mute().await.unwrap_err();
        assert!(err.contains("not logged in"));
    }

    #[tokio::test]
    async fn test_send_reaction_without_login() {
        let zc = ZaloClient::new("/tmp");
        let err = zc.send_reaction_simple("msg1", 5).await.unwrap_err();
        assert!(err.contains("not logged in"));
    }

    #[tokio::test]
    async fn test_recall_without_login() {
        let zc = ZaloClient::new("/tmp");
        let err = zc.recall_message("msg1", "0", "thread1").await.unwrap_err();
        assert!(err.contains("not logged in"));
    }

    #[test]
    fn test_detect_thread_type() {
        assert_eq!(detect_thread_type("123"), ThreadType::User);
        assert_eq!(detect_thread_type("12345678901"), ThreadType::Group);
        assert_eq!(detect_thread_type("abc123"), ThreadType::User);
        assert_eq!(detect_thread_type(""), ThreadType::User);
    }

    #[test]
    fn test_reaction_icon_mapping() {
        assert_eq!(reaction_icon(5), "\u{2764}"); // heart
        assert_eq!(reaction_icon(3), "\u{1f602}"); // laugh
        assert_eq!(reaction_icon(99), "\u{2764}"); // default
    }

    #[tokio::test]
    async fn test_legacy_take_none() {
        let zc = ZaloClient::new("/tmp");
        assert!(zc.take_stdin().await.is_none());
        assert!(zc.take_stdout().await.is_none());
        assert!(zc.take_stderr().await.is_none());
    }
}
