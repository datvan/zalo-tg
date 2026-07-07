use crate::zalo::api::ZaloSession;
use crate::zalo::crypto;
use flate2::read::ZlibDecoder;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::io::Read;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

/// WebSocket event types received from Zalo.
#[derive(Debug, Clone)]
pub enum WsEvent {
    /// Direct message (cmd 501).
    Message(Value),
    /// Group message (cmd 521).
    GroupMessage(Value),
    /// DM reaction (cmd 610).
    Reaction(Value),
    /// Group reaction (cmd 611).
    GroupReaction(Value),
    /// Message recall/undo — DM (cmd 312) or Group (cmd 322).
    Undo { msg_id: String, thread_id: String, is_group: bool, data: Value },
    /// Group lifecycle event (cmd 3001): join, leave, update, etc.
    GroupEvent { event_type: String, group_id: String, data: Value },
    /// Friend event (cmd 3101): friend request, etc.
    FriendEvent { event_type: String, data: Value },
    /// Typing indicator (cmd 801).
    Typing { thread_id: String, is_group: bool },
    /// Message seen/read receipt (cmd 802).
    Seen { thread_id: String, msg_ids: Vec<String> },
    /// Old messages catch-up (cmd 701).
    OldMessages { messages: Vec<Value>, is_group: bool },
    /// Old reactions catch-up (cmd 702).
    OldReactions { reactions: Vec<Value>, is_group: bool },
    /// WebSocket disconnected.
    Disconnected { code: u16, reason: String },
    /// Any unhandled cmd.
    Other { cmd: i32, sub_cmd: u8, data: Value },
}

/// Run the WebSocket listener with automatic reconnection.
/// Connects to Zalo's WS, handles auth handshake, decodes binary frames,
/// and sends structured events via `tx`. Reconnects with exponential backoff.
/// Exits when `shutdown` receives a message.
pub async fn run_listener(
    _session: ZaloSession,
    ws_urls: Vec<String>,
    tx: mpsc::Sender<WsEvent>,
    mut shutdown: mpsc::Receiver<()>,
) -> Result<(), String> {
    let mut backoff_secs: u64 = 1;
    const MAX_BACKOFF: u64 = 60;

    loop {
        match connect_and_listen(&ws_urls, &tx, &mut shutdown).await {
            Ok(()) => {
                // Normal shutdown
                break;
            }
            Err(e) => {
                let _ = tx.send(WsEvent::Disconnected {
                    code: 1006,
                    reason: format!("{e} — reconnecting in {backoff_secs}s"),
                }).await;

                // Wait before reconnect or shutdown
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(backoff_secs)) => {}
                    _ = shutdown.recv() => break,
                }
                backoff_secs = (backoff_secs * 2).min(MAX_BACKOFF);
            }
        }
    }
    Ok(())
}

