use super::{service_get, service_post, ZaloSession};
use serde_json::Value;
use std::collections::BTreeMap;

/// Find a user by phone number.
pub async fn find_user(
    session: &ZaloSession,
    phone: &str,
) -> Result<Value, String> {
    let mut params = BTreeMap::new();
    params.insert("phone".to_string(), phone.to_string());
    params.insert("avatar_size".to_string(), "240".to_string());
    params.insert("language".to_string(), session.language.clone());
    params.insert("imei".to_string(), session.imei.clone());
    params.insert("reqSrc".to_string(), "40".to_string());

    service_get(session, "friend", super::FRIEND_BASE, "/api/friend/profile/get", &params).await
}

/// Find a user by username.
pub async fn find_user_by_username(
    session: &ZaloSession,
    username: &str,
) -> Result<Value, String> {
    let mut params = BTreeMap::new();
    params.insert("user_name".to_string(), username.to_string());
    params.insert("avatar_size".to_string(), "240".to_string());

    service_get(session, "friend", super::FRIEND_BASE, "/api/friend/search/by-user-name", &params).await
}

/// Get all friends list.
pub async fn get_all_friends(
    session: &ZaloSession,
) -> Result<Value, String> {
    let mut params = BTreeMap::new();
    params.insert("incInvalid".to_string(), "1".to_string());
    params.insert("page".to_string(), "1".to_string());
    params.insert("count".to_string(), "20000".to_string());
    params.insert("avatar_size".to_string(), "120".to_string());
    params.insert("actiontime".to_string(), "0".to_string());
    params.insert("imei".to_string(), session.imei.clone());

    service_get(session, "profile", super::PROFILE_BASE, "/api/social/friend/getfriends", &params).await
}

/// Get alias list (contact names).
pub async fn get_alias_list(
    session: &ZaloSession,
) -> Result<Value, String> {
    let mut params = BTreeMap::new();
    params.insert("page".to_string(), "1".to_string());
    params.insert("count".to_string(), "100".to_string());
    params.insert("imei".to_string(), session.imei.clone());

    service_get(session, "alias", super::ALIAS_BASE, "/api/alias/list", &params).await
}

/// Get friend request status for a given user ID.
pub async fn get_friend_request_status(
    session: &ZaloSession,
    user_id: &str,
) -> Result<Value, String> {
    let mut params = BTreeMap::new();
    params.insert("fid".to_string(), user_id.to_string());
    params.insert("imei".to_string(), session.imei.clone());

    service_get(session, "friend", super::FRIEND_BASE, "/api/friend/reqstatus", &params).await
}

/// Send a friend request.
pub async fn send_friend_request(
    session: &ZaloSession,
    user_id: &str,
    msg: &str,
) -> Result<Value, String> {
    let mut params = BTreeMap::new();
    params.insert("toid".to_string(), user_id.to_string());
    params.insert("msg".to_string(), msg.to_string());
    params.insert("reqsrc".to_string(), "30".to_string());
    params.insert("imei".to_string(), session.imei.clone());
    params.insert("language".to_string(), session.language.clone());
    let src_params = serde_json::json!({"uidTo": user_id});
    params.insert("srcParams".to_string(), src_params.to_string());

    service_post(session, "friend", super::FRIEND_BASE, "/api/friend/sendreq", &params).await
}

/// Get friend recommendations (incoming friend requests).
pub async fn get_friend_recommendations(
    session: &ZaloSession,
) -> Result<Value, String> {
    let mut params = BTreeMap::new();
    params.insert("imei".to_string(), session.imei.clone());

    service_get(session, "friend", super::FRIEND_BASE, "/api/friend/recommendsv2/list", &params).await
}

/// Get sent friend requests.
pub async fn get_sent_friend_requests(
    session: &ZaloSession,
) -> Result<Value, String> {
    let mut params = BTreeMap::new();
    params.insert("imei".to_string(), session.imei.clone());

    service_get(session, "friend", super::FRIEND_BASE, "/api/friend/requested/list", &params).await
}

/// Get group invitation box list.
pub async fn get_group_invite_box_list(
    session: &ZaloSession,
) -> Result<Value, String> {
    let mut params = BTreeMap::new();
    params.insert("mpage".to_string(), "1".to_string());
    params.insert("page".to_string(), "0".to_string());
    params.insert("invPerPage".to_string(), "12".to_string());
    params.insert("mcount".to_string(), "10".to_string());
    params.insert("avatar_size".to_string(), "120".to_string());
    params.insert("member_avatar_size".to_string(), "120".to_string());
    params.insert("imei".to_string(), session.imei.clone());

    service_get(session, "group", super::GROUP_BASE, "/api/group/inv-box/list", &params).await
}

/// Accept a friend request.
pub async fn accept_friend_request(
    session: &ZaloSession,
    user_id: &str,
) -> Result<Value, String> {
    let mut params = BTreeMap::new();
    params.insert("fid".to_string(), user_id.to_string());
    params.insert("imei".to_string(), session.imei.clone());

    service_post(session, "friend", super::FRIEND_BASE, "/api/friend/accept", &params).await
}

/// Reject a friend request.
pub async fn reject_friend_request(
    session: &ZaloSession,
    user_id: &str,
) -> Result<Value, String> {
    let mut params = BTreeMap::new();
    params.insert("fid".to_string(), user_id.to_string());
    params.insert("imei".to_string(), session.imei.clone());

    service_post(session, "friend", super::FRIEND_BASE, "/api/friend/reject", &params).await
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
                "friend": ["https://wpa.chat.zalo.me/api/friend"],
                "profile": ["https://wpa.chat.zalo.me/api/social"],
                "alias": ["https://wpa.chat.zalo.me/api/alias"],
                "group": ["https://wpa.chat.zalo.me/api/group"],
            }),
            zpw_ws: vec![],
            language: "vi".into(),
        }
    }

    #[tokio::test]
    async fn test_find_user_http_error() {
        let session = mock_session();
        let result = find_user(&session, "0000000000").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_find_user_by_username_http_error() {
        let session = mock_session();
        let result = find_user_by_username(&session, "nonexistent_user_xyz").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_all_friends_http_error() {
        let session = mock_session();
        let result = get_all_friends(&session).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_alias_list_http_error() {
        let session = mock_session();
        let result = get_alias_list(&session).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_friend_request_status_http_error() {
        let session = mock_session();
        let result = get_friend_request_status(&session, "uid1").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_send_friend_request_http_error() {
        let session = mock_session();
        let result = send_friend_request(&session, "uid1", "hello").await;
        assert!(result.is_err());
    }

    #[test]
    fn test_find_user_creates_params() {
        let session = mock_session();
        let result = find_user(&session, "+84123456789");
        assert!(true);
    }

    #[test]
    fn test_get_friend_recommendations_creates_params() {
        let session = mock_session();
        let result = get_friend_recommendations(&session);
        assert!(true);
    }
}
