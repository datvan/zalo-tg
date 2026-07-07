#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn mock_body() -> serde_json::Value {
        serde_json::json!({"ok": true, "result": {
            "message_id": 100,
            "chat": {"id": -123, "type": "supergroup", "title": "Test"},
            "text": "hello",
            "date": 1700000000
        }})
    }

    #[tokio::test]
    async fn test_new_default_api() {
        let client = TelegramClient::new("token123");
        assert!(client.base_url.contains("api.telegram.org"));
    }

    #[tokio::test]
    async fn test_new_with_local_api() {
        let client = TelegramClient::new_with_local("token123", "http://localhost:8081/bot");
        assert_eq!(client.base_url, "http://localhost:8081/bot");
    }

    #[tokio::test]
    async fn test_local_api_url_strips_trailing_slash() {
        let client = TelegramClient::new_with_local("t", "http://localhost:8081/bot/");
        assert_eq!(client.base_url, "http://localhost:8081/bot");
    }

    #[tokio::test]
    async fn test_send_message_success() {
        let mock_server = MockServer::start().await;
        let client = TelegramClient::new_with_local("fake", &mock_server.uri());

        Mock::given(method("POST"))
            .and(path("/sendMessage"))
            .respond_with(ResponseTemplate::new(200).set_body_json(mock_body()))
            .expect(1)
            .mount(&mock_server)
            .await;

        let params = SendMessageParams {
            chat_id: -123,
            text: "hello".into(),
            parse_mode: None,
            message_thread_id: None,
            reply_to_message_id: None,
            disable_notification: None,
            reply_markup: None,
        };
        let msg = client.send_message(&params).await.unwrap();
        assert_eq!(msg.message_id, 100);
        assert_eq!(msg.text, Some("hello".into()));
    }

    #[tokio::test]
    async fn test_send_message_error_response() {
        let mock_server = MockServer::start().await;
        let client = TelegramClient::new_with_local("fake", &mock_server.uri());

        Mock::given(method("POST"))
            .and(path("/sendMessage"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"ok": false, "description": "bot was blocked"})),
            )
            .mount(&mock_server)
            .await;

        let params = SendMessageParams {
            chat_id: -1,
            text: "hi".into(),
            parse_mode: None,
            message_thread_id: None,
            reply_to_message_id: None,
            disable_notification: None,
            reply_markup: None,
        };
        let err = client.send_message(&params).await.unwrap_err();
        assert!(err.contains("bot was blocked"));
    }

    #[tokio::test]
    async fn test_send_message_http_error() {
        let mock_server = MockServer::start().await;
        let client = TelegramClient::new_with_local("fake", &mock_server.uri());

        Mock::given(method("POST"))
            .and(path("/sendMessage"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&mock_server)
            .await;

        let params = SendMessageParams {
            chat_id: 0,
            text: "x".into(),
            parse_mode: None,
            message_thread_id: None,
            reply_to_message_id: None,
            disable_notification: None,
            reply_markup: None,
        };
        let result = client.send_message(&params).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_delete_message() {
        let mock_server = MockServer::start().await;
        let client = TelegramClient::new_with_local("fake", &mock_server.uri());

        Mock::given(method("POST"))
            .and(path("/deleteMessage"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"ok": true, "result": true})),
            )
            .mount(&mock_server)
            .await;

        let ok = client.delete_message(-100, 42).await.unwrap();
        assert!(ok);
    }

    #[tokio::test]
    async fn test_get_chat_member() {
        let mock_server = MockServer::start().await;
        let client = TelegramClient::new_with_local("fake", &mock_server.uri());

        Mock::given(method("POST"))
            .and(path("/getChatMember"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "ok": true, "result": {
                        "user": {"id": 123, "is_bot": false, "first_name": "Alice", "username": "alice_bot"},
                        "status": "member"
                    }
                })),
            )
            .mount(&mock_server)
            .await;

        let member = client.get_chat_member(-100, 123).await.unwrap();
        assert_eq!(member.user.first_name, "Alice");
        assert_eq!(member.status, "member");
    }

    #[tokio::test]
    async fn test_get_file_and_url() {
        let mock_server = MockServer::start().await;
        let client = TelegramClient::new_with_local("fake", &mock_server.uri());

        Mock::given(method("POST"))
            .and(path("/getFile"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "ok": true, "result": {
                        "file_id": "fid123",
                        "file_unique_id": "unq456",
                        "file_size": 1024,
                        "file_path": "documents/file.pdf"
                    }
                })),
            )
            .mount(&mock_server)
            .await;

        let f = client.get_file("fid123").await.unwrap();
        assert_eq!(f.file_path, Some("documents/file.pdf".into()));

        let url = client.file_url("documents/file.pdf");
        let expected_base = client.base_url.replace("bot", "file/bot");
        assert_eq!(url, format!("{expected_base}/documents/file.pdf"));
    }

    #[tokio::test]
    async fn test_create_forum_topic() {
        let mock_server = MockServer::start().await;
        let client = TelegramClient::new_with_local("fake", &mock_server.uri());

        Mock::given(method("POST"))
            .and(path("/createForumTopic"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "ok": true, "result": {
                        "message_thread_id": 42,
                        "name": "Test Topic",
                        "icon_color": 7322096
                    }
                })),
            )
            .mount(&mock_server)
            .await;

        let topic = client.create_forum_topic(-100, "Test Topic").await.unwrap();
        assert_eq!(topic.message_thread_id, 42);
        assert_eq!(topic.name, "Test Topic");
    }

    #[tokio::test]
    async fn test_set_message_reaction() {
        let mock_server = MockServer::start().await;
        let client = TelegramClient::new_with_local("fake", &mock_server.uri());

        Mock::given(method("POST"))
            .and(path("/setMessageReaction"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"ok": true, "result": true})),
            )
            .mount(&mock_server)
            .await;

        let reaction = vec![ReactionParam {
            reaction_type: "emoji".into(),
            emoji: "👍".into(),
        }];
        let ok = client.set_message_reaction(-100, 42, Some(reaction)).await.unwrap();
        assert!(ok);
    }

    #[tokio::test]
    async fn test_edit_message_text() {
        let mock_server = MockServer::start().await;
        let client = TelegramClient::new_with_local("fake", &mock_server.uri());

        Mock::given(method("POST"))
            .and(path("/editMessageText"))
            .respond_with(ResponseTemplate::new(200).set_body_json(mock_body()))
            .mount(&mock_server)
            .await;

        let params = EditMessageTextParams {
            chat_id: -123,
            message_id: 100,
            text: "edited".into(),
            parse_mode: None,
            reply_markup: None,
        };
        let msg = client.edit_message_text(&params).await.unwrap();
        assert_eq!(msg.message_id, 100);
    }

    #[tokio::test]
    async fn test_send_chat_action() {
        let mock_server = MockServer::start().await;
        let client = TelegramClient::new_with_local("fake", &mock_server.uri());

        Mock::given(method("POST"))
            .and(path("/sendChatAction"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"ok": true, "result": true})),
            )
            .mount(&mock_server)
            .await;

        let ok = client.send_chat_action(-100, "typing").await.unwrap();
        assert!(ok);
    }
}

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
pub struct TgUpdate {
    #[serde(default)]
    pub update_id: i64,
    pub message: Option<Box<TgMessage>>,
    pub edited_message: Option<Box<TgMessage>>,
    pub callback_query: Option<TgCallbackQuery>,
    pub message_reaction: Option<TgMessageReaction>,
    pub poll_answer: Option<TgPollAnswer>,
}

