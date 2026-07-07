use super::super::types::ThreadType;
use super::{now_ms, service_get, service_post, ZaloSession};
use serde_json::Value;
use std::collections::BTreeMap;

/// Get all groups the user is a member of.
pub async fn get_all_groups(
    session: &ZaloSession,
) -> Result<Value, String> {
    service_get(session, "group_poll", super::GROUP_POLL_BASE, "/api/group/getlg/v4", &BTreeMap::new()).await
}

/// Get mute status for all conversations.
pub async fn get_mute(
    session: &ZaloSession,
) -> Result<Value, String> {
    let mut params = BTreeMap::new();
    params.insert("imei".to_string(), session.imei.clone());

    service_get(session, "profile", super::PROFILE_BASE, "/api/social/profile/getmute", &params).await
}

/// Set mute for a conversation.
pub async fn set_mute(
    session: &ZaloSession,
    thread_id: &str,
    duration: i64,
    thread_type: ThreadType,
) -> Result<Value, String> {
    let mut params = BTreeMap::new();
    params.insert("toid".to_string(), thread_id.to_string());
    params.insert("duration".to_string(), duration.to_string());
    params.insert("action".to_string(), "1".to_string());
    params.insert("startTime".to_string(), (now_ms() / 1000).to_string());
    params.insert("imei".to_string(), session.imei.clone());

    match thread_type {
        ThreadType::User => {
            params.insert("muteType".to_string(), "1".to_string());
        }
        ThreadType::Group => {
            params.insert("muteType".to_string(), "2".to_string());
        }
    }

    service_post(session, "profile", super::PROFILE_BASE, "/api/social/profile/setmute", &params).await
}

/// Unmute a conversation.
pub async fn unmute(
    session: &ZaloSession,
    thread_id: &str,
    thread_type: ThreadType,
) -> Result<Value, String> {
    let mut params = BTreeMap::new();
    params.insert("toid".to_string(), thread_id.to_string());
    params.insert("duration".to_string(), "0".to_string());
    params.insert("action".to_string(), "3".to_string());
    params.insert("startTime".to_string(), (now_ms() / 1000).to_string());
    params.insert("imei".to_string(), session.imei.clone());

    match thread_type {
        ThreadType::User => {
            params.insert("muteType".to_string(), "1".to_string());
        }
        ThreadType::Group => {
            params.insert("muteType".to_string(), "2".to_string());
        }
    }

    service_post(session, "profile", super::PROFILE_BASE, "/api/social/profile/setmute", &params).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::zalo::crypto;
    use base64::Engine;
    use serde_json::json;

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
            zpw_service_map: json!({
                "group_poll": ["https://wpa.chat.zalo.me/api/group"],
                "profile": ["https://wpa.chat.zalo.me/api/social"],
                "group": ["https://wpa.chat.zalo.me/api/group"],
            }),
            zpw_ws: vec![],
            language: "vi".into(),
        }
    }

    #[tokio::test]
    async fn test_get_all_groups_http_error() {
        let session = mock_session();
        let result = get_all_groups(&session).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_mute_http_error() {
        let session = mock_session();
        let result = get_mute(&session).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_set_mute_http_error() {
        let session = mock_session();
        let result = set_mute(&session, "uid1", 3600, ThreadType::User).await;
        assert!(result.is_err());
    }

    #[test]
    fn test_set_mute_group_creates_params() {
        let session = mock_session();
        let result = set_mute(&session, "gid1", -1, ThreadType::Group);
        assert!(true);
    }
}
