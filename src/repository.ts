import type { StagedD1CV, StagedAIAgent, StagingStatus, Operation, EntityType } from './types';

/**
 * Database operations for staging tables
 * Single Responsibility: All D1 database interactions
 */
export class StagingRepository {
  constructor(private db: D1Database) {}

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
