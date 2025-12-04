/**
 * Staging Routes
 * 
 * Single Responsibility: Handle all staging-related endpoints
 * - Stage changes (INSERT/UPDATE/DELETE)
 * - Get staged changes
 * - Update/delete staged items
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { Env, StageResponse } from '../types';
import { StageRequestSchema } from '../schemas';
import { StagingRepository } from '../repository';
import { generateStableId, errorResponse, validateEntityId } from '../utils';

const staging = new Hono<{ Bindings: Env }>();

/**
 * POST /stage
 * Stage a CRUD operation for D1CV and optionally cv-ai-agent
 */
staging.post('/stage', zValidator('json', StageRequestSchema), async (c) => {
    const body = c.req.valid('json');
    const repo = new StagingRepository(c.env.DB);
    const d1cvDb = c.env.D1CV_DB;

    // Validate entity_id or entity_name for UPDATE/DELETE
    if (!validateEntityId(body.operation, body.entity_id, body.entity_name)) {
        return errorResponse('entity_id or entity_name is required for UPDATE and DELETE operations', 400);
    }

    try {
        // Check for duplicates on INSERT (only for Technology entity)
        if (body.operation === 'INSERT' && body.entity_type === 'technology' && d1cvDb) {
            const techName = body.d1cv_payload?.name;
            if (techName) {
                // Check if technology with same name already exists in D1CV
                const { results: existing } = await d1cvDb.prepare(
                    'SELECT id, name FROM Technology WHERE LOWER(name) = LOWER(?) AND is_active = 1'
                ).bind(techName).all<{ id: number; name: string }>();

                if (existing && existing.length > 0) {
                    return errorResponse(
                        `Technology "${techName}" already exists in the database (ID: ${existing[0].id}). Use UPDATE to modify it.`,
                        409
                    );
                }

                // Also check staging queue for pending INSERTs with same name
                const pendingStaged = await repo.getStagedD1CV('pending');
                const duplicateStaged = pendingStaged.find(s => {
                    if (s.operation !== 'INSERT' || s.entity_type !== 'technology') {
                        return false;
                    }
                    try {
                        const payload = typeof s.payload === 'string' ? JSON.parse(s.payload) : s.payload;
                        return payload?.name?.toLowerCase() === techName.toLowerCase();
                    } catch {
                        return false;
                    }
                });

                if (duplicateStaged) {
                    return errorResponse(
                        `Technology "${techName}" is already staged for insertion. Review the staged changes first.`,
                        409
                    );
                }
            }
        }

        // Stage D1CV change
        const d1cvId = await repo.createStagedD1CV(
            body.operation,
            body.entity_type,
            body.entity_id ?? null,
            body.d1cv_payload
        );

        let aiId: number | null = null;
        let stableId: string | null = null;

        // Stage AI Agent change for DELETE operations
        if (body.operation === 'DELETE') {
            stableId = body.ai_payload?.stable_id ?? generateStableId(body.d1cv_payload.name ?? '');
            aiId = await repo.createStagedAIAgent(
                'DELETE',
                stableId,
                { name: body.d1cv_payload.name, stable_id: stableId },
                d1cvId
            );
        }
        // Stage AI Agent change if AI payload provided (INSERT/UPDATE)
        else if (body.ai_payload && body.ai_payload.summary) {
            stableId = body.ai_payload.stable_id ?? generateStableId(body.d1cv_payload.name ?? '');

            const enrichedAIPayload = {
                ...body.ai_payload,
                stable_id: stableId,
                name: body.d1cv_payload.name,
                experience: body.d1cv_payload.experience,
                experience_years: body.d1cv_payload.experience_years,
                proficiency_percent: body.d1cv_payload.proficiency_percent,
                level: body.d1cv_payload.level,
            };

            aiId = await repo.createStagedAIAgent(
                body.operation,
                stableId,
                enrichedAIPayload,
                d1cvId
            );
        } else {
            aiId = await repo.createSkippedAIAgent(d1cvId);
        }

        const response: StageResponse = {
            success: true,
            staged: {
                d1cv_id: d1cvId,
                ai_id: aiId,
                stable_id: stableId,
            },
            message: 'Changes staged successfully',
        };

        return c.json(response, 201);
    } catch (error) {
        console.error('Stage error:', error);
        return errorResponse(`Failed to stage changes: ${error}`, 500);
    }
});

/**
 * GET /staged/count
 * GET /api/staged/count
 */
