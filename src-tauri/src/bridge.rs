use crate::config::BridgeConfig;
use crate::store::Database;
use crate::store::messages::MsgMapEntry;
use crate::store::topics::TopicEntry;
use crate::telegram::client::{ForumTopicCreated, ReactionParam, SendMessageParams, TelegramClient, TgMessageReaction, TgUpdate};
use crate::zalo::api::login::{self as zalo_login, ZaloCredentials};
use crate::zalo::client::{ZaloClient, ZaloState};
use crate::zalo::types::ThreadType;
use crate::zalo::ws::WsEvent;
use serde_json::Value;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
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
    pub running: bool,
    pub pid: Option<u32>,
    pub uptime_secs: Option<u64>,
    pub log_count: usize,
    pub topic_count: usize,
    pub msg_count: usize,
}

/// Shared context for both TG→Zalo and Zalo→TG handlers.
struct BridgeCtx {
    db: Arc<Database>,
    tg: Arc<Mutex<Option<TelegramClient>>>,
    zc: Arc<ZaloClient>,
    logs: LogBuf,
    tg_group_id: i64,
    #[allow(dead_code)]
    skip_muted_groups: bool,
    mute_silent: bool,
    /// In-flight Zalo message IDs to suppress self-echo (10s TTL).
    inflight: Arc<Mutex<Vec<(String, Instant)>>>,
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

    pub fn db(&self) -> &Database { &self.db }

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

        let creds = match load_credentials(config.zalo_credentials_path.as_deref()) {
            Ok(c) => c,
            Err(e) => {
                *self.state.lock().await = BridgeState::Error(e.clone());
                return Err(e);
            }
        };

        let zc = self.zc.clone();
        if let Err(e) = zc.login(&creds).await {
            let msg = format!("zalo login: {e}");
            *self.state.lock().await = BridgeState::Error(msg.clone());
            return Err(msg);
        }

        *self.started_at.lock().await = Some(Instant::now());
        *self.state.lock().await = BridgeState::Running;

        log_line(&self.logs, "[BRIDGE] Bridge started — Zalo connected".into()).await;

        // ── Zalo→TG event consumer ─────────────────────────────────────────
        let event_rx = zc.take_event_receiver().await;
        let ctx = Arc::new(BridgeCtx {
            db: self.db.clone(),
            tg: self.tg_client.clone(),
            zc: zc.clone(),
            logs: self.logs.clone(),
            tg_group_id: config.tg_group_id,
            skip_muted_groups: config.skip_muted_groups,
            mute_silent: config.mute_silent,
            inflight: Arc::new(Mutex::new(Vec::new())),
        });

        if let Some(mut rx) = event_rx {
            let ctx2 = ctx.clone();
            tokio::spawn(async move {
                log_line(&ctx2.logs, "[WS] Event listener started".into()).await;
                while let Some(event) = rx.recv().await {
                    handle_zalo_event(&ctx2, event).await;
                }
                log_line(&ctx2.logs, "[WS] Event listener stopped".into()).await;
            });
        }

        // ── TG→Zalo polling loop ───────────────────────────────────────────
        let tgc = self.tg_client.clone();
        let tgo = self.tg_offset.clone();
        let ctx3 = ctx.clone();
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
                            handle_tg_update(&ctx3, &u).await;
                        }
                        *tgo.lock().await = max_id;
                    }
                    Err(e) => {
                        log_line(&ctx3.logs, format!("[TG] polling error: {e}")).await;
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
        *self.tg_client.lock().await = None;
        *self.state.lock().await = BridgeState::Stopped;
        log_line(&self.logs, "[BRIDGE] Bridge stopped".into()).await;
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
            running,
            pid,
            uptime_secs: uptime,
            log_count: self.logs.lock().await.len(),
            topic_count: self.db.topic_count(),
            msg_count: self.db.msg_map_count(),
        }
    }

    pub fn zalo_client(&self) -> Arc<ZaloClient> { self.zc.clone() }

    pub async fn send_stdin(&self, cmd: &str) -> Result<(), String> {
        let val: Value = serde_json::from_str(cmd).map_err(|e| format!("parse cmd: {e}"))?;
        self.zc.send_raw(&val).await
    }

    pub async fn get_logs(&self, limit: usize) -> Vec<LogEntry> {
        let logs = self.logs.lock().await;
        let len = logs.len();
        if len <= limit { logs.clone() } else { logs[len - limit..].to_vec() }
    }
}

