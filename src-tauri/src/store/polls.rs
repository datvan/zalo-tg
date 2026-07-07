use crate::store::db::Database;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PollEntry {
    pub poll_id: i64,
    pub zalo_group_id: String,
    pub tg_poll_msg_id: i64,
    pub tg_poll_uuid: String,
    pub tg_score_msg_id: i64,
    pub tg_thread_id: i64,
    pub question: String,
    pub options: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PollOption {
    pub option_id: i64,
    pub content: String,
}

impl Database {
    pub fn get_poll(&self, poll_id: i64) -> Option<PollEntry> {
        let conn = self.conn();
        conn.query_row(
            "SELECT poll_id, zalo_group_id, tg_poll_msg_id, tg_poll_uuid, tg_score_msg_id, tg_thread_id, question, options FROM polls WHERE poll_id = ?1",
            rusqlite::params![poll_id],
            |row| {
                Ok(PollEntry {
                    poll_id: row.get(0)?,
                    zalo_group_id: row.get(1)?,
                    tg_poll_msg_id: row.get(2)?,
                    tg_poll_uuid: row.get(3)?,
                    tg_score_msg_id: row.get(4)?,
                    tg_thread_id: row.get(5)?,
                    question: row.get(6)?,
                    options: row.get(7)?,
                })
            },
        )
        .ok()
    }

    pub fn get_poll_by_tg_uuid(&self, tg_poll_uuid: &str) -> Option<PollEntry> {
        let conn = self.conn();
        conn.query_row(
            "SELECT poll_id, zalo_group_id, tg_poll_msg_id, tg_poll_uuid, tg_score_msg_id, tg_thread_id, question, options FROM polls WHERE tg_poll_uuid = ?1",
            rusqlite::params![tg_poll_uuid],
            |row| {
                Ok(PollEntry {
                    poll_id: row.get(0)?,
                    zalo_group_id: row.get(1)?,
                    tg_poll_msg_id: row.get(2)?,
                    tg_poll_uuid: row.get(3)?,
                    tg_score_msg_id: row.get(4)?,
                    tg_thread_id: row.get(5)?,
                    question: row.get(6)?,
                    options: row.get(7)?,
                })
            },
        )
        .ok()
    }

    pub fn upsert_poll(&self, entry: &PollEntry) {
        let conn = self.conn();
        conn.execute(
            "INSERT OR REPLACE INTO polls (poll_id, zalo_group_id, tg_poll_msg_id, tg_poll_uuid, tg_score_msg_id, tg_thread_id, question, options) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![entry.poll_id, entry.zalo_group_id, entry.tg_poll_msg_id, entry.tg_poll_uuid, entry.tg_score_msg_id, entry.tg_thread_id, entry.question, entry.options],
        )
        .unwrap();
    }

    pub fn delete_poll(&self, poll_id: i64) {
        let conn = self.conn();
        conn.execute("DELETE FROM polls WHERE poll_id = ?1", rusqlite::params![poll_id])
            .unwrap();
    }
}