/// Connect once and listen until disconnect or shutdown.
async fn connect_and_listen(
    ws_urls: &[String],
    tx: &mpsc::Sender<WsEvent>,
    shutdown: &mut mpsc::Receiver<()>,
) -> Result<(), String> {
    let url = pick_url(ws_urls);
    let request = url
        .into_client_request()
        .map_err(|e| format!("build req: {e}"))?;

    let (ws_stream, _) = connect_async(request)
        .await
        .map_err(|e| format!("ws connect: {e}"))?;

    let (mut write, mut read) = ws_stream.split();
    let mut cipher_key: Option<String> = None;
    let mut pinged = false;

    loop {
        tokio::select! {
            msg = read.next() => {
                match msg {
                    Some(Ok(Message::Binary(data))) => {
                        if !pinged {
                            let parsed = parse_binary_frame(&data)?;
                            if parsed.cmd == 1 && parsed.sub_cmd == 1 {
                                if let Some(key) = parsed.payload["key"].as_str() {
                                    cipher_key = Some(key.to_string());
                                }
                            }
                            if cipher_key.is_some() {
                                let ping_payload = serde_json::json!({
                                    "version": 1, "cmd": 2, "subCmd": 1,
                                    "data": {"eventId": now_ms()}
                                });
                                let ping_frame = build_binary_frame(1, 2, 1, &ping_payload)?;
                                write.send(Message::Binary(ping_frame)).await
                                    .map_err(|e| format!("send: {e}"))?;
                                pinged = true;
                            }
                        } else {
                            handle_event(&data, &cipher_key, tx).await?;
                        }
                    }
                    Some(Ok(Message::Close(frame))) => {
                        let (code, reason) = frame
                            .map(|f| (f.code.into(), f.reason.to_string()))
                            .unwrap_or((1000, String::new()));
                        let _ = tx.send(WsEvent::Disconnected { code, reason }).await;
                        return Ok(());
                    }
                    Some(Ok(Message::Ping(d))) => {
                        let _ = write.send(Message::Pong(d)).await;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => {
                        return Err(format!("ws read: {e}"));
                    }
                    None => return Ok(()),
                }
            }
            _ = shutdown.recv() => {
                let _ = write.close().await;
                return Ok(());
            }
        }
    }
}

/// Decode and dispatch a binary frame as a Zalo WS event.
async fn handle_event(
    data: &[u8],
    cipher_key: &Option<String>,
    tx: &mpsc::Sender<WsEvent>,
) -> Result<(), String> {
    let parsed = parse_binary_frame(data)?;
    handle_event_inner(parsed, cipher_key, Some(tx)).await
}

/// Parse binary frame into a ParsedFrame.
fn parse_binary_frame(data: &[u8]) -> Result<ParsedFrame, String> {
    if data.len() < 4 {
        return Err("frame too short".into());
    }
    let version = data[0];
    let cmd = u16::from_le_bytes([data[1], data[2]]) as i32;
    let sub_cmd = data[3];
    let payload_str = if data.len() > 4 {
        String::from_utf8_lossy(&data[4..]).to_string()
    } else {
        String::new()
    };
    let payload: Value = if payload_str.is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&payload_str).unwrap_or(Value::Null)
    };
    Ok(ParsedFrame {
        version,
        cmd,
        sub_cmd,
        payload,
    })
}

#[derive(Debug)]
struct ParsedFrame {
    version: u8,
    cmd: i32,
    sub_cmd: u8,
    payload: Value,
}

/// Extract and decrypt event data from parsed frame.
fn extract_event_data(frame: &ParsedFrame, cipher_key: &Option<String>) -> Value {
    let Some(ref ck) = cipher_key else {
        return frame.payload["data"].clone();
    };
    let Some(encrypt) = frame.payload["encrypt"].as_i64() else {
        return frame.payload["data"].clone();
    };

    let raw = match frame.payload["data"].as_str() {
        Some(s) => s,
        None => return frame.payload["data"].clone(),
    };

    match encrypt {
        0 => {
            // Plaintext
            serde_json::from_str(raw).unwrap_or(Value::Null)
        }
        1 => {
            // Raw Base64, no encryption
            let decoded = crypto::b64_decode(raw).unwrap_or_default();
            serde_json::from_slice(&decoded).unwrap_or(Value::Null)
        }
        2 | 3 => {
            // AES-256-GCM encrypted
            let raw_bytes = urlencoding::decode(raw)
                .map(|d| d.as_bytes().to_vec())
                .unwrap_or_default();
            let decrypted = crypto::aes_gcm_decrypt(ck, &raw_bytes).unwrap_or_default();
            if encrypt == 2 {
                // Type 2: deflate decompress after decrypt
                let mut decoder = ZlibDecoder::new(&decrypted[..]);
                let mut decompressed = Vec::new();
                decoder.read_to_end(&mut decompressed).ok();
                serde_json::from_slice(&decompressed).unwrap_or(Value::Null)
            } else {
                // Type 3: raw UTF-8
                serde_json::from_slice(&decrypted).unwrap_or(Value::Null)
            }
        }
        _ => frame.payload["data"].clone(),
    }
}