fn load_credentials(path: Option<&std::path::Path>) -> Result<ZaloCredentials, String> {
    let creds_path = path.unwrap_or(std::path::Path::new("credentials.json"));
    let content = std::fs::read_to_string(creds_path)
        .map_err(|e| format!("read credentials: {e}"))?;
    let json: Value = serde_json::from_str(&content)
        .map_err(|e| format!("parse credentials: {e}"))?;
    zalo_login::parse_credentials(&json)
}

// ═══════════════════════════════════════════════════════════════════════════
// Zalo → Telegram
// ═══════════════════════════════════════════════════════════════════════════

async fn handle_zalo_event(ctx: &BridgeCtx, event: WsEvent) {
    match event {
        WsEvent::Message(msgs) => {
            let arr = msg_array(&msgs);
            for m in arr { forward_zalo_to_tg(ctx, &m, false).await; }
        }
        WsEvent::GroupMessage(msgs) => {
            let arr = msg_array(&msgs);
            for m in arr { forward_zalo_to_tg(ctx, &m, true).await; }
        }
        WsEvent::Reaction(data) => handle_zalo_reaction(ctx, &data).await,
        WsEvent::GroupReaction(data) => handle_zalo_reaction(ctx, &data).await,
        WsEvent::Undo { msg_id, thread_id, is_group, data } => {
            handle_zalo_undo(ctx, &msg_id, &thread_id, is_group, &data).await;
        }
        WsEvent::GroupEvent { event_type, group_id, data } => {
            handle_group_event(ctx, &event_type, &group_id, &data).await;
        }
        WsEvent::FriendEvent { event_type, data: _ } => {
            log_line(&ctx.logs, format!("[ZALO] friend event: {event_type}")).await;
        }
        WsEvent::Typing { thread_id, is_group } => {
            log_line(&ctx.logs, format!("[ZALO] typing: {thread_id} ({})", if is_group { "group" } else { "dm" })).await;
        }
        WsEvent::Seen { thread_id, msg_ids } => {
            log_line(&ctx.logs, format!("[ZALO] seen: {thread_id} msgs={:?}", msg_ids)).await;
        }
        WsEvent::OldMessages { messages, is_group } => {
            log_line(&ctx.logs, format!("[ZALO] old messages: {} msgs ({})", messages.len(), if is_group { "group" } else { "dm" })).await;
            for m in messages {
                forward_zalo_to_tg(ctx, &m, is_group).await;
            }
        }
        WsEvent::OldReactions { reactions, is_group } => {
            log_line(&ctx.logs, format!("[ZALO] old reactions: {} ({})", reactions.len(), if is_group { "group" } else { "dm" })).await;
        }
        WsEvent::Disconnected { code, reason } => {
            log_line(&ctx.logs, format!("[WS] Disconnected: code={code} reason={reason}")).await;
        }
        WsEvent::Other { cmd, sub_cmd, data: _ } => {
            log_line(&ctx.logs, format!("[WS] cmd={cmd} sub_cmd={sub_cmd} (unhandled)")).await;
        }
    }
}

fn msg_array(v: &Value) -> Vec<Value> {
    if let Some(arr) = v.as_array() {
        arr.clone()
    } else {
        vec![v.clone()]
    }
}

