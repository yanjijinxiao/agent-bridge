CREATE TABLE IF NOT EXISTS task_submissions ( id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, task_id TEXT NOT NULL, comment_id TEXT, created_at TEXT NOT NULL );
