use crate::zalo::crypto;
use reqwest::cookie::Jar as CookieJar;
use reqwest::Client;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

pub mod login;
pub mod message;

pub const API_TYPE: u32 = 30;
pub const API_VERSION: u32 = 671;
pub const LOGIN_BASE: &str = "https://wpa.chat.zalo.me/api/login";
pub const CHAT_BASE: &str = "https://wpa.chat.zalo.me/api";

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

/// Make a signed GET/POST request to a Zalo API endpoint.
/// Encrypts params with session's secret key, sends as form-urlencoded.
pub(crate) async fn api_request(
    session: &ZaloSession,
    url: &str,
    params: &BTreeMap<&str, String>,
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

    let err_code = body["error_code"].as_i64().unwrap_or(-1);
    if err_code != 0 {
        return Err(format!("api error {}: {}", err_code, body["error_message"]));
    }

    let data_str = body["data"].as_str().ok_or("no data field")?;
    let decrypted = crypto::aes_cbc_decrypt(&session.secret_key, data_str)?;
    let result: Value =
        serde_json::from_str(&decrypted).map_err(|e| format!("json parse result: {e}"))?;

    // The result often has nested `data` field with actual payload
    if result["data"].is_object() || result["data"].is_array() {
        Ok(result["data"].clone())
    } else {
        Ok(result)
    }
}
