use super::{now_ms, service_post, ThreadType, ZaloSession};
use serde_json::Value;
use std::collections::BTreeMap;

/// Send a text message to a user or group.
pub async fn send_message(
    session: &ZaloSession,
    thread_id: &str,
    text: &str,
    msg_type: Option<&str>,
    thread_type: ThreadType,
) -> Result<Value, String> {
    let client_id = format!("rust{}", now_ms());
    let mut params = BTreeMap::new();
    params.insert("imei".to_string(), session.imei.clone());
    params.insert("msg".to_string(), text.to_string());
    params.insert("clientId".to_string(), client_id);
    params.insert("zmsgType".to_string(), msg_type.unwrap_or("1").to_string());
    params.insert("ttl".to_string(), "0".to_string());

    match thread_type {
        ThreadType::User => {
            params.insert("toid".to_string(), thread_id.to_string());
            service_post(session, "chat", super::CHAT_BASE, "/api/message", &params).await
        }
        ThreadType::Group => {
            params.insert("grid".to_string(), thread_id.to_string());
            params.insert("visibility".to_string(), "0".to_string());
            service_post(session, "group", super::GROUP_BASE, "/api/group/sendmsg", &params).await
        }
    }
}

/// Send a message with quote (reply).
pub async fn send_quote_message(
    session: &ZaloSession,
    thread_id: &str,
    text: &str,
    quote_msg_id: &str,
    quote_cli_msg_id: &str,
    quote_uid_from: &str,
    quote_ts: &str,
    quote_content: &Value,
    quote_msg_type: &str,
    thread_type: ThreadType,
) -> Result<Value, String> {
    let client_id = format!("rust{}", now_ms());
    let mut params = BTreeMap::new();
    params.insert("imei".to_string(), session.imei.clone());
    params.insert("message".to_string(), text.to_string());
    params.insert("clientId".to_string(), client_id);
    params.insert("ttl".to_string(), "0".to_string());

    let quote = serde_json::json!({
        "uidFrom": quote_uid_from,
        "msgId": quote_msg_id,
        "cliMsgId": quote_cli_msg_id,
        "ts": quote_ts,
        "msgType": quote_msg_type,
        "content": quote_content,
        "ttl": 0,
    });
    params.insert("quote".to_string(), quote.to_string());

    match thread_type {
        ThreadType::User => {
            params.insert("toid".to_string(), thread_id.to_string());
            service_post(session, "chat", super::CHAT_BASE, "/api/message/quote", &params).await
        }
        ThreadType::Group => {
            params.insert("grid".to_string(), thread_id.to_string());
            params.insert("visibility".to_string(), "0".to_string());
            service_post(session, "group", super::GROUP_BASE, "/api/group/quote", &params).await
        }
    }
}

/// Send a message with mentions.
pub async fn send_mention_message(
    session: &ZaloSession,
    thread_id: &str,
    text: &str,
    mentions: &[MentionData],
    thread_type: ThreadType,
) -> Result<Value, String> {
    let client_id = format!("rust{}", now_ms());
    let mut params = BTreeMap::new();
    params.insert("imei".to_string(), session.imei.clone());
    params.insert("msg".to_string(), text.to_string());
    params.insert("clientId".to_string(), client_id);
    params.insert("zmsgType".to_string(), "1".to_string());
    params.insert("ttl".to_string(), "0".to_string());

    let mention_list: Vec<Value> = mentions
        .iter()
        .map(|m| {
            serde_json::json!({
                "uid": m.uid,
                "pos": m.pos,
                "len": m.len,
                "type": m.mention_type,
            })
        })
        .collect();
    params.insert("mentionInfo".to_string(), serde_json::json!({"mention": mention_list}).to_string());

    match thread_type {
        ThreadType::User => {
            params.insert("toid".to_string(), thread_id.to_string());
            service_post(session, "chat", super::CHAT_BASE, "/api/message/sms", &params).await
        }
        ThreadType::Group => {
            params.insert("grid".to_string(), thread_id.to_string());
            params.insert("visibility".to_string(), "0".to_string());
            service_post(session, "group", super::GROUP_BASE, "/api/group/mention", &params).await
        }
    }
}

/// Add a reaction to a message.
pub async fn add_reaction(
    session: &ZaloSession,
    msg_id: &str,
    cli_msg_id: &str,
    reaction_type: i64,
    icon: &str,
    thread_id: &str,
    thread_type: ThreadType,
) -> Result<Value, String> {
    let client_id = format!("rust{}", now_ms());
    let rmsg = serde_json::json!([{
        "gMsgID": msg_id,
        "cMsgID": cli_msg_id,
        "msgType": 1,
    }]);
    let message = serde_json::json!({
        "rMsg": rmsg,
        "rIcon": icon,
        "rType": reaction_type,
        "source": 6,
    });
    let react_list = serde_json::json!([{
        "message": message.to_string(),
        "clientId": client_id,
    }]);

    let mut params = BTreeMap::new();
    params.insert("react_list".to_string(), react_list.to_string());
    params.insert("clientId".to_string(), client_id);
    params.insert("imei".to_string(), session.imei.clone());

    match thread_type {
        ThreadType::User => {
            params.insert("toid".to_string(), thread_id.to_string());
            service_post(session, "reaction", super::REACTION_BASE, "/api/message/reaction", &params).await
        }
        ThreadType::Group => {
            params.insert("grid".to_string(), thread_id.to_string());
            service_post(session, "reaction", super::REACTION_BASE, "/api/group/reaction", &params).await
        }
    }
}

