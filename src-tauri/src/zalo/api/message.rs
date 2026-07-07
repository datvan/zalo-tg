use super::{api_request, ZaloSession};
use serde_json::Value;
use std::collections::BTreeMap;

const CHAT_BASE: &str = "https://wpa.chat.zalo.me/api";

/// Send a text message to a thread (user or group).
pub async fn send_message(
    session: &ZaloSession,
    thread_id: &str,
    text: &str,
    msg_type: Option<&str>,
) -> Result<Value, String> {
    let mut params = BTreeMap::new();
    params.insert("imei", session.imei.clone());
    params.insert("msg", format!("{:?}", text));
    params.insert("clientId", format!("rust{}", super::now_ms()));
    params.insert("zmsgType", msg_type.unwrap_or("1").to_string());
    params.insert("toid", thread_id.to_string());
    api_request(session, &format!("{CHAT_BASE}/message"), &params).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_placeholder() {
        assert!(true);
    }
}
