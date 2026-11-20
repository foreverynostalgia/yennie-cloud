CREATE TABLE student_portals (workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id), data TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
--> statement-breakpoint
CREATE TABLE student_portal_sessions (token_hash TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), student_id TEXT NOT NULL, credential_version TEXT NOT NULL, expires_at INTEGER NOT NULL);
--> statement-breakpoint
CREATE INDEX student_portal_sessions_expiry ON student_portal_sessions(expires_at);
--> statement-breakpoint
CREATE TABLE student_portal_attempts (scope TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL);
