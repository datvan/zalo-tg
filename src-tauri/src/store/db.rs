use rusqlite::{Connection, Result as SqlResult};
use std::path::Path;
use std::sync::Mutex;

pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    pub fn open(path: &Path) -> SqlResult<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        let db = Self { conn: Mutex::new(conn) };
        db.migrate()?;
        Ok(db)
    }

    pub fn open_in_memory() -> SqlResult<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        let db = Self { conn: Mutex::new(conn) };
        db.migrate()?;
        Ok(db)
    }

    pub fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().expect("db lock poisoned")
    }

    fn migrate(&self) -> SqlResult<()> {
        let conn = self.conn();
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER PRIMARY KEY
            );

            CREATE TABLE IF NOT EXISTS topics (
                topic_id INTEGER PRIMARY KEY,
                zalo_id TEXT NOT NULL,
                thread_type INTEGER NOT NULL,
                name TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_topics_zalo_id ON topics(zalo_id);
            CREATE INDEX IF NOT EXISTS idx_topics_thread_type ON topics(thread_type);

            CREATE TABLE IF NOT EXISTS message_map (
                zalo_msg_id TEXT NOT NULL,
                tg_msg_id INTEGER NOT NULL,
                zalo_id TEXT NOT NULL,
                thread_type INTEGER NOT NULL DEFAULT 0,
                uid_from TEXT NOT NULL DEFAULT '',
                ts TEXT NOT NULL DEFAULT '',
                msg_type TEXT NOT NULL DEFAULT '',
                content TEXT NOT NULL DEFAULT '{}',
                ttl INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_msgmap_zalo ON message_map(zalo_msg_id);
            CREATE INDEX IF NOT EXISTS idx_msgmap_tg ON message_map(tg_msg_id);

            CREATE TABLE IF NOT EXISTS user_cache (
                uid TEXT PRIMARY KEY,
                display_name TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS group_members (
                group_id TEXT NOT NULL,
                uid TEXT NOT NULL,
                display_name TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (group_id, uid)
            );

            CREATE TABLE IF NOT EXISTS polls (
                poll_id INTEGER PRIMARY KEY,
                zalo_group_id TEXT NOT NULL,
                tg_poll_msg_id INTEGER NOT NULL DEFAULT 0,
                tg_poll_uuid TEXT NOT NULL DEFAULT '',
                tg_score_msg_id INTEGER NOT NULL DEFAULT 0,
                tg_thread_id INTEGER NOT NULL DEFAULT 0,
                question TEXT NOT NULL DEFAULT '',
                options TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_polls_zalo_group ON polls(zalo_group_id);

            CREATE TABLE IF NOT EXISTS alias_cache (
                uid TEXT PRIMARY KEY,
                alias TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            INSERT OR IGNORE INTO schema_version (version) VALUES (1);
            ",
        )?;
        Ok(())
    }
}