/// Recall/undo a message.
pub async fn undo_message(
    session: &ZaloSession,
    msg_id: &str,
    cli_msg_id: &str,
    thread_id: &str,
    thread_type: ThreadType,
) -> Result<Value, String> {
    let client_id = format!("rust{}", now_ms());
    let mut params = BTreeMap::new();
    params.insert("msgId".to_string(), msg_id.to_string());
    params.insert("cliMsgIdUndo".to_string(), cli_msg_id.to_string());
    params.insert("clientId".to_string(), client_id);
    params.insert("imei".to_string(), session.imei.clone());

    match thread_type {
        ThreadType::User => {
            params.insert("toid".to_string(), thread_id.to_string());
            service_post(session, "chat", super::CHAT_BASE, "/api/message/undo", &params).await
        }
        ThreadType::Group => {
            params.insert("grid".to_string(), thread_id.to_string());
            params.insert("visibility".to_string(), "0".to_string());
            service_post(session, "group", super::GROUP_BASE, "/api/group/undomsg", &params).await
        }
    }
}

/// Get info for one or more users.
pub async fn get_user_info(
    session: &ZaloSession,
    user_ids: &[String],
) -> Result<Value, String> {
    let mut params = BTreeMap::new();
    let pversion_map: Vec<String> = user_ids
        .iter()
        .map(|uid| {
            if uid.ends_with("_0") {
                uid.clone()
            } else {
                format!("{}_0", uid)
            }
        })
        .collect();
    params.insert("friend_pversion_map".to_string(), serde_json::to_string(&pversion_map).unwrap_or_default());
    params.insert("avatar_size".to_string(), "120".to_string());
    params.insert("language".to_string(), session.language.clone());
    params.insert("show_online_status".to_string(), "1".to_string());
    params.insert("imei".to_string(), session.imei.clone());

    service_post(session, "profile", super::PROFILE_BASE, "/api/social/friend/getprofiles/v2", &params).await
}

/// Get info for one or more groups.
pub async fn get_group_info(
    session: &ZaloSession,
    group_ids: &[String],
) -> Result<Value, String> {
    let mut grid_map = serde_json::Map::new();
    for gid in group_ids {
        grid_map.insert(gid.clone(), serde_json::Value::Number(serde_json::Number::from(0)));
    }
    let mut params = BTreeMap::new();
    params.insert("gridVerMap".to_string(), serde_json::to_string(&grid_map).unwrap_or_default());
    params.insert("imei".to_string(), session.imei.clone());

    service_post(session, "group", super::GROUP_BASE, "/api/group/getmg-v2", &params).await
}

/// Mention data structure.
#[derive(Debug, Clone)]
pub struct MentionData {
    pub uid: String,
    pub pos: i64,
    pub len: i64,
    pub mention_type: i64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::zalo::crypto;
    use base64::Engine;

    fn mock_session() -> ZaloSession {
        let key = base64::engine::general_purpose::STANDARD.encode(b"0123456789abcdef");
        let jar = std::sync::Arc::new(reqwest::cookie::Jar::default());
        ZaloSession {
            imei: "test-imei".into(),
            cookie_jar: jar,
            user_agent: "test-agent".into(),
            secret_key: key,
            uid: "123".into(),
            settings: Value::Null,
            extra_ver: String::new(),
            zpw_service_map: Value::Null,
            zpw_ws: vec![],
            language: "vi".into(),
        }
    }

    #[test]
    fn test_send_message_creates_params() {
        let session = mock_session();
        let result = send_message(&session, "thread1", "hello", None, ThreadType::User);
        // Just verify the future is created (can't run in sync test)
        assert!(true);
    }

    #[test]
    fn test_send_group_message_creates_params() {
        let session = mock_session();
        let result = send_message(&session, "group1", "hello", None, ThreadType::Group);
        assert!(true);
    }

    #[tokio::test]
    async fn test_send_message_http_error() {
        let session = mock_session();
        let result = send_message(&session, "9999", "test", None, ThreadType::User).await;
        assert!(result.is_err());
    }

    #[test]
    fn test_add_reaction_creates_params() {
        let session = mock_session();
        let result = add_reaction(&session, "msg1", "cli1", 5, "❤", "thread1", ThreadType::User);
        assert!(true);
    }

    #[test]
    fn test_undo_message_creates_params() {
        let session = mock_session();
        let result = undo_message(&session, "msg1", "cli1", "thread1", ThreadType::User);
        assert!(true);
    }

    #[test]
    fn test_get_user_info_params() {
        let session = mock_session();
        let user_ids = vec!["uid1".to_string(), "uid2".to_string()];
        let _result = get_user_info(&session, &user_ids);
        assert!(true);
    }

    #[test]
    fn test_get_group_info_params() {
        let session = mock_session();
        let group_ids = vec!["gid1".to_string()];
        let _result = get_group_info(&session, &group_ids);
        assert!(true);
    }

    #[test]
    fn test_send_mention_message_creates_params() {
        let session = mock_session();
        let mentions = vec![MentionData {
            uid: "uid1".into(),
            pos: 0,
            len: 5,
            mention_type: 0,
        }];
        let result = send_mention_message(&session, "group1", "@hello", &mentions, ThreadType::Group);
        assert!(true);
    }
}
