use crate::zalo::crypto;
use crate::zalo::types::ThreadType;
use reqwest::cookie::Jar as CookieJar;
use reqwest::Client;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

pub mod friends;
pub mod groups;
pub mod login;
pub mod message;

pub const API_TYPE: u32 = 30;
pub const API_VERSION: u32 = 671;
pub const LOGIN_BASE: &str = "https://wpa.chat.zalo.me/api/login";
pub const CHAT_BASE: &str = "https://wpa.chat.zalo.me/api";
pub const GROUP_BASE: &str = "https://wpa.chat.zalo.me/api/group";
pub const FRIEND_BASE: &str = "https://wpa.chat.zalo.me/api/friend";
pub const PROFILE_BASE: &str = "https://wpa.chat.zalo.me/api/social";
pub const FILE_BASE: &str = "https://wpa.chat.zalo.me/api";
pub const REACTION_BASE: &str = "https://wpa.chat.zalo.me/api";
pub const ALIAS_BASE: &str = "https://wpa.chat.zalo.me/api/alias";
pub const GROUP_POLL_BASE: &str = "https://wpa.chat.zalo.me/api/group";

/// Zalo session state after successful login.
#[derive(Debug, Clone)]
pub struct ZaloSession {
    pub imei: String,
    pub cookie_jar: Arc<CookieJar>,
    pub user_agent: String,
    pub secret_key: String,
    pub uid: String,
    pub settings: Value,
    pub extra_ver: String,
    pub zpw_service_map: Value,
    pub zpw_ws: Vec<String>,
    pub language: String,
}

impl ZaloSession {
    /// Build a reqwest Client with the session's cookies and default headers.
    pub fn http_client(&self) -> Client {
        Client::builder()
            .cookie_provider(self.cookie_jar.clone())
            .user_agent(&self.user_agent)
            .build()
            .expect("build http client")
    }
}

/// ParamsEncryptor used during the login handshake.
struct LoginEncryptor {
    imei: String,
    first_launch: u64,
}

impl LoginEncryptor {
    fn new(imei: &str) -> Self {
        let first_launch = now_ms();
        Self {
            imei: imei.to_string(),
            first_launch,
        }
    }

    /// Generate `zcid` param: AES-128-CBC encrypt( "type,imei,firstLaunch" ) with hardcoded key, hex uppercase.
    fn zcid(&self) -> Result<String, String> {
        let msg = format!("{},{},{}", API_TYPE, self.imei, self.first_launch);
        crypto::login_encrypt_hex(&msg)
    }

    /// Generate `zcid_ext` param: random hex string.
    fn zcid_ext() -> String {
        let uuid = uuid::Uuid::new_v4();
        hex::encode_upper(uuid.as_bytes())
    }

    /// Create the encrypt key (enk) from zcid and zcid_ext.
    fn encrypt_key(zcid: &str, zcid_ext: &str) -> String {
        crypto::create_encrypt_key(zcid, zcid_ext)
    }

    /// Encrypt request params using the derived encrypt key (AES-CBC, UTF-8 key, hex output).
    fn encrypt_params(&self, data: &str, enk: &str) -> Result<String, String> {
        crypto::aes_cbc_encrypt_utf8_key_hex(enk, data)
    }
}

/// Timestamp in milliseconds.
pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Build the common query params used in every API request.
pub(crate) fn api_params() -> BTreeMap<&'static str, String> {
    let mut p = BTreeMap::new();
    p.insert("zpw_ver", API_VERSION.to_string());
    p.insert("zpw_type", API_TYPE.to_string());
    p
}

/// Encrypt params, POST to URL, decrypt response.
/// Returns the decrypted JSON body.
pub(crate) async fn api_post(
    session: &ZaloSession,
    url: &str,
    params: &BTreeMap<String, String>,
) -> Result<Value, String> {
    let client = session.http_client();
    let json_body = serde_json::to_string(params).map_err(|e| format!("json: {e}"))?;
    let encrypted = crypto::aes_cbc_encrypt(&session.secret_key, &json_body)?;

    let resp = client
        .post(url)
        .form(&[("params", &encrypted)])
        .send()
        .await
        .map_err(|e| format!("http post: {e}"))?;

    let status = resp.status();
    let body: Value = resp.json().await.map_err(|e| format!("json parse: {e}"))?;

    if !status.is_success() {
        return Err(format!("http {}: {:?}", status, body));
    }

    decrypt_response(session, &body)
}

