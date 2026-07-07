use crate::store::db::Database;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopicEntry {
    pub topic_id: i64,
    pub zalo_id: String,
    pub thread_type: i64,
    pub name: String,
}

impl Database {
    pub fn list_topics(&self) -> Vec<TopicEntry> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare("SELECT topic_id, zalo_id, thread_type, name FROM topics ORDER BY name")
            .unwrap();
        stmt.query_map([], |row| {
            Ok(TopicEntry {
                topic_id: row.get(0)?,
                zalo_id: row.get(1)?,
                thread_type: row.get(2)?,
                name: row.get(3)?,
            })
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect()
    }

    pub fn get_topic_by_zalo(&self, zalo_id: &str, thread_type: i64) -> Option<TopicEntry> {
        let conn = self.conn();
        conn.query_row(
            "SELECT topic_id, zalo_id, thread_type, name FROM topics WHERE zalo_id = ?1 AND thread_type = ?2",
            rusqlite::params![zalo_id, thread_type],
            |row| {
                Ok(TopicEntry {
                    topic_id: row.get(0)?,
                    zalo_id: row.get(1)?,
                    thread_type: row.get(2)?,
                    name: row.get(3)?,
                })
            },
        )
        .ok()
    }

    pub fn get_topic_by_id(&self, topic_id: i64) -> Option<TopicEntry> {
        let conn = self.conn();
        conn.query_row(
            "SELECT topic_id, zalo_id, thread_type, name FROM topics WHERE topic_id = ?1",
            rusqlite::params![topic_id],
            |row| {
                Ok(TopicEntry {
                    topic_id: row.get(0)?,
                    zalo_id: row.get(1)?,
                    thread_type: row.get(2)?,
                    name: row.get(3)?,
                })
            },
        )
        .ok()
    }

    pub fn upsert_topic(&self, entry: &TopicEntry) {
        let conn = self.conn();
        conn.execute(
            "INSERT OR REPLACE INTO topics (topic_id, zalo_id, thread_type, name) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![entry.topic_id, entry.zalo_id, entry.thread_type, entry.name],
        )
        .unwrap();
    }

    pub fn remove_topic(&self, topic_id: i64) {
        let conn = self.conn();
        conn.execute("DELETE FROM topics WHERE topic_id = ?1", rusqlite::params![topic_id])
            .unwrap();
    }

    pub fn remove_topic_by_zalo(&self, zalo_id: &str, thread_type: i64) {
        let conn = self.conn();
        conn.execute(
            "DELETE FROM topics WHERE zalo_id = ?1 AND thread_type = ?2",
            rusqlite::params![zalo_id, thread_type],
        )
        .unwrap();
    }

    pub fn topic_count(&self) -> usize {
        let conn = self.conn();
        conn.query_row("SELECT COUNT(*) FROM topics", [], |row| row.get::<_, usize>(0))
            .unwrap_or(0)
    }
}