async fn forward_zalo_to_tg(ctx: &BridgeCtx, msg: &Value, is_group: bool) {
    let data = &msg["data"];
    let content = data["content"].as_str().unwrap_or("");
    let msg_id = str_or_i64(&data["msgId"]);
    let uid_from = data["uidFrom"].as_str().unwrap_or("");
    let dname = data["dName"].as_str().unwrap_or("Unknown");
    let thread_id = if is_group { data["idTo"].as_str().unwrap_or("") } else { uid_from };
    let msg_type = data["msgType"].as_str().unwrap_or("webchat");

    if content.is_empty() && msg_type == "webchat" { return; }

    if is_inflight(ctx, &msg_id).await {
        log_line(&ctx.logs, format!("[ZALO] echo suppressed: {msg_id}")).await;
        return;
    }

    if !uid_from.is_empty() && !dname.is_empty() {
        let _ = ctx.db.upsert_user(uid_from, dname);
    }

    let thread_type = if is_group { ThreadType::Group } else { ThreadType::User };

    let topic_id = match get_or_create_topic(ctx, thread_id, thread_type, dname).await {
        Ok(id) => id,
        Err(e) => {
            log_line(&ctx.logs, format!("[TG] topic create error: {e}")).await;
            return;
        }
    };

    let display_name = ctx.db.get_user_name(uid_from).unwrap_or_else(|| dname.to_string());
    let (text, parse_mode) = format_zalo_message(&display_name, content, msg_type);
    let disable_notif = ctx.mute_silent;

    let tg = ctx.tg.lock().await;
    if let Some(ref client) = *tg {
        let params = SendMessageParams {
            chat_id: ctx.tg_group_id,
            text,
            parse_mode,
            message_thread_id: Some(topic_id),
            reply_to_message_id: None,
            disable_notification: if disable_notif { Some(true) } else { None },
            reply_markup: None,
        };
        match client.send_message(&params).await {
            Ok(resp) => {
                let _ = ctx.db.insert_msg_map(&MsgMapEntry {
                    zalo_msg_id: msg_id.clone(),
                    tg_msg_id: resp.message_id,
                    zalo_id: thread_id.to_string(),
                    thread_type: thread_type as i64,
                    uid_from: uid_from.to_string(),
                    ts: data["ts"].as_i64().map(|n| n.to_string()).unwrap_or_default(),
                    msg_type: msg_type.to_string(),
                    content: content.to_string(),
                    ttl: data["ttl"].as_i64().unwrap_or(0),
                });
                log_line(&ctx.logs, format!("[Z→T] {}: {} → topic {}", trunc_str(content, 50), display_name, topic_id)).await;
            }
            Err(e) => log_line(&ctx.logs, format!("[TG] send error: {e}")).await,
        }
    }
}

async fn handle_zalo_reaction(ctx: &BridgeCtx, data: &Value) {
    let content = &data["content"];
    let ricon = content["rIcon"].as_str().unwrap_or("");
    let msg_id = str_or_i64(&content["msgId"]);
    if msg_id.is_empty() { return; }

    let tg_msg_id = match ctx.db.get_tg_msg_id(&msg_id) {
        Some(id) => id,
        None => {
            log_line(&ctx.logs, format!("[ZALO] reaction for unknown msg: {msg_id}")).await;
            return;
        }
    };

    let emoji = map_zalo_reaction_to_tg(ricon);
    let reaction = Some(vec![ReactionParam {
        reaction_type: "emoji".into(),
        emoji: emoji.into(),
    }]);

    let tg = ctx.tg.lock().await;
    if let Some(ref client) = *tg {
        match client.set_message_reaction(ctx.tg_group_id, tg_msg_id, reaction).await {
            Ok(_) => log_line(&ctx.logs, format!("[Z→T] reaction {ricon} on msg {msg_id}")).await,
            Err(e) => log_line(&ctx.logs, format!("[TG] reaction error: {e}")).await,
        }
    }
}

