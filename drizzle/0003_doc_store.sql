-- Same SQL as STORE_SQL in src/store.js, which also runs on first use (idempotent),
-- so the deploy does not depend on applying this file by hand.
CREATE TABLE IF NOT EXISTS docs (doc TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, records INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, migrated_at TEXT NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS doc_records (doc TEXT NOT NULL, coll TEXT NOT NULL, rid TEXT NOT NULL, data TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (doc, coll, rid)) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS doc_guard (ok INTEGER NOT NULL CHECK (ok = 1));