const getStagedCountHandler = async (c: any) => {
    const repo = new StagingRepository(c.env.DB);

    try {
        const counts = await repo.getStatusCounts();
        return c.json({
            d1cvPending: counts.d1cv?.pending || 0,
            d1cvApplied: counts.d1cv?.applied || 0,
            aiPending: counts.ai?.pending || 0,
            aiApplied: counts.ai?.applied || 0,
        });
    } catch (error) {
        console.error('Get staged count error:', error);
        return errorResponse(`Failed to get counts: ${error}`, 500);
    }
};

staging.get('/staged/count', getStagedCountHandler);
staging.get('/api/staged/count', getStagedCountHandler);

/**
 * GET /staged
 * GET /api/staged
 */
const getStagedHandler = async (c: any) => {
    const repo = new StagingRepository(c.env.DB);
    const status = c.req.query('status') as 'pending' | 'applied' | 'failed' | 'skipped' | undefined;

    try {
        const [d1cv, ai, counts] = await Promise.all([
            repo.getStagedD1CV(status),
            repo.getStagedAIAgent(status),
            repo.getStatusCounts(),
        ]);

        return c.json({
            d1cv,
            ai,
            counts,
        });
    } catch (error) {
        console.error('Get staged error:', error);
        return errorResponse(`Failed to get staged changes: ${error}`, 500);
    }
};

staging.get('/staged', getStagedHandler);
staging.get('/api/staged', getStagedHandler);

/**
 * DELETE /staged/:id
 */
staging.delete('/staged/:id', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const type = c.req.query('type') ?? 'd1cv';
    const repo = new StagingRepository(c.env.DB);

    try {
        let deleted = false;
        if (type === 'ai') {
            deleted = await repo.deleteStagedAIAgent(id);
        } else {
            deleted = await repo.deleteStagedD1CV(id);
        }

        if (!deleted) {
            return errorResponse('Staged change not found', 404);
        }

        return c.json({ success: true, message: 'Staged change removed' });
    } catch (error) {
        console.error('Delete staged error:', error);
        return errorResponse(`Failed to delete staged change: ${error}`, 500);
    }
});

/**
 * DELETE /staged
 * DELETE /api/staged
 */
const clearAllStagedHandler = async (c: any) => {
    const repo = new StagingRepository(c.env.DB);

    try {
        const result = await repo.clearAllStaged();
        return c.json({
            success: true,
            message: 'All staged changes cleared',
            deleted: result,
        });
    } catch (error) {
        console.error('Clear staged error:', error);
        return errorResponse(`Failed to clear staged changes: ${error}`, 500);
    }
};

staging.delete('/staged', clearAllStagedHandler);
staging.delete('/api/staged', clearAllStagedHandler);

/**
 * GET /staged/ai-by-name/:name
 * GET /api/staged/ai-by-name/:name
 */
const getStagedAIByNameHandler = async (c: any) => {
    const name = decodeURIComponent(c.req.param('name'));
    const repo = new StagingRepository(c.env.DB);

    try {
        const pendingD1CV = await repo.getStagedD1CV('pending');
        const matchingD1CV = pendingD1CV.find(item => {
            if (item.entity_type !== 'technology') return false;
            try {
                const payload = JSON.parse(item.payload) as { name?: string };
                return payload.name?.toLowerCase() === name.toLowerCase();
            } catch {
                return false;
            }
        });

        if (!matchingD1CV) {
            return c.json({ found: false, message: 'No pending staged D1CV record found for this technology' });
        }

        const pendingAI = await repo.getStagedAIAgent('pending');
        const linkedAI = pendingAI.find(ai => ai.linked_d1cv_staged_id === matchingD1CV.id);

        if (!linkedAI) {
            const skippedAI = (await repo.getStagedAIAgent('skipped')).find(
                ai => ai.linked_d1cv_staged_id === matchingD1CV.id
            );

            if (skippedAI) {
                return c.json({
                    found: true,
                    hasAIData: false,
                    d1cv_staged_id: matchingD1CV.id,
                    ai_staged_id: skippedAI.id,
                    message: 'Technology is staged but has no AI enrichment data',
                });
            }

            return c.json({
                found: true,
                hasAIData: false,
                d1cv_staged_id: matchingD1CV.id,
                message: 'Technology is staged but no linked AI record found',
            });
        }

        let aiData = {};
        try {
            aiData = JSON.parse(linkedAI.payload);
        } catch {
            // ignore
        }

        return c.json({
            found: true,
            hasAIData: Object.keys(aiData).length > 0,
            d1cv_staged_id: matchingD1CV.id,
            ai_staged_id: linkedAI.id,
            stable_id: linkedAI.stable_id,
            operation: matchingD1CV.operation,
            aiData,
        });
    } catch (error) {
        console.error('Get staged AI by name error:', error);
        return errorResponse(`Failed to get staged AI data: ${error}`, 500);
    }
};

