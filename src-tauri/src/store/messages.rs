#[cfg(test)]
mod tests {
    use crate::store::db::Database;
    use crate::store::messages::MsgMapEntry;

    fn setup() -> Database {
        Database::open_in_memory().expect("db")
    }

    fn entry(zalo_msg_id: &str, tg_msg_id: i64) -> MsgMapEntry {
        MsgMapEntry {
            zalo_msg_id: zalo_msg_id.into(),
            tg_msg_id,
            zalo_id: "zid1".into(),
            thread_type: 0,
            uid_from: "user1".into(),
            ts: "2024-01-01T00:00:00Z".into(),
            msg_type: "text".into(),
            content: "{\"text\":\"hello\"}".into(),
            ttl: 0,
        }
    }

    #[test]
    fn test_insert_and_lookup() {
        let db = setup();
        db.insert_msg_map(&entry("zmsg1", 100));

        assert_eq!(db.get_tg_msg_id("zmsg1"), Some(100));
        let got = db.get_zalo_msg(100).unwrap();
        assert_eq!(got.zalo_msg_id, "zmsg1");
        assert_eq!(got.tg_msg_id, 100);
        assert_eq!(got.uid_from, "user1");

        // nonexistent
        assert!(db.get_tg_msg_id("nonexistent").is_none());
        assert!(db.get_zalo_msg(999).is_none());
    }

    #[test]
    fn test_insert_replace() {
        let db = setup();
        db.insert_msg_map(&entry("zmsg1", 100));
        db.insert_msg_map(&entry("zmsg1", 200));
        // same zalo_msg_id should map to new tg_msg_id
        assert_eq!(db.get_tg_msg_id("zmsg1"), Some(200));
        assert!(db.get_zalo_msg(100).is_none());
        assert!(db.get_zalo_msg(200).is_some());
    }

    #[test]
    fn test_delete_by_zalo() {
        let db = setup();
        db.insert_msg_map(&entry("z1", 1));
        db.insert_msg_map(&entry("z2", 2));
        db.delete_msg_map_by_zalo("z1");
        assert!(db.get_tg_msg_id("z1").is_none());
        assert_eq!(db.get_tg_msg_id("z2"), Some(2));
        assert_eq!(db.msg_map_count(), 1);
    }

    #[test]
    fn test_delete_by_tg() {
        let db = setup();
        db.insert_msg_map(&entry("z1", 1));
        db.insert_msg_map(&entry("z2", 2));
        db.delete_msg_map_by_tg(1);
        assert!(db.get_tg_msg_id("z1").is_none());
        assert_eq!(db.get_tg_msg_id("z2"), Some(2));
        assert_eq!(db.msg_map_count(), 1);
    }

    #[test]
    fn test_count() {
        let db = setup();
        assert_eq!(db.msg_map_count(), 0);
        db.insert_msg_map(&entry("z1", 1));
        assert_eq!(db.msg_map_count(), 1);
        db.insert_msg_map(&entry("z2", 2));
        assert_eq!(db.msg_map_count(), 2);
    }

    #[test]
    fn test_full_entry_roundtrip() {
        let db = setup();
        let e = MsgMapEntry {
            zalo_msg_id: "z_test".into(),
            tg_msg_id: 42,
            zalo_id: "group_xyz".into(),
            thread_type: 2,
            uid_from: "alice".into(),
            ts: "2024-06-15T10:30:00Z".into(),
            msg_type: "photo".into(),
            content: "{\"url\":\"...\"}".into(),
            ttl: 3600,
        };
        db.insert_msg_map(&e);
        let got = db.get_zalo_msg(42).unwrap();
        assert_eq!(got.zalo_msg_id, e.zalo_msg_id);
        assert_eq!(got.tg_msg_id, e.tg_msg_id);
        assert_eq!(got.zalo_id, e.zalo_id);
        assert_eq!(got.thread_type, e.thread_type);
        assert_eq!(got.uid_from, e.uid_from);
        assert_eq!(got.ts, e.ts);
        assert_eq!(got.msg_type, e.msg_type);
        assert_eq!(got.content, e.content);
        assert_eq!(got.ttl, e.ttl);
    }
}

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
