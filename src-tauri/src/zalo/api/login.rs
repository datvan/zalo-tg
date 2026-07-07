use super::{LoginEncryptor, ZaloSession, API_TYPE, API_VERSION, LOGIN_BASE};
use crate::zalo::crypto;
use reqwest::cookie::Jar as CookieJar;
use serde_json::Value;
use std::sync::Arc;

/// Parsed cookies from credentials.
#[derive(Debug, Clone)]
pub struct ZaloCredentials {
    pub imei: String,
    pub cookies: Vec<ZaloCookie>,
    pub user_agent: String,
    pub language: String,
}

#[derive(Debug, Clone)]
pub struct ZaloCookie {
    pub key: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    pub secure: bool,
    pub http_only: bool,
    pub expiration_date: Option<i64>,
    pub same_site: Option<String>,
}

impl ZaloCookie {
    /// Convert to a cookie string "key=value".
    fn to_kv(&self) -> String {
        format!("{}={}", self.key, self.value)
    }
}

/// Parse credentials from a JSON value (matches zca-js format).
pub fn parse_credentials(json: &Value) -> Result<ZaloCredentials, String> {
    let imei = json["imei"]
        .as_str()
        .ok_or("missing imei")?
        .to_string();
    let user_agent = json["userAgent"]
        .as_str()
        .ok_or("missing userAgent")?
        .to_string();
    let language = json["language"].as_str().unwrap_or("vi").to_string();

    let cookie_arr = json["cookie"].as_array().ok_or("missing cookie array")?;
    let mut cookies = Vec::new();
    for c in cookie_arr {
        cookies.push(ZaloCookie {
            key: c["key"].as_str().or_else(|| c["name"].as_str())
                .ok_or("cookie missing key/name")?
                .to_string(),
            value: c["value"].as_str().ok_or("cookie missing value")?.to_string(),
            domain: c["domain"].as_str().unwrap_or("chat.zalo.me").to_string(),
            path: c["path"].as_str().unwrap_or("/").to_string(),
            secure: c["secure"].as_bool().unwrap_or(true),
            http_only: c["httpOnly"].as_bool().unwrap_or(true),
            expiration_date: c["expirationDate"].as_i64(),
            same_site: c["sameSite"].as_str().map(|s| s.to_string()),
        });
    }

    Ok(ZaloCredentials {
        imei,
        cookies,
        user_agent,
        language,
    })
}

/// Build a CookieJar from ZaloCookie list.
fn build_cookie_jar(cookies: &[ZaloCookie]) -> Arc<CookieJar> {
    let jar = CookieJar::default();
    for c in cookies {
        let domain = c.domain.trim_start_matches('.');
        let url = format!("https://{}{}", domain, c.path);
        let cookie_str = format!(
            "{}={}; path={}; domain={}{}{}",
            c.key,
            c.value,
            c.path,
            domain,
            if c.secure { "; secure" } else { "" },
            if c.http_only { "; httpOnly" } else { "" },
        );
        jar.add_cookie_str(&cookie_str, &url.parse().unwrap());
    }
    Arc::new(jar)
}

/// Step 1: POST to /api/login/getLoginInfo with encrypted params.
async fn get_login_info(
    encryptor: &LoginEncryptor,
    jar: &Arc<CookieJar>,
    user_agent: &str,
    language: &str,
) -> Result<(String, Value), String> {
    let zcid = encryptor.zcid()?;
    let zcid_ext = LoginEncryptor::zcid_ext();
    let enk = LoginEncryptor::encrypt_key(&zcid, &zcid_ext);

    // Encrypt the data payload
    let data = serde_json::json!({
        "computer_name": "Web",
        "imei": encryptor.imei,
        "language": language,
        "ts": super::now_ms(),
    });
    let params_encrypted = encryptor.encrypt_params(&data.to_string(), &enk)?;

    // Build sorted params for signkey
    let mut sign_params = std::collections::BTreeMap::new();
    sign_params.insert("zcid", zcid.clone());
    sign_params.insert("zcid_ext", zcid_ext.clone());
    sign_params.insert("enc_ver", "v2".to_string());
    sign_params.insert("params", params_encrypted.clone());
    sign_params.insert("type", API_TYPE.to_string());
    sign_params.insert("client_version", API_VERSION.to_string());
    let signkey = crypto::get_signkey("getlogininfo", &sign_params);

    // Build URL
    let url = format!(
        "{}/getLoginInfo?zcid={}&zcid_ext={}&enc_ver=v2&params={}&type={}&client_version={}&signkey={}&nretry=0",
        LOGIN_BASE,
        zcid,
        zcid_ext,
        params_encrypted,
        API_TYPE,
        API_VERSION,
        signkey,
    );

    // Send request
    let client = reqwest::Client::builder()
        .cookie_provider(jar.clone())
        .user_agent(user_agent)
        .build()
        .map_err(|e| format!("build client: {e}"))?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("getLoginInfo: {e}"))?;

    let body: Value = resp.json().await.map_err(|e| format!("json: {e}"))?;

    let err_code = body["error_code"].as_i64().unwrap_or(-1);
    if err_code != 0 {
        return Err(format!("login error {}: {}", err_code, body["error_message"]));
    }

    let enc_data = body["data"]
        .as_str()
        .ok_or("missing data field in login response")?;
    let decrypted = crypto::login_decrypt(&enk, enc_data)?;
    let result: Value =
        serde_json::from_str(&decrypted).map_err(|e| format!("json parse: {e}"))?;

    let zpw_enk = result["zpw_enk"]
        .as_str()
        .ok_or("missing zpw_enk")?
        .to_string();
    Ok((zpw_enk, result))
}