staging.get('/staged/ai-by-name/:name', getStagedAIByNameHandler);
staging.get('/api/staged/ai-by-name/:name', getStagedAIByNameHandler);

/**
 * GET /staged/technology/:name
 * GET /api/staged/technology/:name
 */
const getStagedTechnologyByNameHandler = async (c: any) => {
    const name = decodeURIComponent(c.req.param('name'));
    const repo = new StagingRepository(c.env.DB);

    try {
        const pendingD1CV = await repo.getStagedD1CV('pending');
        const matchingD1CV = pendingD1CV.find(item => {
            if (item.entity_type !== 'technology') return false;
            try {
                const payload = JSON.parse(item.payload) as { name?: string };
                return payload.name?.toLowerCase() === name.toLowerCase();
            } catch {
                return false;
            }
        });

        if (!matchingD1CV) {
            return c.json({ found: false, message: 'No pending staged technology found with this name' }, 404);
        }

        let d1cvData: Record<string, unknown> = {};
        try {
            d1cvData = JSON.parse(matchingD1CV.payload);
        } catch {
            // ignore
        }

        const allAI = await Promise.all([
            repo.getStagedAIAgent('pending'),
            repo.getStagedAIAgent('skipped'),
        ]);
        const allAIRecords = [...allAI[0], ...allAI[1]];
        const linkedAI = allAIRecords.find(ai => ai.linked_d1cv_staged_id === matchingD1CV.id);

        let aiData: Record<string, unknown> = {};
        if (linkedAI && linkedAI.status !== 'skipped') {
            try {
                aiData = JSON.parse(linkedAI.payload);
            } catch {
                // ignore
            }
        }

        return c.json({
            found: true,
            staged_id: matchingD1CV.id,
            ai_staged_id: linkedAI?.id || null,
            operation: matchingD1CV.operation,
            status: matchingD1CV.status,
            created_at: matchingD1CV.created_at,
            d1cvData,
            aiData,
            hasAIData: Object.keys(aiData).length > 0,
        });
    } catch (error) {
        console.error('Get staged technology error:', error);
        return errorResponse(`Failed to get staged technology: ${error}`, 500);
    }
};

staging.get('/staged/technology/:name', getStagedTechnologyByNameHandler);
staging.get('/api/staged/technology/:name', getStagedTechnologyByNameHandler);

/**
 * PUT /staged/technology/:id
 * PUT /api/staged/technology/:id
 */
const updateStagedTechnologyHandler = async (c: any) => {
    const id = parseInt(c.req.param('id'), 10);
    const repo = new StagingRepository(c.env.DB);
    const body = await c.req.json();

    try {
        const allD1CV = await repo.getStagedD1CV('pending');
        const existingD1CV = allD1CV.find(item => item.id === id);

        if (!existingD1CV) {
            return errorResponse('Staged technology not found', 404);
        }

        if (body.d1cv_payload) {
            await c.env.DB.prepare(`
        UPDATE staged_d1cv 
        SET payload = ?, updated_at = datetime('now')
        WHERE id = ?
      `).bind(JSON.stringify(body.d1cv_payload), id).run();
        }

        if (body.ai_payload !== undefined) {
            const allAI = await repo.getStagedAIAgent();
            const linkedAI = allAI.find(ai => ai.linked_d1cv_staged_id === id);

            if (linkedAI) {
                const hasAIData = body.ai_payload && Object.keys(body.ai_payload).length > 0;
                const newStatus = hasAIData ? 'pending' : 'skipped';
                const newPayload = hasAIData ? JSON.stringify(body.ai_payload) : '{}';

                await c.env.DB.prepare(`
          UPDATE staged_ai_agent 
          SET payload = ?, status = ?, updated_at = datetime('now')
          WHERE id = ?
        `).bind(newPayload, newStatus, linkedAI.id).run();
            }
        }

        return c.json({
            success: true,
            message: 'Staged technology updated',
            staged_id: id,
        });
    } catch (error) {
        console.error('Update staged technology error:', error);
        return errorResponse(`Failed to update staged technology: ${error}`, 500);
    }
};

staging.put('/staged/technology/:id', updateStagedTechnologyHandler);
staging.put('/api/staged/technology/:id', updateStagedTechnologyHandler);

export { staging };
