use serde::{Deserialize, Serialize};

/// Thread types: User (DM) = 0, Group = 1
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ThreadType {
    User = 0,
    Group = 1,
}

impl ThreadType {
    pub fn from_i64(v: i64) -> Self {
        match v {
            0 => ThreadType::User,
            _ => ThreadType::Group,
        }
    }
}

/// Zalo message types
pub mod msg_type {
    pub const TEXT: &str = "webchat";
    pub const PHOTO: &str = "chat.photo";
    pub const VOICE: &str = "chat.voice";
    pub const STICKER: &str = "chat.sticker";
    pub const VIDEO: &str = "chat.video.msg";
    pub const FILE: &str = "share.file";
    pub const GIF: &str = "chat.gif";
    pub const LINK: &str = "chat.recommended";
    pub const LOCATION: &str = "chat.location.new";
    pub const POLL: &str = "group.poll";
    pub const CONTACT: &str = "chat.forward";
}

/// Media content from a Zalo attachment message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZaloMediaContent {
    pub href: Option<String>,
    pub thumb: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub params: Option<String>,
    pub action: Option<String>,
}

/// @mention inside a group message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZaloMention {
    pub uid: String,
    pub pos: i64,
    pub len: i64,
    #[serde(rename = "type")]
    pub mention_type: i64,
}

/// Reply-to / quote metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZaloQuote {
    pub owner_id: String,
    pub cli_msg_id: i64,
    pub global_msg_id: i64,
    pub msg: String,
    pub ts: String,
    pub ttl: i64,
}

/// Incoming Zalo message data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZaloMessageData {
    pub content: serde_json::Value,
    pub msg_id: String,
    pub cli_msg_id: Option<String>,
    pub uid_from: String,
    pub d_name: Option<String>,
    pub id_to: String,
    pub ts: String,
    #[serde(rename = "msgType")]
    pub msg_type: Option<String>,
    pub ttl: Option<i64>,
    pub quote: Option<ZaloQuote>,
    pub mentions: Option<Vec<ZaloMention>>,
}

/// Parsed incoming Zalo message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZaloMessage {
    #[serde(rename = "type")]
    pub thread_type: i64,
    pub data: ZaloMessageData,
    pub is_self: bool,
    pub thread_id: String,
}

/// Group info
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZaloGroupInfo {
    pub name: String,
    pub avt: Option<String>,
    pub total_member: Option<i64>,
}

/// Group info response (from getGroupInfo API)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZaloGroupInfoResponse {
    pub grid_info_map: std::collections::HashMap<String, ZaloGroupInfo>,
}

/// Login credential for persistent sessions
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZaloCredentials {
    pub imei: String,
    pub cookie: serde_json::Value,
    pub user_agent: String,
}

/// Friend info (from getAllFriends API)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZaloFriend {
    pub user_id: String,
    pub display_name: String,
    pub avatar: Option<String>,
}

/// Group member
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZaloGroupMember {
    pub uid: String,
    pub display_name: String,
}

/// Poll option
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZaloPollOption {
    pub option_id: i64,
    pub content: String,
}

/// Poll data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZaloPollData {
    pub poll_id: i64,
    pub question: String,
    pub options: Vec<ZaloPollOption>,
    pub group_id: String,
    pub creator_id: String,
}

/// Reaction data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZaloReaction {
    pub msg_id: String,
    pub reaction_type: i64,
    pub source_uid: String,
}

/// QR login hook callbacks
pub struct QRLoginHooks {
    pub on_qr_ready: Option<Box<dyn Fn(String, String) + Send + Sync>>,
    pub on_scanned: Option<Box<dyn Fn(String) + Send + Sync>>,
    pub on_expired: Option<Box<dyn Fn() + Send + Sync>>,
    pub on_success: Option<Box<dyn Fn(ZaloCredentials) + Send + Sync>>,
}
