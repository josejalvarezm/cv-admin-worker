-- Staging Database: cv-admin-staging
-- Migration 001: Initial schema

-- Table 1: Staged changes for D1CV
CREATE TABLE IF NOT EXISTS staged_d1cv (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation TEXT NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
    entity_type TEXT NOT NULL,
    entity_id INTEGER,
    payload TEXT NOT NULL, -- JSON string
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'failed')),
    created_at TEXT DEFAULT (datetime('now')),
    applied_at TEXT,
    error_message TEXT
);

-- Table 2: Staged changes for cv-ai-agent
CREATE TABLE IF NOT EXISTS staged_ai_agent (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation TEXT NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
    stable_id TEXT,
    payload TEXT NOT NULL, -- JSON string
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'failed', 'skipped')),
    requires_reindex INTEGER DEFAULT 1, -- boolean
    created_at TEXT DEFAULT (datetime('now')),
    applied_at TEXT,
    error_message TEXT,
    linked_d1cv_staged_id INTEGER,
    FOREIGN KEY (linked_d1cv_staged_id) REFERENCES staged_d1cv(id) ON DELETE SET NULL
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_staged_d1cv_status ON staged_d1cv(status);
CREATE INDEX IF NOT EXISTS idx_staged_d1cv_entity ON staged_d1cv(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_staged_ai_status ON staged_ai_agent(status);
CREATE INDEX IF NOT EXISTS idx_staged_ai_stable_id ON staged_ai_agent(stable_id);
