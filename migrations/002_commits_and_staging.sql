-- Migration 002: Git-like Commits and Staging Model
-- Adds commits table and updates staged changes for batch commit workflow
-- Date: 2025-11-29

-- =============================================
-- TABLE: commits (git-like commit grouping)
-- =============================================
CREATE TABLE IF NOT EXISTS commits (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    message TEXT,                                    -- Commit message
    status TEXT DEFAULT 'pending' CHECK (status IN (
        'pending',       -- Created, not pushed yet
        'applied_d1cv',  -- Pushed to D1CV, pending AI Agent
        'applied_ai',    -- Pushed to AI Agent only
        'applied_all',   -- Fully synced to both targets
        'failed'         -- Push failed
    )),
    
    -- Audit
    created_by TEXT NOT NULL,                        -- User email from CF Access
    created_at TEXT DEFAULT (datetime('now')),
    
    -- Apply tracking
    applied_d1cv_at TEXT,
    applied_ai_at TEXT,
    applied_by TEXT,
    
    -- Error tracking
    error_target TEXT CHECK (error_target IN ('d1cv', 'ai-agent', NULL)),
    error_message TEXT
);

-- =============================================
-- TABLE: staged_changes (unified staging table)
-- =============================================
CREATE TABLE IF NOT EXISTS staged_changes (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    commit_id TEXT REFERENCES commits(id) ON DELETE CASCADE,  -- NULL = uncommitted
    
    -- What operation
    target TEXT NOT NULL CHECK (target IN ('d1cv', 'ai-agent', 'both')),
    entity_type TEXT NOT NULL CHECK (entity_type IN (
        'technology', 'experience', 'education', 'project', 'profile', 'contact'
    )),
    action TEXT NOT NULL CHECK (action IN ('CREATE', 'UPDATE', 'DELETE')),
    
    -- The data
    entity_id TEXT,                                  -- NULL for CREATE, existing ID for UPDATE/DELETE
    stable_id TEXT,                                  -- For AI Agent linking
    payload TEXT,                                    -- JSON: Full entity data for CREATE/UPDATE
    
    -- For display
    summary TEXT,                                    -- Human-readable: "Python: 5→8 years"
    
    -- Audit
    created_by TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);

-- =============================================
-- INDEXES
-- =============================================
CREATE INDEX IF NOT EXISTS idx_commits_status ON commits(status);
CREATE INDEX IF NOT EXISTS idx_commits_created_at ON commits(created_at);
CREATE INDEX IF NOT EXISTS idx_staged_commit_id ON staged_changes(commit_id);
CREATE INDEX IF NOT EXISTS idx_staged_uncommitted ON staged_changes(commit_id) WHERE commit_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_staged_entity ON staged_changes(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_staged_target ON staged_changes(target);

-- =============================================
-- TABLE: jobs (async job tracking for push operations)
-- =============================================
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    commit_id TEXT NOT NULL REFERENCES commits(id) ON DELETE CASCADE,
    target TEXT NOT NULL CHECK (target IN ('d1cv', 'ai-agent')),
    status TEXT DEFAULT 'pending' CHECK (status IN (
        'pending',
        'processing',
        'completed',
        'failed',
        'timeout'
    )),
    
    -- Tracking
    started_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    
    -- Result
    result TEXT,                                     -- JSON: {inserted: N, updated: N, ...}
    error_message TEXT,
    
    -- For webhook callback
    callback_url TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_commit ON jobs(commit_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