/// Handle a Zalo message recall/undo event — delete or edit the TG message.
async fn handle_zalo_undo(ctx: &BridgeCtx, msg_id: &str, thread_id: &str, is_group: bool, _data: &Value) {
    let tg_msg_id = match ctx.db.get_tg_msg_id(msg_id) {
        Some(id) => id,
        None => {
            log_line(&ctx.logs, format!("[ZALO] undo for unknown msg: {msg_id}")).await;
            return;
        }
    };

    let tg = ctx.tg.lock().await;
    if let Some(ref client) = *tg {
        match client.delete_message(ctx.tg_group_id, tg_msg_id).await {
            Ok(_) => {
                let _ = ctx.db.delete_msg_map_by_zalo(msg_id);
                log_line(&ctx.logs, format!("[Z→T] undo: deleted TG msg {tg_msg_id} for {} {}",
                    if is_group { "group" } else { "dm" }, thread_id)).await;
            }
            Err(e) => log_line(&ctx.logs, format!("[TG] delete error: {e}")).await,
        }
    }
}

/// Handle a Zalo group lifecycle event.
async fn handle_group_event(ctx: &BridgeCtx, event_type: &str, group_id: &str, data: &Value) {
    match event_type {
        "join" => {
            let member = data["event"]["memberId"]
                .as_str().or_else(|| data["memberId"].as_str())
                .unwrap_or("someone");
            log_line(&ctx.logs, format!("[ZALO] group {group_id}: {member} joined")).await;
        }
        "leave" => {
            let member = data["event"]["memberId"]
                .as_str().or_else(|| data["memberId"].as_str())
                .unwrap_or("someone");
            log_line(&ctx.logs, format!("[ZALO] group {group_id}: {member} left")).await;
        }
        "remove_member" | "block_member" => {
            let member = data["event"]["memberId"]
                .as_str().or_else(|| data["memberId"].as_str())
                .unwrap_or("someone");
            log_line(&ctx.logs, format!("[ZALO] group {group_id}: {member} removed ({event_type})")).await;
        }
        "update" | "update_setting" => {
            log_line(&ctx.logs, format!("[ZALO] group {group_id}: {event_type}")).await;
        }
        "update_board" | "remove_board" => {
            // Poll-related board update
            log_line(&ctx.logs, format!("[ZALO] group {group_id}: board {event_type}")).await;
        }
        "join_request" => {
            let member = data["event"]["memberId"]
                .as_str().or_else(|| data["memberId"].as_str())
                .unwrap_or("someone");
            log_line(&ctx.logs, format!("[ZALO] group {group_id}: join request from {member}")).await;
        }
        _ => {
            log_line(&ctx.logs, format!("[ZALO] group {group_id}: {event_type}")).await;
        }
    }
}