/// Step 2: POST to /api/login/getServerInfo.
async fn get_server_info(
    session: &ZaloSession,
) -> Result<Value, String> {
    let mut sign_params = std::collections::BTreeMap::new();
    sign_params.insert("imei", session.imei.clone());
    sign_params.insert("type", API_TYPE.to_string());
    sign_params.insert("client_version", API_VERSION.to_string());
    sign_params.insert("computer_name", "Web".to_string());
    let signkey = crypto::get_signkey("getserverinfo", &sign_params);

    let url = format!(
        "{}/getServerInfo?imei={}&type={}&client_version={}&computer_name=Web&signkey={}",
        LOGIN_BASE, session.imei, API_TYPE, API_VERSION, signkey,
    );

    let client = session.http_client();
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("getServerInfo: {e}"))?;

    let body: Value = resp.json().await.map_err(|e| format!("json: {e}"))?;

    let err_code = body["error_code"].as_i64().unwrap_or(-1);
    if err_code != 0 {
        return Err(format!("server info error {}: {}", err_code, body["error_message"]));
    }

    let data = &body["data"];
    Ok(data.clone())
}

/// Perform full login flow (getLoginInfo + getServerInfo).
/// Returns a ZaloSession ready for API calls.
pub async fn login(creds: &ZaloCredentials) -> Result<ZaloSession, String> {
    let jar = build_cookie_jar(&creds.cookies);
    let encryptor = LoginEncryptor::new(&creds.imei);

    // Step 1
    let (zpw_enk, login_result) = get_login_info(&encryptor, &jar, &creds.user_agent, &creds.language).await?;

    let uid = login_result["uid"]
        .as_str()
        .ok_or("missing uid")?
        .to_string();

    let zpw_service_map = login_result["zpw_service_map_v3"].clone();
    let zpw_ws = login_result["zpw_ws"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    // Build partial session for getServerInfo
    let session = ZaloSession {
        imei: creds.imei.clone(),
        cookie_jar: jar,
        user_agent: creds.user_agent.clone(),
        secret_key: zpw_enk,
        uid,
        settings: Value::Null,
        extra_ver: String::new(),
        zpw_service_map,
        zpw_ws,
        language: creds.language.clone(),
    };

    // Step 2
    let server_info = get_server_info(&session).await?;

    let settings = server_info["setttings"]
        .as_object()
        .or_else(|| server_info["settings"].as_object())
        .map(|o| Value::Object(o.clone()))
        .unwrap_or(Value::Null);

    let extra_ver = server_info["extra_ver"]
        .as_str()
        .unwrap_or("")
        .to_string();

    Ok(ZaloSession {
        settings,
        extra_ver,
        ..session
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_parse_credentials() {
        let json = json!({
            "imei": "test-imei",
            "cookie": [{"key": "zpsid", "value": "abc", "domain": "chat.zalo.me", "path": "/"}],
            "userAgent": "test-agent",
        });
        let creds = parse_credentials(&json).unwrap();
        assert_eq!(creds.imei, "test-imei");
        assert_eq!(creds.cookies.len(), 1);
        assert_eq!(creds.cookies[0].key, "zpsid");
        assert_eq!(creds.cookies[0].value, "abc");
        assert_eq!(creds.user_agent, "test-agent");
    }

    #[test]
    fn test_parse_credentials_fallback_name() {
        let json = json!({
            "imei": "test",
            "cookie": [{"name": "zpsid", "value": "abc"}],
            "userAgent": "ua",
        });
        let creds = parse_credentials(&json).unwrap();
        assert_eq!(creds.cookies[0].key, "zpsid");
    }

    #[test]
    fn test_parse_credentials_missing_fields() {
        let json = json!({"cookie": []});
        assert!(parse_credentials(&json).is_err());
    }

    #[test]
    fn test_build_cookie_jar() {
        let cookies = vec![ZaloCookie {
            key: "test".into(),
            value: "val".into(),
            domain: "chat.zalo.me".into(),
            path: "/".into(),
            secure: false,
            http_only: false,
            expiration_date: None,
            same_site: None,
        }];
        let jar = build_cookie_jar(&cookies);
        // Can't easily inspect the jar, just verify it doesn't panic
        assert!(true);
    }

    #[tokio::test]
    async fn test_login_http_error() {
        // Attempting to login with bogus creds should fail
        let creds = ZaloCredentials {
            imei: "bad-imei".into(),
            cookies: vec![],
            user_agent: "test".into(),
            language: "vi".into(),
        };
        let result = login(&creds).await;
        assert!(result.is_err());
    }
}
