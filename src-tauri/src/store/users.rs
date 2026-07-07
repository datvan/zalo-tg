#[cfg(test)]
mod tests {
    use crate::store::db::Database;

    fn setup() -> Database {
        Database::open_in_memory().expect("db")
    }

    // --- user_cache ---

    #[test]
    fn test_upsert_and_get_user() {
        let db = setup();
        assert!(db.get_user_name("uid1").is_none());
        db.upsert_user("uid1", "Alice");
        assert_eq!(db.get_user_name("uid1"), Some("Alice".into()));
    }

    #[test]
    fn test_upsert_user_replace() {
        let db = setup();
        db.upsert_user("uid1", "Alice");
        db.upsert_user("uid1", "Alicia");
        assert_eq!(db.get_user_name("uid1"), Some("Alicia".into()));
    }

    #[test]
    fn test_get_nonexistent_user() {
        let db = setup();
        assert!(db.get_user_name("noone").is_none());
    }

    // --- group_members ---

    #[test]
    fn test_upsert_and_get_group_member() {
        let db = setup();
        assert!(db.get_group_member_name("g1", "u1").is_none());
        db.upsert_group_member("g1", "u1", "Bob");
        assert_eq!(db.get_group_member_name("g1", "u1"), Some("Bob".into()));
    }

    #[test]
    fn test_group_member_scoped_by_group() {
        let db = setup();
        db.upsert_group_member("g1", "u1", "Bob");
        assert!(db.get_group_member_name("g2", "u1").is_none());
    }

    #[test]
    fn test_list_group_members() {
        let db = setup();
        db.upsert_group_member("g1", "u1", "Charlie");
        db.upsert_group_member("g1", "u2", "Alice");
        db.upsert_group_member("g2", "u3", "Dave");

        let members = db.list_group_members("g1");
        assert_eq!(members.len(), 2);
        // sorted by display_name: Alice before Charlie
        assert_eq!(members[0].1, "Alice");
        assert_eq!(members[1].1, "Charlie");

        assert!(db.list_group_members("g2").len() == 1);
        assert!(db.list_group_members("g3").is_empty());
    }

    // --- alias_cache ---

    #[test]
    fn test_upsert_and_get_alias() {
        let db = setup();
        assert!(db.get_alias("uid1").is_none());
        db.upsert_alias("uid1", "MyAlias");
        assert_eq!(db.get_alias("uid1"), Some("MyAlias".into()));
    }

    #[test]
    fn test_alias_replace() {
        let db = setup();
        db.upsert_alias("uid1", "Old");
        db.upsert_alias("uid1", "New");
        assert_eq!(db.get_alias("uid1"), Some("New".into()));
    }

    #[test]
    fn test_alias_independent_of_user() {
        let db = setup();
        db.upsert_user("uid1", "Alice");
        db.upsert_alias("uid1", "BestAlice");
        assert_eq!(db.get_user_name("uid1"), Some("Alice".into()));
        assert_eq!(db.get_alias("uid1"), Some("BestAlice".into()));
    }
}

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
