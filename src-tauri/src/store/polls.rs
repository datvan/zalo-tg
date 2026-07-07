#[cfg(test)]
mod tests {
    use crate::store::db::Database;
    use crate::store::polls::PollEntry;

    fn setup() -> Database {
        Database::open_in_memory().expect("db")
    }

    fn example() -> PollEntry {
        PollEntry {
            poll_id: 1,
            zalo_group_id: "zg1".into(),
            tg_poll_msg_id: 100,
            tg_poll_uuid: "uuid-abc".into(),
            tg_score_msg_id: 101,
            tg_thread_id: 42,
            question: "Best color?".into(),
            options: "[\"Red\",\"Blue\"]".into(),
        }
    }

    #[test]
    fn test_insert_and_get() {
        let db = setup();
        db.upsert_poll(&example());
        let p = db.get_poll(1).unwrap();
        assert_eq!(p.question, "Best color?");
        assert_eq!(p.options, "[\"Red\",\"Blue\"]");
    }

    #[test]
    fn test_get_by_tg_uuid() {
        let db = setup();
        db.upsert_poll(&example());
        let p = db.get_poll_by_tg_uuid("uuid-abc").unwrap();
        assert_eq!(p.poll_id, 1);
        assert!(db.get_poll_by_tg_uuid("nonexistent").is_none());
    }

    #[test]
    fn test_delete() {
        let db = setup();
        db.upsert_poll(&example());
        assert!(db.get_poll(1).is_some());
        db.delete_poll(1);
        assert!(db.get_poll(1).is_none());
    }

    #[test]
    fn test_upsert_replace() {
        let db = setup();
        db.upsert_poll(&example());
        let mut updated = example();
        updated.question = "New question?".into();
        db.upsert_poll(&updated);
        let p = db.get_poll(1).unwrap();
        assert_eq!(p.question, "New question?");
    }

    #[test]
    fn test_nonexistent() {
        let db = setup();
        assert!(db.get_poll(999).is_none());
        assert!(db.get_poll_by_tg_uuid("nope").is_none());
    }
}

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
