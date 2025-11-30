import type {
  StagedD1CV,
  StagedAIAgent,
  StagingStatus,
  Operation,
  EntityType,
  Commit,
  CommitWithChanges,
  StagedChange,
  CommitStatus,
  Job,
  JobStatus,
  Target,
  Action
} from './types';

/**
 * Database operations for staging tables
 * Single Responsibility: All D1 database interactions
 */
export class StagingRepository {
  constructor(private db: D1Database) { }

  /**
   * Create a staged D1CV change
   */
  async createStagedD1CV(
    operation: Operation,
    entityType: EntityType,
    entityId: number | null,
    payload: object
  ): Promise<number> {
    const result = await this.db
      .prepare(`
        INSERT INTO staged_d1cv (operation, entity_type, entity_id, payload, status, created_at)
        VALUES (?, ?, ?, ?, 'pending', datetime('now'))
      `)
      .bind(operation, entityType, entityId, JSON.stringify(payload))
      .run();

    return result.meta.last_row_id as number;
  }

  /**
   * Create a staged AI Agent change
   */
  async createStagedAIAgent(
    operation: Operation,
    stableId: string | null,
    payload: object,
    linkedD1CVId: number
  ): Promise<number> {
    const result = await this.db
      .prepare(`
        INSERT INTO staged_ai_agent (operation, stable_id, payload, status, requires_reindex, created_at, linked_d1cv_staged_id)
        VALUES (?, ?, ?, 'pending', 1, datetime('now'), ?)
      `)
      .bind(operation, stableId, JSON.stringify(payload), linkedD1CVId)
      .run();

    return result.meta.last_row_id as number;
  }

  /**
   * Create a skipped AI Agent entry (no AI data provided)
   */
  async createSkippedAIAgent(linkedD1CVId: number): Promise<number> {
    const result = await this.db
      .prepare(`
        INSERT INTO staged_ai_agent (operation, stable_id, payload, status, requires_reindex, created_at, linked_d1cv_staged_id)
        VALUES ('INSERT', NULL, '{}', 'skipped', 0, datetime('now'), ?)
      `)
      .bind(linkedD1CVId)
      .run();

    return result.meta.last_row_id as number;
  }

  /**
   * Get all staged D1CV changes
   */
  async getStagedD1CV(status?: StagingStatus): Promise<StagedD1CV[]> {
    let query = 'SELECT * FROM staged_d1cv';
    if (status) {
      query += ` WHERE status = '${status}'`;
    }
    query += ' ORDER BY created_at DESC';

    const result = await this.db.prepare(query).all<StagedD1CV>();
    return result.results;
  }

  /**
   * Get all staged AI Agent changes
   */
  async getStagedAIAgent(status?: StagingStatus): Promise<StagedAIAgent[]> {
    let query = 'SELECT * FROM staged_ai_agent';
    if (status) {
      query += ` WHERE status = '${status}'`;
    }
    query += ' ORDER BY created_at DESC';

    const result = await this.db.prepare(query).all<StagedAIAgent>();
    return result.results;
  }

  /**
   * Update staged D1CV status
   */
  async updateD1CVStatus(
    id: number,
    status: StagingStatus,
    errorMessage?: string
  ): Promise<void> {
    await this.db
      .prepare(`
        UPDATE staged_d1cv 
        SET status = ?, applied_at = datetime('now'), error_message = ?
        WHERE id = ?
      `)
      .bind(status, errorMessage ?? null, id)
      .run();
  }

  /**
   * Update staged AI Agent status
   */
  async updateAIAgentStatus(
    id: number,
    status: StagingStatus,
    errorMessage?: string
  ): Promise<void> {
    await this.db
      .prepare(`
        UPDATE staged_ai_agent 
        SET status = ?, applied_at = datetime('now'), error_message = ?
        WHERE id = ?
      `)
      .bind(status, errorMessage ?? null, id)
      .run();
  }

  /**
   * Delete a staged D1CV change
   */
  async deleteStagedD1CV(id: number): Promise<boolean> {
    const result = await this.db
      .prepare('DELETE FROM staged_d1cv WHERE id = ?')
      .bind(id)
      .run();
    return result.meta.changes > 0;
  }

  /**
   * Delete a staged AI Agent change
   */
  async deleteStagedAIAgent(id: number): Promise<boolean> {
    const result = await this.db
      .prepare('DELETE FROM staged_ai_agent WHERE id = ?')
      .bind(id)
      .run();
    return result.meta.changes > 0;
  }

  /**
   * Clear all staged changes (danger zone)
   */
  async clearAllStaged(): Promise<{ d1cv: number; ai: number }> {
    const d1cvResult = await this.db.prepare('DELETE FROM staged_d1cv').run();
    const aiResult = await this.db.prepare('DELETE FROM staged_ai_agent').run();

    return {
      d1cv: d1cvResult.meta.changes,
      ai: aiResult.meta.changes,
    };
  }

