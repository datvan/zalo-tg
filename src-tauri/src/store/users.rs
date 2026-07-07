use crate::store::db::Database;

impl Database {
    pub fn get_user_name(&self, uid: &str) -> Option<String> {
        let conn = self.conn();
        conn.query_row(
            "SELECT display_name FROM user_cache WHERE uid = ?1",
            rusqlite::params![uid],
            |row| row.get(0),
        )
        .ok()
    }

    pub fn upsert_user(&self, uid: &str, display_name: &str) {
        let conn = self.conn();
        conn.execute(
            "INSERT OR REPLACE INTO user_cache (uid, display_name, updated_at) VALUES (?1, ?2, datetime('now'))",
            rusqlite::params![uid, display_name],
        )
        .unwrap();
    }

    pub fn get_group_member_name(&self, group_id: &str, uid: &str) -> Option<String> {
        let conn = self.conn();
        conn.query_row(
            "SELECT display_name FROM group_members WHERE group_id = ?1 AND uid = ?2",
            rusqlite::params![group_id, uid],
            |row| row.get(0),
        )
        .ok()
    }

    pub fn upsert_group_member(&self, group_id: &str, uid: &str, display_name: &str) {
        let conn = self.conn();
        conn.execute(
            "INSERT OR REPLACE INTO group_members (group_id, uid, display_name) VALUES (?1, ?2, ?3)",
            rusqlite::params![group_id, uid, display_name],
        )
        .unwrap();
    }

    pub fn list_group_members(&self, group_id: &str) -> Vec<(String, String)> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare("SELECT uid, display_name FROM group_members WHERE group_id = ?1 ORDER BY display_name")
            .unwrap();
        stmt.query_map(rusqlite::params![group_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .unwrap()
        .filter_map(|r| r.ok())
        .collect()
    }

    pub fn get_alias(&self, uid: &str) -> Option<String> {
        let conn = self.conn();
        conn.query_row(
            "SELECT alias FROM alias_cache WHERE uid = ?1",
            rusqlite::params![uid],
            |row| row.get(0),
        )
        .ok()
    }

    pub fn upsert_alias(&self, uid: &str, alias: &str) {
        let conn = self.conn();
        conn.execute(
            "INSERT OR REPLACE INTO alias_cache (uid, alias, updated_at) VALUES (?1, ?2, datetime('now'))",
            rusqlite::params![uid, alias],
        )
        .unwrap();
    }
}