/// Route a parsed frame to the event channel.
async fn handle_event_inner(
    frame: ParsedFrame,
    cipher_key: &Option<String>,
    tx: Option<&mpsc::Sender<WsEvent>>,
) -> Result<(), String> {
    let event_data = extract_event_data(&frame, cipher_key);
    let Some(tx) = tx else { return Ok(()) };

    match frame.cmd {
        // DM message
        501 => {
            for msg in array_items(&event_data["msgs"]) {
                let _ = tx.send(WsEvent::Message(msg)).await;
            }
        }
        // Group message
        521 => {
            for msg in array_items(&event_data["groupMsgs"]) {
                let _ = tx.send(WsEvent::GroupMessage(msg)).await;
            }
        }
        // DM reaction
        610 => {
            let _ = tx.send(WsEvent::Reaction(event_data)).await;
        }
        // Group reaction
        611 => {
            let _ = tx.send(WsEvent::GroupReaction(event_data)).await;
        }
        // DM undo/recall
        312 => {
            let msg_id = event_data["content"]["globalMsgId"]
                .as_str().or_else(|| event_data["data"]["msgId"].as_str())
                .unwrap_or("").to_string();
            let thread_id = event_data["content"]["callerId"]
                .as_str().or_else(|| event_data["data"]["uidFrom"].as_str())
                .unwrap_or("").to_string();
            let _ = tx.send(WsEvent::Undo {
                msg_id, thread_id, is_group: false, data: event_data,
            }).await;
        }
        // Group undo/recall
        322 => {
            let msg_id = event_data["content"]["globalMsgId"]
                .as_str().or_else(|| event_data["data"]["msgId"].as_str())
                .unwrap_or("").to_string();
            let thread_id = event_data["content"]["gridId"]
                .as_str().or_else(|| event_data["data"]["idTo"].as_str())
                .unwrap_or("").to_string();
            let _ = tx.send(WsEvent::Undo {
                msg_id, thread_id, is_group: true, data: event_data,
            }).await;
        }
        // Group event (join, leave, update, etc.)
        3001 => {
            let event_type = event_data["event"]["type"]
                .as_str().or_else(|| event_data["type"].as_str())
                .unwrap_or("unknown").to_string();
            let group_id = event_data["event"]["groupId"]
                .as_str().or_else(|| event_data["groupId"].as_str())
                .unwrap_or("").to_string();
            let _ = tx.send(WsEvent::GroupEvent {
                event_type, group_id, data: event_data,
            }).await;
        }
        // Friend event
        3101 => {
            let event_type = event_data["type"]
                .as_str().or_else(|| event_data["event"]["type"].as_str())
                .unwrap_or("unknown").to_string();
            let _ = tx.send(WsEvent::FriendEvent { event_type, data: event_data }).await;
        }
        // Typing indicator
        801 => {
            let thread_id = event_data["uid"]
                .as_str().or_else(|| event_data["gid"].as_str())
                .unwrap_or("").to_string();
            let is_group = event_data["gid"].is_string();
            let _ = tx.send(WsEvent::Typing { thread_id, is_group }).await;
        }
        // Seen/read receipt
        802 => {
            let thread_id = event_data["uid"]
                .as_str().or_else(|| event_data["gid"].as_str())
                .unwrap_or("").to_string();
            let msg_ids: Vec<String> = vec![
                event_data["msgId"].as_str().unwrap_or("").to_string(),
                event_data["realMsgId"].as_str().unwrap_or("").to_string(),
            ].into_iter().filter(|s| !s.is_empty()).collect();
            let _ = tx.send(WsEvent::Seen { thread_id, msg_ids }).await;
        }
        // Old messages (catch-up)
        701 => {
            let is_group = event_data["groupMsgs"].is_array();
            let key = if is_group { "groupMsgs" } else { "msgs" };
            let messages = array_items(&event_data[key]);
            let _ = tx.send(WsEvent::OldMessages { messages, is_group }).await;
        }
        // Old reactions (catch-up)
        702 => {
            let is_group = event_data["groupReact"].is_array();
            let key = if is_group { "groupReact" } else { "react" };
            let reactions = array_items(&event_data[key]);
            let _ = tx.send(WsEvent::OldReactions { reactions, is_group }).await;
        }
        // Unhandled
        _ => {
            let _ = tx
                .send(WsEvent::Other {
                    cmd: frame.cmd,
                    sub_cmd: frame.sub_cmd,
                    data: event_data,
                })
                .await;
        }
    }
    Ok(())
}

/// Extract array items from a JSON value, handling both arrays and single objects.
fn array_items(v: &Value) -> Vec<Value> {
    if let Some(arr) = v.as_array() {
        arr.clone()
    } else if !v.is_null() {
        vec![v.clone()]
    } else {
        Vec::new()
    }
}

/// Build a Zalo-protocol binary frame.
fn build_binary_frame(version: u8, cmd: i32, sub_cmd: u8, payload: &Value) -> Result<Vec<u8>, String> {
    let payload_str = serde_json::to_string(payload).map_err(|e| format!("json: {e}"))?;
    let payload_bytes = payload_str.as_bytes();
    let mut frame = Vec::with_capacity(5 + payload_bytes.len());
    frame.push(version);
    frame.extend_from_slice(&(cmd as i16).to_le_bytes());
    frame.push(sub_cmd);
    frame.extend_from_slice(payload_bytes);
    Ok(frame)
}

