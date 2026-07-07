use crate::zalo::api::ZaloSession;
use crate::zalo::crypto;
use flate2::read::ZlibDecoder;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::io::Read;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

/// WebSocket event types received from Zalo.
#[derive(Debug, Clone)]
pub enum WsEvent {
    Message(Value),
    GroupMessage(Value),
    Reaction(Value),
    GroupReaction(Value),
    Disconnected { code: u16, reason: String },
    Other { cmd: i32, sub_cmd: u8, data: Value },
}

/// Run the WebSocket listener. Connects to Zalo's WS, handles auth handshake,
/// decodes binary frames, and sends structured events via `tx`.
/// Exits when `shutdown` receives a message or the connection drops.
pub async fn run_listener(
    _session: ZaloSession,
    ws_urls: Vec<String>,
    tx: mpsc::Sender<WsEvent>,
    mut shutdown: mpsc::Receiver<()>,
) -> Result<(), String> {
    let url = pick_url(&ws_urls);
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
                            // Cipher key exchange: cmd=1, subCmd=1, payload has "key"
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
                            handle_event(&data, &cipher_key, &tx).await?;
                        }
                    }
                    Some(Ok(Message::Close(frame))) => {
                        let (code, reason) = frame
                            .map(|f| (f.code.into(), f.reason.to_string()))
                            .unwrap_or((1000, String::new()));
                        let _ = tx.send(WsEvent::Disconnected { code, reason }).await;
                        break;
                    }
                    Some(Ok(Message::Ping(d))) => {
                        let _ = write.send(Message::Pong(d)).await;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => {
                        let _ = tx.send(WsEvent::Disconnected {
                            code: 1006,
                            reason: e.to_string(),
                        }).await;
                        break;
                    }
                    None => break,
                }
            }
            _ = shutdown.recv() => {
                let _ = write.close().await;
                break;
            }
        }
    }

    Ok(())
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
        501 => {
            if let Some(msgs) = event_data["msgs"].as_array() {
                for msg in msgs {
                    let _ = tx.send(WsEvent::Message(msg.clone())).await;
                }
            }
        }
        521 => {
            if let Some(msgs) = event_data["groupMsgs"].as_array() {
                for msg in msgs {
                    let _ = tx.send(WsEvent::GroupMessage(msg.clone())).await;
                }
            }
        }
        610 => {
            let _ = tx.send(WsEvent::Reaction(event_data)).await;
        }
        611 => {
            let _ = tx.send(WsEvent::GroupReaction(event_data)).await;
        }
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
}
