#[cfg(test)]
mod tests {
    use crate::store::db::Database;
    use crate::store::topics::TopicEntry;

    fn setup() -> Database {
        Database::open_in_memory().expect("db")
    }

    #[test]
    fn test_list_topics_empty() {
        let db = setup();
        assert!(db.list_topics().is_empty());
        assert_eq!(db.topic_count(), 0);
    }

    #[test]
    fn test_upsert_and_list() {
        let db = setup();
        let entry = TopicEntry { topic_id: 1, zalo_id: "zid1".into(), thread_type: 2, name: "Test Group".into() };
        db.upsert_topic(&entry);
        assert_eq!(db.topic_count(), 1);

        let topics = db.list_topics();
        assert_eq!(topics.len(), 1);
        assert_eq!(topics[0].name, "Test Group");
    }

    #[test]
    fn test_upsert_replace() {
        let db = setup();
        db.upsert_topic(&TopicEntry { topic_id: 1, zalo_id: "zid1".into(), thread_type: 2, name: "Old".into() });
        db.upsert_topic(&TopicEntry { topic_id: 1, zalo_id: "zid1".into(), thread_type: 2, name: "New".into() });
        let t = db.get_topic_by_id(1).unwrap();
        assert_eq!(t.name, "New");
    }

    #[test]
    fn test_get_by_zalo() {
        let db = setup();
        db.upsert_topic(&TopicEntry { topic_id: 5, zalo_id: "abc".into(), thread_type: 1, name: "X".into() });
        let t = db.get_topic_by_zalo("abc", 1).unwrap();
        assert_eq!(t.topic_id, 5);
        assert!(db.get_topic_by_zalo("abc", 2).is_none());
    }

    #[test]
    fn test_remove() {
        let db = setup();
        db.upsert_topic(&TopicEntry { topic_id: 1, zalo_id: "z1".into(), thread_type: 0, name: "A".into() });
        db.remove_topic(1);
        assert_eq!(db.topic_count(), 0);
    }

    #[test]
    fn test_remove_by_zalo() {
        let db = setup();
        db.upsert_topic(&TopicEntry { topic_id: 1, zalo_id: "z1".into(), thread_type: 0, name: "A".into() });
        db.remove_topic_by_zalo("z1", 0);
        assert_eq!(db.topic_count(), 0);
        // wrong thread_type should not remove
        db.upsert_topic(&TopicEntry { topic_id: 2, zalo_id: "z2".into(), thread_type: 1, name: "B".into() });
        db.remove_topic_by_zalo("z2", 0);
        assert_eq!(db.topic_count(), 1);
    }

    #[test]
    fn test_multiple_topics() {
        let db = setup();
        for i in 0..5 {
            db.upsert_topic(&TopicEntry {
                topic_id: i,
                zalo_id: format!("z{i}"),
                thread_type: i % 2,
                name: format!("Topic {i}"),
            });
        }
        assert_eq!(db.topic_count(), 5);
        let list = db.list_topics();
        assert_eq!(list.len(), 5);
    }
}

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