  /**
   * Get counts by status
   */
  async getStatusCounts(): Promise<{
    d1cv: Record<StagingStatus, number>;
    ai: Record<StagingStatus, number>;
  }> {
    const d1cvCounts = await this.db
      .prepare(`
        SELECT status, COUNT(*) as count 
        FROM staged_d1cv 
        GROUP BY status
      `)
      .all<{ status: StagingStatus; count: number }>();

    const aiCounts = await this.db
      .prepare(`
        SELECT status, COUNT(*) as count 
        FROM staged_ai_agent 
        GROUP BY status
      `)
      .all<{ status: StagingStatus; count: number }>();

    const defaultCounts: Record<StagingStatus, number> = {
      pending: 0,
      applied: 0,
      failed: 0,
      skipped: 0,
    };

    const d1cvResult = { ...defaultCounts };
    const aiResult = { ...defaultCounts };

    d1cvCounts.results.forEach((row) => {
      d1cvResult[row.status] = row.count;
    });

    aiCounts.results.forEach((row) => {
      aiResult[row.status] = row.count;
    });

    return { d1cv: d1cvResult, ai: aiResult };
  }
}

// ==========================================
// GIT-LIKE COMMITS & STAGING REPOSITORY
// ==========================================

/**
 * Repository for git-like commit and staging operations
 */
export class CommitRepository {
  constructor(private db: D1Database) { }

  // ==========================================
  // STAGED CHANGES (uncommitted)
  // ==========================================

  /**
   * Stage a change (uncommitted)
   */
  async stageChange(params: {
    target: Target;
    entityType: EntityType;
    action: Action;
    entityId?: string | null;
    stableId?: string | null;
    payload?: Record<string, unknown>;
    summary?: string;
    createdBy: string;
  }): Promise<string> {
    const id = crypto.randomUUID();

    await this.db
      .prepare(`
        INSERT INTO staged_changes (id, commit_id, target, entity_type, action, entity_id, stable_id, payload, summary, created_by, created_at)
        VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `)
      .bind(
        id,
        params.target,
        params.entityType,
        params.action,
        params.entityId ?? null,
        params.stableId ?? null,
        params.payload ? JSON.stringify(params.payload) : null,
        params.summary ?? null,
        params.createdBy
      )
      .run();

    return id;
  }

  /**
   * Get uncommitted staged changes
   */
  async getUncommittedChanges(): Promise<StagedChange[]> {
    const result = await this.db
      .prepare('SELECT * FROM staged_changes WHERE commit_id IS NULL ORDER BY created_at DESC')
      .all<StagedChange>();
    return result.results;
  }

  /**
   * Unstage a change (delete uncommitted)
   */
  async unstageChange(id: string): Promise<boolean> {
    const result = await this.db
      .prepare('DELETE FROM staged_changes WHERE id = ? AND commit_id IS NULL')
      .bind(id)
      .run();
    return result.meta.changes > 0;
  }

  /**
   * Clear all uncommitted changes
   */
  async clearUncommitted(): Promise<number> {
    const result = await this.db
      .prepare('DELETE FROM staged_changes WHERE commit_id IS NULL')
      .run();
    return result.meta.changes;
  }

  // ==========================================
  // COMMITS
  // ==========================================

  /**
   * Create a commit from staged changes
   */
  async createCommit(params: {
    message: string;
    stagedIds: string[];
    createdBy: string;
  }): Promise<string> {
    const commitId = crypto.randomUUID();

    // Create the commit
    await this.db
      .prepare(`
        INSERT INTO commits (id, message, status, created_by, created_at)
        VALUES (?, ?, 'pending', ?, datetime('now'))
      `)
      .bind(commitId, params.message, params.createdBy)
      .run();

    // Associate staged changes with this commit
    if (params.stagedIds.length > 0) {
      const placeholders = params.stagedIds.map(() => '?').join(',');
      await this.db
        .prepare(`
          UPDATE staged_changes 
          SET commit_id = ? 
          WHERE id IN (${placeholders}) AND commit_id IS NULL
        `)
        .bind(commitId, ...params.stagedIds)
        .run();
    }

    return commitId;
  }

  /**
   * Get a commit by ID
   */
  async getCommit(id: string): Promise<Commit | null> {
    const result = await this.db
      .prepare('SELECT * FROM commits WHERE id = ?')
      .bind(id)
      .first<Commit>();
    return result;
  }

  /**
   * Get a commit with its changes
   */
  async getCommitWithChanges(id: string): Promise<CommitWithChanges | null> {
    const commit = await this.getCommit(id);
    if (!commit) return null;

    const changes = await this.db
      .prepare('SELECT * FROM staged_changes WHERE commit_id = ? ORDER BY created_at')
      .bind(id)
      .all<StagedChange>();

    return { ...commit, changes: changes.results };
  }

  /**
   * List commits by status
   */
  async listCommits(status?: CommitStatus): Promise<Commit[]> {
    let query = 'SELECT * FROM commits';
    const params: string[] = [];

    if (status) {
      query += ' WHERE status = ?';
      params.push(status);
    }

    query += ' ORDER BY created_at DESC';

    const result = await this.db.prepare(query).bind(...params).all<Commit>();
    return result.results;
  }

