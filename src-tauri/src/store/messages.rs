use crate::store::db::Database;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MsgMapEntry {
    pub zalo_msg_id: String,
    pub tg_msg_id: i64,
    pub zalo_id: String,
    pub thread_type: i64,
    pub uid_from: String,
    pub ts: String,
    pub msg_type: String,
    pub content: String,
    pub ttl: i64,
}

impl Database {
    pub fn get_tg_msg_id(&self, zalo_msg_id: &str) -> Option<i64> {
        let conn = self.conn();
        conn.query_row(
            "SELECT tg_msg_id FROM message_map WHERE zalo_msg_id = ?1",
            rusqlite::params![zalo_msg_id],
            |row| row.get(0),
        )
        .ok()
    }

    pub fn get_zalo_msg(&self, tg_msg_id: i64) -> Option<MsgMapEntry> {
        let conn = self.conn();
        conn.query_row(
            "SELECT zalo_msg_id, tg_msg_id, zalo_id, thread_type, uid_from, ts, msg_type, content, ttl FROM message_map WHERE tg_msg_id = ?1",
            rusqlite::params![tg_msg_id],
            |row| {
                Ok(MsgMapEntry {
                    zalo_msg_id: row.get(0)?,
                    tg_msg_id: row.get(1)?,
                    zalo_id: row.get(2)?,
                    thread_type: row.get(3)?,
                    uid_from: row.get(4)?,
                    ts: row.get(5)?,
                    msg_type: row.get(6)?,
                    content: row.get(7)?,
                    ttl: row.get(8)?,
                })
            },
        )
        .ok()
    }

    pub fn insert_msg_map(&self, entry: &MsgMapEntry) {
        let conn = self.conn();
        conn.execute(
            "INSERT OR REPLACE INTO message_map (zalo_msg_id, tg_msg_id, zalo_id, thread_type, uid_from, ts, msg_type, content, ttl) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![entry.zalo_msg_id, entry.tg_msg_id, entry.zalo_id, entry.thread_type, entry.uid_from, entry.ts, entry.msg_type, entry.content, entry.ttl],
        )
        .unwrap();
    }

    pub fn delete_msg_map_by_zalo(&self, zalo_msg_id: &str) {
        let conn = self.conn();
        conn.execute(
            "DELETE FROM message_map WHERE zalo_msg_id = ?1",
            rusqlite::params![zalo_msg_id],
        )
        .unwrap();
    }

    pub fn delete_msg_map_by_tg(&self, tg_msg_id: i64) {
        let conn = self.conn();
        conn.execute(
            "DELETE FROM message_map WHERE tg_msg_id = ?1",
            rusqlite::params![tg_msg_id],
        )
        .unwrap();
    }

    pub fn msg_map_count(&self) -> usize {
        let conn = self.conn();
        conn.query_row("SELECT COUNT(*) FROM message_map", [], |row| row.get::<_, usize>(0))
            .unwrap_or(0)
    }
}
