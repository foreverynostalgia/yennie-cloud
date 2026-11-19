CREATE TABLE workspaces (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', revision INTEGER NOT NULL DEFAULT 0, file_bytes INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
--> statement-breakpoint
CREATE TABLE accounts (user_id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL, workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id), status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
--> statement-breakpoint
CREATE TABLE files (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), object_key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
--> statement-breakpoint
CREATE INDEX files_workspace ON files(workspace_id,created_at);
--> statement-breakpoint
CREATE TABLE audit (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, workspace_id TEXT, action TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
--> statement-breakpoint
CREATE INDEX audit_workspace ON audit(workspace_id,created_at);