async fn get_or_create_topic(
    ctx: &BridgeCtx,
    zalo_id: &str,
    thread_type: ThreadType,
    fallback_name: &str,
) -> Result<i64, String> {
    if let Some(entry) = ctx.db.get_topic_by_zalo(zalo_id, thread_type as i64) {
        return Ok(entry.topic_id);
    }

    let tg = ctx.tg.lock().await;
    let client = tg.as_ref().ok_or("no tg client")?;
    let prefix = if thread_type == ThreadType::Group { "👥 " } else { "👤 " };
    let name = format!("{}{}", prefix, fallback_name);

    match client.create_forum_topic(ctx.tg_group_id, &name).await {
        Ok(resp) => {
            let topic_id = resp.message_thread_id;
            let _ = ctx.db.upsert_topic(&TopicEntry {
                topic_id,
                zalo_id: zalo_id.to_string(),
                thread_type: thread_type as i64,
                name: fallback_name.to_string(),
            });
            log_line(&ctx.logs, format!("[TG] Created topic {topic_id} for {zalo_id}")).await;
            Ok(topic_id)
        }
        Err(e) => {
            log_line(&ctx.logs, format!("[TG] topic create failed (using general): {e}")).await;
            let _ = ctx.db.upsert_topic(&TopicEntry {
                topic_id: 1,
                zalo_id: zalo_id.to_string(),
                thread_type: thread_type as i64,
                name: fallback_name.to_string(),
            });
            Ok(1)
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Telegram → Zalo
// ═══════════════════════════════════════════════════════════════════════════

async fn handle_tg_update(ctx: &BridgeCtx, update: &TgUpdate) {
    if let Some(ref msg) = update.message {
        let text = msg.text.as_deref().unwrap_or("");
        let user_name = msg.from.as_ref().map(|u| u.first_name.as_str()).unwrap_or("?");
        let topic_id = msg.message_thread_id.unwrap_or(0);

        if text.starts_with('/') {
            handle_tg_command(ctx, msg, text).await;
            return;
        }

        if text.is_empty() { return; }

        log_line(&ctx.logs, format!("[TG] #{} topic={} {}: {}", msg.chat.id, topic_id, user_name, trunc_str(text, 50))).await;

        match resolve_zalo_from_topic(ctx, topic_id).await {
            Some((zalo_id, thread_type)) => {
                match ctx.zc.send_message(&zalo_id, text).await {
                    Ok(resp) => {
                        let zalo_msg_id = resp.get("data")
                            .and_then(|d| d.get("msgId"))
                            .map(str_or_i64)
                            .unwrap_or_default();
                        if !zalo_msg_id.is_empty() {
                            mark_inflight(ctx, &zalo_msg_id).await;
                            let _ = ctx.db.insert_msg_map(&MsgMapEntry {
                                zalo_msg_id: zalo_msg_id.clone(),
                                tg_msg_id: msg.message_id,
                                zalo_id: zalo_id.clone(),
                                thread_type: thread_type as i64,
                                uid_from: String::new(),
                                ts: now_secs_str(),
                                msg_type: "webchat".into(),
                                content: text.to_string(),
                                ttl: 0,
                            });
                        }
                        log_line(&ctx.logs, format!("[T→Z] {} → {} ({})", trunc_str(text, 50), zalo_id,
                            if thread_type == ThreadType::Group { "group" } else { "user" })).await;
                    }
                    Err(e) => log_line(&ctx.logs, format!("[ZALO] send error: {e}")).await,
                }
            }
            None => log_line(&ctx.logs, format!("[TG] no Zalo thread for topic {topic_id}")).await,
        }
    }

    if let Some(ref cq) = update.callback_query {
        if let Some(ref data) = cq.data {
            log_line(&ctx.logs, format!("[TG] callback: {data}")).await;
            let tg = ctx.tg.lock().await;
            if let Some(ref client) = *tg {
                let _ = client.answer_callback_query(&cq.id, None).await;
            }
        }
    }

    if let Some(ref reaction) = update.message_reaction {
        handle_tg_reaction(ctx, reaction).await;
    }
}

async fn handle_tg_command(ctx: &BridgeCtx, msg: &crate::telegram::client::TgMessage, text: &str) {
    let cmd = text.split(' ').next().unwrap_or(text);
    let topic_id = msg.message_thread_id.unwrap_or(0);

    let tg = ctx.tg.lock().await;
    if let Some(ref client) = *tg {
        let reply = match cmd {
            "/status" | "/start" => {
                let state = ctx.zc.state().await;
                format!("🟢 Bridge status: {:?}\n📊 Topics: {} | Messages: {}",
                    state, ctx.db.topic_count(), ctx.db.msg_map_count())
            }
            "/help" => {
                "📖 Commands:\n/status — Show bridge status\n/help — Show this help".into()
            }
            _ => {
                log_line(&ctx.logs, format!("[TG] unhandled command: {cmd}")).await;
                return;
            }
        };
        let params = SendMessageParams {
            chat_id: msg.chat.id,
            text: reply,
            parse_mode: None,
            message_thread_id: Some(topic_id),
            reply_to_message_id: None,
            disable_notification: None,
            reply_markup: None,
        };
        let _ = client.send_message(&params).await;
    }
}

async fn handle_tg_reaction(ctx: &BridgeCtx, reaction: &TgMessageReaction) {
    let tg_msg_id = reaction.message_id;
    let emoji = reaction.new_reaction.first()
        .and_then(|r| r.emoji.as_ref())
        .map(|e| e.as_str())
        .unwrap_or("");
    if emoji.is_empty() { return; }

    let zalo_msg = match ctx.db.get_zalo_msg(tg_msg_id) {
        Some(m) => m,
        None => {
            log_line(&ctx.logs, format!("[TG] reaction on unknown msg: {tg_msg_id}")).await;
            return;
        }
    };

    let (rtype, icon) = map_tg_reaction_to_zalo(emoji);
    if let Err(e) = ctx.zc.send_reaction(&zalo_msg.zalo_msg_id, "0", rtype, &icon, &zalo_msg.zalo_id).await {
        log_line(&ctx.logs, format!("[ZALO] reaction error: {e}")).await;
    } else {
        log_line(&ctx.logs, format!("[T→Z] reaction {emoji} on msg {}", zalo_msg.zalo_msg_id)).await;
    }
}

async fn resolve_zalo_from_topic(ctx: &BridgeCtx, topic_id: i64) -> Option<(String, ThreadType)> {
    let entry = ctx.db.get_topic_by_id(topic_id)?;
    let ttype = ThreadType::from_i64(entry.thread_type);
    Some((entry.zalo_id, ttype))
}

// ═══════════════════════════════════════════════════════════════════════════
// In-flight tracking
// ═══════════════════════════════════════════════════════════════════════════

async fn is_inflight(ctx: &BridgeCtx, msg_id: &str) -> bool {
    let mut guard = ctx.inflight.lock().await;
    let now = Instant::now();
    guard.retain(|(_, t)| now.duration_since(*t) < Duration::from_secs(10));
    guard.iter().any(|(id, _)| id == msg_id)
}

async fn mark_inflight(ctx: &BridgeCtx, msg_id: &str) {
    let mut guard = ctx.inflight.lock().await;
    let now = Instant::now();
    guard.retain(|(_, t)| now.duration_since(*t) < Duration::from_secs(10));
    guard.push((msg_id.to_string(), now));
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

fn format_zalo_message(sender: &str, content: &str, msg_type: &str) -> (String, Option<String>) {
    let s = escape_html(sender);
    let c = escape_html(content);
    let text = match msg_type {
        "webchat" => format!("<b>{s}</b>\n{c}"),
        "chat.photo" => format!("<b>{s}</b> 📸 [Photo]"),
        "chat.video.msg" => format!("<b>{s}</b> 🎬 [Video]"),
        "chat.voice" => format!("<b>{s}</b> 🎤 [Voice]"),
        "chat.sticker" | "chat.doodle" => format!("<b>{s}</b> 🎨 [Sticker]"),
        "share.file" => format!("<b>{s}</b> 📎 [File]"),
        "chat.recommended" => format!("<b>{s}</b> 🔗 {}", if c.is_empty() { "[Link]" } else { &c }),
        _ => format!("<b>{s}</b> [{msg_type}]"),
    };
    (text, Some("HTML".into()))
}

fn map_zalo_reaction_to_tg(icon: &str) -> &'static str {
    match icon {
        "/-heart" | "❤" | "❤️" => "❤️",
        "/-strong" | "👍" => "👍",
        "/-wow" | ":o" | "😮" => "😮",
        "/-laugh" | ":>" | "😆" => "😂",
        "/-sad" | ":<" | "😢" => "😢",
        _ => "👍",
    }
}

fn map_tg_reaction_to_zalo(emoji: &str) -> (i64, String) {
    match emoji {
        "❤️" | "❤" => (5, "❤".into()),
        "👍" => (1, "👍".into()),
        "👎" => (11, "👎".into()),
        "😂" | "😆" => (3, "😂".into()),
        "😮" | "😯" => (4, "😮".into()),
        "😢" | "😭" => (0, "😢".into()),
        "🔥" | "🎉" => (12, "👏".into()),
        _ => (5, "❤".into()),
    }
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn trunc_str(s: &str, n: usize) -> String {
    if s.len() <= n { s.to_string() } else { format!("{}…", &s[..n]) }
}

fn str_or_i64(v: &Value) -> String {
    if let Some(s) = v.as_str() {
        s.to_string()
    } else if let Some(n) = v.as_i64() {
        n.to_string()
    } else {
        String::new()
    }
}

fn now_secs_str() -> String {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs().to_string()
}

async fn log_line(logs: &LogBuf, line: String) {
    let mut guard = logs.lock().await;
    if guard.len() >= 1000 { guard.remove(0); }
    guard.push(LogEntry { timestamp: now_str(), level: infer_level(&line), text: line });
}

fn now_str() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    format!("{:02}:{:02}:{:02}", (secs / 3600) % 24, (secs / 60) % 60, secs % 60)
}

fn infer_level(line: &str) -> String {
    if line.contains("error") || line.contains("Error") || line.contains("ERR") { "ERROR".into() }
    else if line.contains("warn") || line.contains("WARN") { "WARN".into() }
    else { "INFO".into() }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_webchat() {
        let (text, parse) = format_zalo_message("Alice", "Hello", "webchat");
        assert!(text.contains("<b>Alice</b>"));
        assert!(text.contains("Hello"));
        assert_eq!(parse.as_deref(), Some("HTML"));
    }

    #[test]
    fn test_format_photo() {
        let (text, _) = format_zalo_message("Bob", "", "chat.photo");
        assert!(text.contains("📸") && text.contains("Bob"));
    }

    #[test]
    fn test_format_unknown() {
        let (text, _) = format_zalo_message("Bob", "", "custom.x");
        assert!(text.contains("[custom.x]"));
    }

    #[test]
    fn test_escape_html() {
        assert_eq!(escape_html("<b>"), "&lt;b&gt;");
    }

    #[test]
    fn test_trunc() {
        assert_eq!(trunc_str("hello", 10), "hello");
        assert_eq!(trunc_str("hello world", 5), "hello…");
    }

    #[test]
    fn test_reaction_maps() {
        assert_eq!(map_zalo_reaction_to_tg("/-heart"), "❤️");
        assert_eq!(map_zalo_reaction_to_tg("/-strong"), "👍");
        assert_eq!(map_zalo_reaction_to_tg("unknown"), "👍");
        let (t, i) = map_tg_reaction_to_zalo("❤️");
        assert_eq!(t, 5); assert_eq!(i, "❤");
        let (t, _) = map_tg_reaction_to_zalo("👍");
        assert_eq!(t, 1);
    }

    #[test]
    fn test_infer_level() {
        assert_eq!(infer_level("error here"), "ERROR");
        assert_eq!(infer_level("warning"), "WARN");
        assert_eq!(infer_level("normal"), "INFO");
    }

    #[tokio::test]
    async fn test_inflight() {
        let db = crate::store::Database::open_in_memory().unwrap();
        let zc = Arc::new(ZaloClient::new("."));
        let ctx = BridgeCtx {
            db: Arc::new(db), tg: Arc::new(Mutex::new(None)), zc,
            logs: Arc::new(Mutex::new(Vec::new())),
            tg_group_id: -100, skip_muted_groups: false, mute_silent: false,
            inflight: Arc::new(Mutex::new(Vec::new())),
        };
        assert!(!is_inflight(&ctx, "m1").await);
        mark_inflight(&ctx, "m1").await;
        assert!(is_inflight(&ctx, "m1").await);
        assert!(!is_inflight(&ctx, "m2").await);
    }
}