fn pick_url(urls: &[String]) -> String {
    if urls.is_empty() {
        "wss://ws.chat.zalo.me/ws".to_string()
    } else {
        urls[0].clone()
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_binary_frame() {
        let payload = serde_json::json!({"eventId": 12345});
        let frame = build_binary_frame(1, 2, 1, &payload).unwrap();
        assert_eq!(frame[0], 1);
        assert_eq!(u16::from_le_bytes([frame[1], frame[2]]), 2);
        assert_eq!(frame[3], 1);
        let s = String::from_utf8_lossy(&frame[4..]);
        assert!(s.contains("eventId"));
    }

    #[test]
    fn test_parse_binary_frame() {
        let payload = r#"{"key":"testKey"}"#;
        let mut frame = Vec::new();
        frame.push(1);
        frame.extend_from_slice(&(1i16).to_le_bytes());
        frame.push(1);
        frame.extend_from_slice(payload.as_bytes());

        let parsed = parse_binary_frame(&frame).unwrap();
        assert_eq!(parsed.version, 1);
        assert_eq!(parsed.cmd, 1);
        assert_eq!(parsed.sub_cmd, 1);
        assert_eq!(parsed.payload["key"], "testKey");
    }

    #[test]
    fn test_parse_binary_frame_too_short() {
        let err = parse_binary_frame(&[0, 1]).unwrap_err();
        assert!(err.contains("too short"));
    }

    #[tokio::test]
    async fn test_handle_event_cmd_501() {
        let payload = serde_json::json!({
            "data": {
                "msgs": [{"msgId": "1", "text": "hi"}]
            }
        });
        let frame = build_binary_frame(1, 501, 0, &payload).unwrap();

        let (tx, mut rx) = mpsc::channel(100);
        handle_event(&frame, &None, &tx).await.unwrap();

        if let Some(ev) = rx.recv().await {
            match ev {
                WsEvent::Message(msg) => {
                    assert_eq!(msg["msgId"], "1");
                    assert_eq!(msg["text"], "hi");
                }
                _ => panic!("expected Message event"),
            }
        }
    }

    #[tokio::test]
    async fn test_handle_event_cmd_521_group_msg() {
        let payload = serde_json::json!({
            "data": {
                "groupMsgs": [{"msgId": "g1", "text": "group hi"}]
            }
        });
        let frame = build_binary_frame(1, 521, 0, &payload).unwrap();

        let (tx, mut rx) = mpsc::channel(100);
        handle_event(&frame, &None, &tx).await.unwrap();

        match rx.recv().await.unwrap() {
            WsEvent::GroupMessage(msg) => {
                assert_eq!(msg["msgId"], "g1");
            }
            _ => panic!("expected GroupMessage"),
        }
    }

    #[tokio::test]
    async fn test_handle_event_cmd_610_reaction() {
        let payload = serde_json::json!({"data": {"content": {"rIcon": "/-heart"}}});
        let frame = build_binary_frame(1, 610, 0, &payload).unwrap();

        let (tx, mut rx) = mpsc::channel(100);
        handle_event(&frame, &None, &tx).await.unwrap();

        match rx.recv().await.unwrap() {
            WsEvent::Reaction(data) => assert_eq!(data["content"]["rIcon"], "/-heart"),
            _ => panic!("expected Reaction"),
        }
    }

    #[tokio::test]
    async fn test_handle_event_cmd_611_group_reaction() {
        let payload = serde_json::json!({"data": {"content": {"rIcon": "/-strong"}}});
        let frame = build_binary_frame(1, 611, 0, &payload).unwrap();

        let (tx, mut rx) = mpsc::channel(100);
        handle_event(&frame, &None, &tx).await.unwrap();

        match rx.recv().await.unwrap() {
            WsEvent::GroupReaction(data) => assert_eq!(data["content"]["rIcon"], "/-strong"),
            _ => panic!("expected GroupReaction"),
        }
    }

    #[tokio::test]
    async fn test_handle_event_cmd_312_dm_undo() {
        let payload = serde_json::json!({
            "data": {"content": {"globalMsgId": "msg123", "callerId": "user456"}}
        });
        let frame = build_binary_frame(1, 312, 0, &payload).unwrap();

        let (tx, mut rx) = mpsc::channel(100);
        handle_event(&frame, &None, &tx).await.unwrap();

        match rx.recv().await.unwrap() {
            WsEvent::Undo { msg_id, thread_id, is_group, .. } => {
                assert_eq!(msg_id, "msg123");
                assert_eq!(thread_id, "user456");
                assert!(!is_group);
            }
            _ => panic!("expected Undo"),
        }
    }

    #[tokio::test]
    async fn test_handle_event_cmd_322_group_undo() {
        let payload = serde_json::json!({
            "data": {"content": {"globalMsgId": "gmsg789", "gridId": "group999"}}
        });
        let frame = build_binary_frame(1, 322, 0, &payload).unwrap();

        let (tx, mut rx) = mpsc::channel(100);
        handle_event(&frame, &None, &tx).await.unwrap();

        match rx.recv().await.unwrap() {
            WsEvent::Undo { msg_id, thread_id, is_group, .. } => {
                assert_eq!(msg_id, "gmsg789");
                assert_eq!(thread_id, "group999");
                assert!(is_group);
            }
            _ => panic!("expected Undo"),
        }
    }

    #[tokio::test]
    async fn test_handle_event_cmd_3001_group_event() {
        let payload = serde_json::json!({
            "data": {"event": {"type": "join", "groupId": "g1", "memberId": "u1"}}
        });
        let frame = build_binary_frame(1, 3001, 0, &payload).unwrap();

        let (tx, mut rx) = mpsc::channel(100);
        handle_event(&frame, &None, &tx).await.unwrap();

        match rx.recv().await.unwrap() {
            WsEvent::GroupEvent { event_type, group_id, .. } => {
                assert_eq!(event_type, "join");
                assert_eq!(group_id, "g1");
            }
            _ => panic!("expected GroupEvent"),
        }
    }

    #[tokio::test]
    async fn test_handle_event_cmd_801_typing() {
        let payload = serde_json::json!({"data": {"uid": "user123"}});
        let frame = build_binary_frame(1, 801, 0, &payload).unwrap();

        let (tx, mut rx) = mpsc::channel(100);
        handle_event(&frame, &None, &tx).await.unwrap();

        match rx.recv().await.unwrap() {
            WsEvent::Typing { thread_id, is_group } => {
                assert_eq!(thread_id, "user123");
                assert!(!is_group);
            }
            _ => panic!("expected Typing"),
        }
    }

    #[tokio::test]
    async fn test_handle_event_cmd_701_old_messages() {
        let payload = serde_json::json!({
            "data": {"msgs": [{"msgId": "1"}, {"msgId": "2"}]}
        });
        let frame = build_binary_frame(1, 701, 0, &payload).unwrap();

        let (tx, mut rx) = mpsc::channel(100);
        handle_event(&frame, &None, &tx).await.unwrap();

        match rx.recv().await.unwrap() {
            WsEvent::OldMessages { messages, is_group } => {
                assert_eq!(messages.len(), 2);
                assert!(!is_group);
            }
            _ => panic!("expected OldMessages"),
        }
    }

    #[tokio::test]
    async fn test_handle_event_unhandled_cmd() {
        let payload = serde_json::json!({"data": {"foo": "bar"}});
        let frame = build_binary_frame(1, 9999, 0, &payload).unwrap();

        let (tx, mut rx) = mpsc::channel(100);
        handle_event(&frame, &None, &tx).await.unwrap();

        match rx.recv().await.unwrap() {
            WsEvent::Other { cmd, .. } => assert_eq!(cmd, 9999),
            _ => panic!("expected Other"),
        }
    }

    #[test]
    fn test_array_items_from_array() {
        let v = serde_json::json!([1, 2, 3]);
        assert_eq!(array_items(&v).len(), 3);
    }

    #[test]
    fn test_array_items_from_null() {
        let v = Value::Null;
        assert!(array_items(&v).is_empty());
    }

    #[test]
    fn test_array_items_from_object() {
        let v = serde_json::json!({"key": "val"});
        assert_eq!(array_items(&v).len(), 1);
    }

    #[test]
    fn test_pick_url_empty() {
        assert_eq!(pick_url(&[]), "wss://ws.chat.zalo.me/ws");
    }

    #[test]
    fn test_pick_url_first() {
        let urls = vec!["wss://custom.com".to_string()];
        assert_eq!(pick_url(&urls), "wss://custom.com");
    }
}