#[derive(Debug, Deserialize)]
pub struct TgCallbackQuery {
    pub id: String,
    pub from: TgUser,
    pub message: Option<Box<TgMessage>>,
    pub data: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TgMessageReaction {
    pub chat: TgChat,
    pub message_id: i64,
    pub date: i64,
    pub actor_chat: Option<TgChat>,
    pub old_reaction: Vec<TgReactionType>,
    pub new_reaction: Vec<TgReactionType>,
}

#[derive(Debug, Deserialize)]
pub struct TgReactionType {
    #[serde(rename = "type")]
    pub reaction_type: String,
    pub emoji: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TgPollAnswer {
    pub poll_id: String,
    pub user: TgUser,
    pub option_ids: Vec<i64>,
}

#[derive(Debug, Deserialize)]
pub struct TgMessage {
    pub message_id: i64,
    pub chat: TgChat,
    pub text: Option<String>,
    pub date: i64,
    pub from: Option<TgUser>,
    pub reply_to_message: Option<Box<TgMessage>>,
    pub message_thread_id: Option<i64>,
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

    pub async fn get_updates(&self, offset: Option<i64>, timeout: Option<i64>) -> Result<Vec<TgUpdate>, String> {
        #[derive(Serialize)]
        struct P {
            offset: Option<i64>,
            limit: i64,
            timeout: Option<i64>,
            allowed_updates: Vec<String>,
        }
        self.call("getUpdates", &P {
            offset,
            limit: 100,
            timeout,
            allowed_updates: vec![
                "message".into(),
                "callback_query".into(),
                "message_reaction".into(),
                "poll_answer".into(),
            ],
        }).await
    }

    pub async fn answer_callback_query(&self, query_id: &str, text: Option<&str>) -> Result<bool, String> {
        #[derive(Serialize)]
        struct P {
            callback_query_id: String,
            text: Option<String>,
        }
        self.call("answerCallbackQuery", &P {
            callback_query_id: query_id.into(),
            text: text.map(|s| s.into()),
        }).await
    }
}
