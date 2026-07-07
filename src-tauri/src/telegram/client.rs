use reqwest::Client as HttpClient;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const API_BASE: &str = "https://api.telegram.org/bot";

#[derive(Debug, Clone)]
pub struct TelegramClient {
    http: HttpClient,
    token: String,
    base_url: String,
}

#[derive(Debug, Deserialize)]
pub struct TgResponse<T> {
    pub ok: bool,
    pub description: Option<String>,
    pub result: Option<T>,
}

#[derive(Debug, Serialize)]
pub struct SendMessageParams {
    pub chat_id: i64,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parse_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_thread_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to_message_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disable_notification: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_markup: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct TgMessage {
    pub message_id: i64,
    pub chat: TgChat,
    pub text: Option<String>,
    pub date: i64,
}

#[derive(Debug, Deserialize)]
pub struct TgChat {
    pub id: i64,
    #[serde(rename = "type")]
    pub chat_type: String,
    pub title: Option<String>,
    pub username: Option<String>,
    pub first_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TgFile {
    pub file_id: String,
    pub file_unique_id: String,
    pub file_size: Option<i64>,
    pub file_path: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TgUser {
    pub id: i64,
    pub is_bot: bool,
    pub first_name: String,
    pub username: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TgChatMember {
    pub user: TgUser,
    pub status: String,
}

#[derive(Debug, Serialize)]
pub struct EditMessageTextParams {
    pub chat_id: i64,
    pub message_id: i64,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parse_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_markup: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
pub struct ForumTopic {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_color: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct ForumTopicCreated {
    pub message_thread_id: i64,
    pub name: String,
    pub icon_color: i64,
}

#[derive(Debug, Serialize)]
pub struct ReactionParam {
    #[serde(rename = "type")]
    pub reaction_type: String,
    pub emoji: String,
}

impl TelegramClient {
    pub fn new(token: &str) -> Self {
        Self {
            http: HttpClient::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .unwrap(),
            token: token.to_string(),
            base_url: format!("{API_BASE}{token}"),
        }
    }

    pub fn new_with_local(token: &str, local_api_url: &str) -> Self {
        Self {
            http: HttpClient::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .unwrap(),
            token: token.to_string(),
            base_url: local_api_url.trim_end_matches('/').to_string(),
        }
    }

    async fn call<T: DeserializeOwned>(
        &self,
        method: &str,
        params: &impl Serialize,
    ) -> Result<T, String> {
        let url = format!("{}/{method}", self.base_url);
        let resp: TgResponse<T> = self
            .http
            .post(&url)
            .json(params)
            .send()
            .await
            .map_err(|e| format!("tg request {method}: {e}"))?
            .json()
            .await
            .map_err(|e| format!("tg parse {method}: {e}"))?;
        if resp.ok {
            resp.result.ok_or_else(|| format!("tg {method}: empty result"))
        } else {
            Err(resp.description.unwrap_or_else(|| "unknown error".into()))
        }
    }

    pub async fn send_message(&self, params: &SendMessageParams) -> Result<TgMessage, String> {
        self.call("sendMessage", params).await
    }

    pub async fn edit_message_text(&self, params: &EditMessageTextParams) -> Result<TgMessage, String> {
        self.call("editMessageText", params).await
    }

    pub async fn delete_message(&self, chat_id: i64, message_id: i64) -> Result<bool, String> {
        #[derive(Serialize)]
        struct P {
            chat_id: i64,
            message_id: i64,
        }
        self.call("deleteMessage", &P { chat_id, message_id }).await
    }

    pub async fn get_chat_member(&self, chat_id: i64, user_id: i64) -> Result<TgChatMember, String> {
        #[derive(Serialize)]
        struct P {
            chat_id: i64,
            user_id: i64,
        }
        self.call("getChatMember", &P { chat_id, user_id }).await
    }

    pub async fn get_file(&self, file_id: &str) -> Result<TgFile, String> {
        #[derive(Serialize)]
        struct P {
            file_id: String,
        }
        self.call("getFile", &P { file_id: file_id.into() }).await
    }

    pub fn file_url(&self, file_path: &str) -> String {
        format!("{}/{}", self.base_url.replace("bot", "file/bot"), file_path)
    }

    pub async fn create_forum_topic(
        &self,
        chat_id: i64,
        name: &str,
    ) -> Result<ForumTopicCreated, String> {
        #[derive(Serialize)]
        struct P {
            chat_id: i64,
            name: String,
        }
        self.call("createForumTopic", &P { chat_id, name: name.into() }).await
    }

    pub async fn close_forum_topic(&self, chat_id: i64, thread_id: i64) -> Result<bool, String> {
        #[derive(Serialize)]
        struct P {
            chat_id: i64,
            message_thread_id: i64,
        }
        self.call("closeForumTopic", &P { chat_id, message_thread_id: thread_id }).await
    }

    pub async fn edit_forum_topic(&self, chat_id: i64, thread_id: i64, name: &str) -> Result<bool, String> {
        #[derive(Serialize)]
        struct P {
            chat_id: i64,
            message_thread_id: i64,
            name: String,
        }
        self.call("editForumTopic", &P {
            chat_id,
            message_thread_id: thread_id,
            name: name.into(),
        }).await
    }

    pub async fn set_message_reaction(
        &self,
        chat_id: i64,
        message_id: i64,
        reaction: Option<Vec<ReactionParam>>,
    ) -> Result<bool, String> {
        #[derive(Serialize)]
        struct P {
            chat_id: i64,
            message_id: i64,
            reaction: Option<Vec<ReactionParam>>,
        }
        self.call("setMessageReaction", &P { chat_id, message_id, reaction }).await
    }

    pub async fn send_chat_action(&self, chat_id: i64, action: &str) -> Result<bool, String> {
        #[derive(Serialize)]
        struct P {
            chat_id: i64,
            action: String,
        }
        self.call("sendChatAction", &P { chat_id: chat_id as i64, action: action.into() }).await
    }
}