  /**
   * Update commit status
   */
  async updateCommitStatus(params: {
    id: string;
    status: CommitStatus;
    appliedBy?: string;
    errorTarget?: 'd1cv' | 'ai-agent';
    errorMessage?: string;
  }): Promise<void> {
    const updates: string[] = ['status = ?'];
    const values: (string | null)[] = [params.status];

    if (params.status === 'applied_d1cv' || params.status === 'applied_all') {
      if (params.status === 'applied_d1cv') {
        updates.push('applied_d1cv_at = datetime(\'now\')');
      }
      if (params.status === 'applied_all') {
        updates.push('applied_ai_at = datetime(\'now\')');
      }
    }

    if (params.appliedBy) {
      updates.push('applied_by = ?');
      values.push(params.appliedBy);
    }

    if (params.status === 'failed') {
      updates.push('error_target = ?');
      updates.push('error_message = ?');
      values.push(params.errorTarget ?? null);
      values.push(params.errorMessage ?? null);
    }

    values.push(params.id);

    await this.db
      .prepare(`UPDATE commits SET ${updates.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run();
  }

  /**
   * Delete a pending commit (and its changes)
   */
  async deleteCommit(id: string): Promise<boolean> {
    const result = await this.db
      .prepare('DELETE FROM commits WHERE id = ? AND status = \'pending\'')
      .bind(id)
      .run();
    return result.meta.changes > 0;
  }

  // ==========================================
  // JOBS
  // ==========================================

  /**
   * Create a job for async push operation
   */
  async createJob(params: {
    commitId: string;
    target: 'd1cv' | 'ai-agent';
    callbackUrl?: string;
  }): Promise<string> {
    const jobId = crypto.randomUUID();

    await this.db
      .prepare(`
        INSERT INTO jobs (id, commit_id, target, status, started_at, callback_url)
        VALUES (?, ?, ?, 'pending', datetime('now'), ?)
      `)
      .bind(jobId, params.commitId, params.target, params.callbackUrl ?? null)
      .run();

    return jobId;
  }

  /**
   * Get a job by ID
   */
  async getJob(id: string): Promise<Job | null> {
    const result = await this.db
      .prepare('SELECT * FROM jobs WHERE id = ?')
      .bind(id)
      .first<Job>();
    return result;
  }

  /**
   * Update job status
   */
  async updateJobStatus(params: {
    id: string;
    status: JobStatus;
    result?: Record<string, unknown>;
    errorMessage?: string;
  }): Promise<void> {
    const isComplete = ['completed', 'failed', 'timeout'].includes(params.status);

    await this.db
      .prepare(`
        UPDATE jobs 
        SET status = ?, 
            completed_at = ${isComplete ? 'datetime(\'now\')' : 'NULL'},
            result = ?,
            error_message = ?
        WHERE id = ?
      `)
      .bind(
        params.status,
        params.result ? JSON.stringify(params.result) : null,
        params.errorMessage ?? null,
        params.id
      )
      .run();
  }

  /**
   * Get jobs for a commit
   */
  async getJobsForCommit(commitId: string): Promise<Job[]> {
    const result = await this.db
      .prepare('SELECT * FROM jobs WHERE commit_id = ? ORDER BY started_at')
      .bind(commitId)
      .all<Job>();
    return result.results;
  }

  // ==========================================
  // STATISTICS
  // ==========================================

  /**
   * Get staging statistics
   */
  async getStats(): Promise<{
    uncommitted: number;
    pendingCommits: number;
    appliedCommits: number;
    failedCommits: number;
  }> {
    const [uncommitted, pending, applied, failed] = await Promise.all([
      this.db.prepare('SELECT COUNT(*) as count FROM staged_changes WHERE commit_id IS NULL').first<{ count: number }>(),
      this.db.prepare('SELECT COUNT(*) as count FROM commits WHERE status = \'pending\'').first<{ count: number }>(),
      this.db.prepare('SELECT COUNT(*) as count FROM commits WHERE status = \'applied_all\'').first<{ count: number }>(),
      this.db.prepare('SELECT COUNT(*) as count FROM commits WHERE status = \'failed\'').first<{ count: number }>(),
    ]);

    return {
      uncommitted: uncommitted?.count ?? 0,
      pendingCommits: pending?.count ?? 0,
      appliedCommits: applied?.count ?? 0,
      failedCommits: failed?.count ?? 0,
    };
  }

  /**
   * Get changes by target for a commit
   */
  async getChangesByTarget(commitId: string, target: 'd1cv' | 'ai-agent'): Promise<StagedChange[]> {
    const result = await this.db
      .prepare(`
        SELECT * FROM staged_changes 
        WHERE commit_id = ? 
        AND (target = ? OR target = 'both')
        ORDER BY created_at
      `)
      .bind(commitId, target)
      .all<StagedChange>();
    return result.results;
  }
}