/// GET request with encrypted params as query string.
pub(crate) async fn api_get(
    session: &ZaloSession,
    url: &str,
    params: &BTreeMap<String, String>,
) -> Result<Value, String> {
    let client = session.http_client();
    let json_body = serde_json::to_string(params).map_err(|e| format!("json: {e}"))?;
    let encrypted = crypto::aes_cbc_encrypt(&session.secret_key, &json_body)?;

    let sep = if url.contains('?') { "&" } else { "?" };
    let full_url = format!("{url}{sep}params={}", urlencoding::encode(&encrypted));

    let resp = client
        .get(&full_url)
        .send()
        .await
        .map_err(|e| format!("http get: {e}"))?;

    let status = resp.status();
    let body: Value = resp.json().await.map_err(|e| format!("json parse: {e}"))?;

    if !status.is_success() {
        return Err(format!("http {}: {:?}", status, body));
    }

    decrypt_response(session, &body)
}

/// Decrypt and parse a Zalo API response body.
fn decrypt_response(session: &ZaloSession, body: &Value) -> Result<Value, String> {
    let err_code = body["error_code"].as_i64().unwrap_or(-1);
    if err_code != 0 {
        let msg = body["error_message"].as_str().unwrap_or("unknown");
        return Err(format!("api error {}: {}", err_code, msg));
    }
    let data_str = match body["data"].as_str() {
        Some(s) => s,
        None => return Ok(body["data"].clone()),
    };
    if data_str.is_empty() {
        return Ok(Value::Null);
    }
    let decrypted = crypto::aes_cbc_decrypt(&session.secret_key, data_str)?;
    let result: Value =
        serde_json::from_str(&decrypted).map_err(|e| format!("json parse result: {e}"))?;
    if result["data"].is_object() || result["data"].is_array() {
        Ok(result["data"].clone())
    } else {
        Ok(result)
    }
}

/// Build a fully-qualified URL with common query params.
pub(crate) fn url_with_params(base: &str, path: &str, extra: &[(&str, &str)]) -> String {
    let mut parts: Vec<String> = vec![
        format!("zpw_ver={}", API_VERSION),
        format!("zpw_type={}", API_TYPE),
    ];
    for (k, v) in extra {
        parts.push(format!("{}={}", k, urlencoding::encode(v)));
    }
    format!("{}/{}{}", base.trim_end_matches('/'), path.trim_start_matches('/'), if parts.is_empty() { String::new() } else { format!("?{}", parts.join("&")) })
}

/// Resolve service URL from zpw_service_map or use default.
pub(crate) fn service_url(session: &ZaloSession, service: &str, default: &str) -> String {
    if let Some(map) = session.zpw_service_map.as_object() {
        if let Some(urls) = map.get(service).and_then(|v| v.as_array()) {
            if let Some(url) = urls.first().and_then(|v| v.as_str()) {
                return url.to_string();
            }
        }
    }
    default.to_string()
}

/// Make a POST request using the service map for URL resolution.
pub(crate) async fn service_post(
    session: &ZaloSession,
    service: &str,
    default_base: &str,
    path: &str,
    params: &BTreeMap<String, String>,
) -> Result<Value, String> {
    let base = service_url(session, service, default_base);
    let url = format!("{}{}", base.trim_end_matches('/'), path);
    api_post(session, &url, params).await
}

/// Make a GET request using the service map for URL resolution.
pub(crate) async fn service_get(
    session: &ZaloSession,
    service: &str,
    default_base: &str,
    path: &str,
    params: &BTreeMap<String, String>,
) -> Result<Value, String> {
    let base = service_url(session, service, default_base);
    let url = format!("{}{}", base.trim_end_matches('/'), path);
    api_get(session, &url, params).await
}
