use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use aes_gcm::{Aes256Gcm, Key as GcmKey, KeyInit, Nonce};
use aes_gcm::aead::{Aead, Payload};
use base64::Engine;
use md5::{Digest, Md5};
use std::collections::BTreeMap;

type Aes128CbcEnc = cbc::Encryptor<aes::Aes128>;
type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;

const ZERO_IV: [u8; 16] = [0u8; 16];
const LOGIN_AES_KEY: &str = "3FC4F0D2AB50057BCE0D90D9187A22B1";

/// AES-128-CBC encrypt with null IV.
/// Key is Base64-decoded (post-login secretKey usage).
/// Returns Base64-encoded ciphertext.
pub fn aes_cbc_encrypt(secret_key_b64: &str, plaintext: &str) -> Result<String, String> {
    let key_bytes =
        base64::engine::general_purpose::STANDARD
            .decode(secret_key_b64)
            .map_err(|e| format!("base64 decode key: {e}"))?;
    if key_bytes.len() != 16 {
        return Err("key must be 16 bytes for AES-128".into());
    }
    let mut buf = plaintext.as_bytes().to_vec();
    buf.resize(buf.len() + 16, 0u8);
    let ct = Aes128CbcEnc::new(key_bytes.as_slice().into(), &ZERO_IV.into())
        .encrypt_padded_mut::<Pkcs7>(&mut buf, plaintext.len())
        .map_err(|e| format!("encrypt: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(ct))
}

/// AES-128-CBC decrypt with null IV.
/// Key is Base64-decoded (post-login secretKey usage).
/// Input is URL-encoded Base64 ciphertext.
/// Returns UTF-8 plaintext.
pub fn aes_cbc_decrypt(secret_key_b64: &str, ciphertext_b64: &str) -> Result<String, String> {
    let key_bytes = base64::engine::general_purpose::STANDARD
        .decode(secret_key_b64)
        .map_err(|e| format!("base64 decode key: {e}"))?;
    if key_bytes.len() != 16 {
        return Err("key must be 16 bytes for AES-128".into());
    }
    let decoded = urlencoding::decode(ciphertext_b64).map_err(|e| format!("url decode: {e}"))?;
    let ct = base64::engine::general_purpose::STANDARD
        .decode(decoded.as_bytes())
        .map_err(|e| format!("base64 decode ct: {e}"))?;
    let mut buf = ct.to_vec();
    let pt = Aes128CbcDec::new(key_bytes.as_slice().into(), &ZERO_IV.into())
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .map_err(|e| format!("decrypt: {e}"))?;
    String::from_utf8(pt.to_vec()).map_err(|e| format!("utf8 decode: {e}"))
}

/// AES-128-CBC encrypt with a UTF-8 string key (truncated to 16 bytes), null IV, PKCS7.
/// Output: hex-encoded, uppercase.
pub fn aes_cbc_encrypt_utf8_key_hex(key_utf8: &str, plaintext: &str) -> Result<String, String> {
    let key_bytes = &key_utf8.as_bytes()[..16.min(key_utf8.len())];
    let mut buf = plaintext.as_bytes().to_vec();
    buf.resize(buf.len() + 16, 0u8);
    let ct = Aes128CbcEnc::new(key_bytes.into(), &ZERO_IV.into())
        .encrypt_padded_mut::<Pkcs7>(&mut buf, plaintext.len())
        .map_err(|e| format!("encrypt: {e}"))?;
    Ok(hex::encode_upper(ct))
}

/// Login-specific ParamsEncryptor: uses hardcoded key, hex uppercase output.
pub fn login_encrypt_hex(plaintext: &str) -> Result<String, String> {
    aes_cbc_encrypt_utf8_key_hex(LOGIN_AES_KEY, plaintext)
}

/// Login response decrypt: key is UTF-8 bytes (truncated to 16), null IV.
/// ciphertext_b64 is URL-encoded Base64.
pub fn login_decrypt(key_utf8: &str, ciphertext_b64: &str) -> Result<String, String> {
    let key_bytes = &key_utf8.as_bytes()[..16.min(key_utf8.len())];
    let decoded = urlencoding::decode(ciphertext_b64).map_err(|e| format!("url decode: {e}"))?;
    let ct = base64::engine::general_purpose::STANDARD
        .decode(decoded.as_bytes())
        .map_err(|e| format!("base64 decode: {e}"))?;
    let mut buf = ct.to_vec();
    let pt = Aes128CbcDec::new(key_bytes.into(), &ZERO_IV.into())
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .map_err(|e| format!("login decrypt: {e}"))?;
    String::from_utf8(pt.to_vec()).map_err(|e| format!("utf8: {e}"))
}

/// AES-256-GCM decrypt for WebSocket events.
/// Buffer format: IV(16) + AAD(16) + ciphertext(+tag)(rest)
/// Key is Base64-decoded cipherKey.
pub fn aes_gcm_decrypt(cipher_key_b64: &str, data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < 32 {
        return Err("data too short for GCM".into());
    }
    let key_bytes = base64::engine::general_purpose::STANDARD
        .decode(cipher_key_b64)
        .map_err(|e| format!("base64 decode key: {e}"))?;
    let key = GcmKey::<Aes256Gcm>::from_slice(&key_bytes);
    let cipher = Aes256Gcm::new(key);

    let nonce = Nonce::from_slice(&data[..16]);
    let aad = &data[16..32];
    let ct = &data[32..];

    let pt = cipher
        .decrypt(nonce, Payload { msg: ct, aad })
        .map_err(|e| format!("gcm decrypt: {e}"))?;
    Ok(pt)
}

/// Compute MD5 hex digest (lowercase).
pub fn md5_hex(data: &str) -> String {
    let digest = Md5::digest(data.as_bytes());
    hex::encode(digest)
}

/// Compute signkey: MD5("zsecure" + type + sorted_values_of_params)
pub fn get_signkey(cmd_type: &str, params: &BTreeMap<&str, String>) -> String {
    let mut input = format!("zsecure{cmd_type}");
    for (_k, v) in params.iter() {
        input.push_str(v);
    }
    md5_hex(&input)
}

/// Generate IMEI: random UUID v4 + "-" + MD5(userAgent)
pub fn generate_imei(user_agent: &str) -> String {
    let uuid = uuid::Uuid::new_v4();
    format!("{}-{}", uuid, md5_hex(user_agent))
}

/// Compute the encrypt key used during login (ParamsEncryptor.createEncryptKey).
/// zcid: hex string. zcid_ext: random hex string.
pub fn create_encrypt_key(zcid: &str, zcid_ext: &str) -> String {
    let hash = md5_hex(zcid_ext);
    let hash_even: String = hash.chars().step_by(2).collect();
    let zcid_even: String = zcid.chars().step_by(2).collect();
    let zcid_odd_rev: String = zcid.chars().skip(1).step_by(2).collect::<String>()
        .chars().rev().collect();
    format!(
        "{}{}{}",
        &hash_even[..8.min(hash_even.len())],
        &zcid_even[..12.min(zcid_even.len())],
        &zcid_odd_rev[..12.min(zcid_odd_rev.len())],
    )
}

/// Base64 decode helper.
pub fn b64_decode(data: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| format!("base64: {e}"))
}

/// Base64 encode helper.
pub fn b64_encode(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_md5_hex() {
        assert_eq!(md5_hex("hello"), "5d41402abc4b2a76b9719d911017c592");
        assert_eq!(md5_hex(""), "d41d8cd98f00b204e9800998ecf8427e");
    }

    #[test]
    fn test_generate_imei_format() {
        let imei = generate_imei("test-agent");
        let parts: Vec<&str> = imei.split('-').collect();
        // UUID v4 has 5 groups separated by hyphens, then MD5
        // The join of all UUID groups through the first 5 hyphens plus the MD5
        // Let's just check the total length: UUID (36) + '-' + MD5 (32) = 69
        assert_eq!(imei.len(), 69);
        assert!(imei.contains('-'));
    }

    #[test]
    fn test_get_signkey() {
        let mut params = BTreeMap::new();
        params.insert("imei", "abc123".into());
        params.insert("type", "30".into());
        let sk = get_signkey("getserverinfo", &params);
        // MD5("zsecuregetserverinfo" + "abc123" + "30") sorted alphabetically: imei then type
        // input = "zsecuregetserverinfoabc12330"
        assert_eq!(sk, md5_hex("zsecuregetserverinfoabc12330"));
    }

    #[test]
    fn test_create_encrypt_key_length() {
        let zcid = "A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4";
        let zcid_ext = "DEADBEEF1234";
        let key = create_encrypt_key(zcid, zcid_ext);
        // hash_even[..8] + zcid_even[..12] + zcid_odd_rev[..12] = 32
        assert_eq!(key.len(), 32);
    }

    #[test]
    fn test_aes_cbc_roundtrip() {
        let key_b64 = base64::engine::general_purpose::STANDARD.encode(&[0u8; 16]);
        let pt = "hello world";
        let ct = aes_cbc_encrypt(&key_b64, pt).unwrap();
        let decrypted = aes_cbc_decrypt(&key_b64, &ct).unwrap();
        assert_eq!(decrypted, pt);
    }

    #[test]
    fn test_aes_cbc_with_realistic_key() {
        // Simulate a zpw_enk (Base64 of 16 random bytes)
        let key = base64::engine::general_purpose::STANDARD.encode(b"0123456789abcdef");
        let pt = r#"{"imei":"test","msg":"hi"}"#;
        let ct = aes_cbc_encrypt(&key, pt).unwrap();
        let dec = aes_cbc_decrypt(&key, &ct).unwrap();
        assert_eq!(dec, pt);
    }

    #[test]
    fn test_login_encrypt_hex() {
        let result = login_encrypt_hex("30,test-imei,1234567890").unwrap();
        // Should return a hex string (even length)
        assert!(result.len() % 2 == 0);
        assert!(result.chars().all(|c| c.is_ascii_hexdigit() || c.is_uppercase()));
    }

    #[test]
    fn test_b64_encode_decode() {
        let data = b"hello";
        let encoded = b64_encode(data);
        let decoded = b64_decode(&encoded).unwrap();
        assert_eq!(decoded, data);
    }

    #[test]
    fn test_aes_gcm_decrypt_too_short() {
        let result = aes_gcm_decrypt("dGVzdCBrZXk=", &[0u8; 10]);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("too short"));
    }
}
