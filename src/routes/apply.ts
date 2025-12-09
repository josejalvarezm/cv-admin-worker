/**
 * Apply Routes
 * 
 * Single Responsibility: Handle applying staged changes to production
 * - Apply D1CV changes
 * - Apply AI Agent changes
 */

import { Hono, type Context } from 'hono';
import type { Env } from '../types';
import { StagingRepository } from '../repository';
import { errorResponse } from '../utils';
import { purgeD1CVCache } from '../helpers';

const apply = new Hono<{ Bindings: Env }>();

/**
 * POST /apply/d1cv
 * POST /api/apply/d1cv
 * Apply pending D1CV changes to the D1CV database
 */
const applyD1cvHandler = async (c: Context<{ Bindings: Env }>) => {
    const repo = new StagingRepository(c.env.DB);
    const d1cvDb = c.env.D1CV_DB;

    if (!d1cvDb) {
        return errorResponse('D1CV_DB not configured', 500);
    }

    try {
        const pending = await repo.getStagedD1CV('pending');

        if (pending.length === 0) {
            return c.json({
                success: true,
                applied: 0,
                failed: 0,
                message: 'No pending changes to apply',
            });
        }

        let applied = 0;
        let failed = 0;
        const results: Array<{ id: number; status: string; error?: string }> = [];

        for (const staged of pending) {
            try {
                const payload = JSON.parse(staged.payload);

                if (staged.operation === 'INSERT') {
                    // Get max display_order for the category
                    const maxOrderResult = await d1cvDb.prepare(
                        'SELECT COALESCE(MAX(display_order), 0) + 1 as next_order FROM Technology WHERE category_id = ?'
                    ).bind(payload.category_id).first<{ next_order: number }>();

                    const displayOrder = payload.display_order ?? maxOrderResult?.next_order ?? 1;

                    await d1cvDb.prepare(`
            INSERT INTO Technology (category_id, name, experience, experience_years, proficiency_percent, level, display_order, is_active)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
                        payload.category_id,
                        payload.name,
                        payload.experience,
                        payload.experience_years,
                        payload.proficiency_percent,
                        payload.level,
                        displayOrder,
                        payload.is_active ? 1 : 0
                    ).run();

                } else if (staged.operation === 'UPDATE' && staged.entity_id) {
                    await d1cvDb.prepare(`
            UPDATE Technology 
            SET category_id = ?, name = ?, experience = ?, experience_years = ?, 
                proficiency_percent = ?, level = ?, is_active = ?
            WHERE id = ?
          `).bind(
                        payload.category_id,
                        payload.name,
                        payload.experience,
                        payload.experience_years,
                        payload.proficiency_percent,
                        payload.level,
                        payload.is_active ? 1 : 0,
                        staged.entity_id
                    ).run();

                } else if (staged.operation === 'DELETE' && staged.entity_id) {
                    await d1cvDb.prepare('DELETE FROM Technology WHERE id = ?')
                        .bind(staged.entity_id).run();
                }

                await repo.updateD1CVStatus(staged.id, 'applied');
                applied++;
                results.push({ id: staged.id, status: 'applied' });

            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                await repo.updateD1CVStatus(staged.id, 'failed', errorMsg);
                failed++;
                results.push({ id: staged.id, status: 'failed', error: errorMsg });
            }
        }

        // Purge D1CV cache after successful applies
        if (applied > 0) {
            await purgeD1CVCache(c.env.D1CV_API_URL, 'technologies');
        }

        return c.json({
            success: true,
            applied,
            failed,
            results,
            message: `Applied ${applied} changes, ${failed} failed`,
        });
    } catch (error) {
        console.error('Apply D1CV error:', error);
        return errorResponse(`Failed to apply D1CV changes: ${error}`, 500);
    }
};

apply.post('/apply/d1cv', applyD1cvHandler);
apply.post('/api/apply/d1cv', applyD1cvHandler);

/**
 * POST /apply/ai
 * POST /api/apply/ai
 * Apply pending AI Agent changes and trigger reindexing
 */
const applyAiHandler = async (c: Context<{ Bindings: Env }>) => {
    const repo = new StagingRepository(c.env.DB);
    const aiAgentUrl = c.env.AI_AGENT_API_URL;

    if (!aiAgentUrl) {
        return errorResponse('AI_AGENT_API_URL not configured', 500);
    }

    try {
        const pending = await repo.getStagedAIAgent('pending');

        if (pending.length === 0) {
            return c.json({
                success: true,
                applied: 0,
                failed: 0,
                reindexed: false,
                message: 'No pending AI changes to apply',
            });
        }

        let applied = 0;
        let failed = 0;
        const errors: string[] = [];
        const startTime = Date.now();

        // Build operations object for AI Agent batch apply
        const operations: {
            inserts: Record<string, unknown>[];
            updates: { id: string; changes: Record<string, unknown> }[];
            deletes: string[];
        } = {
            inserts: [],
            updates: [],
            deletes: [],
        };

        // Categorize pending changes by operation type
        for (const staged of pending) {
            const payload = staged.payload ? JSON.parse(staged.payload) : {};

            if (staged.operation === 'INSERT') {
                operations.inserts.push({
                    stable_id: staged.stable_id || payload.stable_id,
                    ...payload,
                });
            } else if (staged.operation === 'UPDATE') {
                operations.updates.push({
                    id: staged.stable_id || '',
                    changes: payload,
                });
            } else if (staged.operation === 'DELETE') {
                operations.deletes.push(staged.stable_id || '');
            }
        }

        // Call AI Agent admin/apply endpoint with batch operations
        const jobId = `apply_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

        try {
            const response = await fetch(`${aiAgentUrl}/api/admin/apply`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    job_id: jobId,
                    operations,
                }),
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`AI Agent returned ${response.status}: ${errorText}`);
            }

            const result = await response.json() as {
                success: boolean;
                inserted: number;
                updated: number;
                deleted: number;
                message: string;
            };

            // Mark all pending as applied if AI Agent succeeded
            if (result.success) {
                for (const staged of pending) {
                    await repo.updateAIAgentStatus(staged.id, 'applied');
                    applied++;
                }
            } else {
                // Mark as failed if AI Agent reported failure
                for (const staged of pending) {
                    await repo.updateAIAgentStatus(staged.id, 'failed', result.message);
                    failed++;
                }
                errors.push(result.message);
            }
        } catch (fetchError) {
            // Network or parsing error - mark all as failed
            const errorMsg = fetchError instanceof Error ? fetchError.message : String(fetchError);
            errors.push(errorMsg);
            for (const staged of pending) {
                await repo.updateAIAgentStatus(staged.id, 'failed', errorMsg);
                failed++;
            }
        }

        const durationMs = Date.now() - startTime;

        return c.json({
            success: failed === 0,
            applied,
            failed,
            reindexed: applied > 0,
            duration_ms: durationMs,
            errors: errors.length > 0 ? errors : undefined,
            message: `Applied ${applied} AI changes, ${failed} failed`,
        });
    } catch (error) {
        console.error('Apply AI error:', error);
        return errorResponse(`Failed to apply AI changes: ${error}`, 500);
    }
};

apply.post('/apply/ai', applyAiHandler);
apply.post('/api/apply/ai', applyAiHandler);

export { apply };
