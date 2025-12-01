/**
 * Commits Routes (v2 Git-like Workflow)
 * 
 * Single Responsibility: Handle git-like staging, commits, and push operations
 * - Stage changes
 * - Create commits
 * - Push to D1CV and AI Agent
 * - WebSocket for real-time updates
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { Env } from '../types';
import { StageChangeRequestSchema, CreateCommitRequestSchema, PushRequestSchema } from '../schemas';
import { CommitRepository } from '../repository';
import { errorResponse } from '../utils';
import { purgeD1CVCache } from '../helpers';

const commits = new Hono<{ Bindings: Env }>();

/**
 * Helper to get user email from request headers (CF Access JWT)
 */
function getUserEmail(c: { req: { header: (name: string) => string | undefined } }): string {
    const jwt = c.req.header('Cf-Access-Jwt-Assertion');
    if (!jwt) return 'anonymous';

    try {
        const parts = jwt.split('.');
        if (parts.length !== 3) return 'anonymous';
        const payload = JSON.parse(atob(parts[1]));
        return payload.email || 'anonymous';
    } catch {
        return 'anonymous';
    }
}

/**
 * POST /v2/stage
 * Stage a change (uncommitted) - new git-like workflow
 */
commits.post('/v2/stage', zValidator('json', StageChangeRequestSchema), async (c) => {
    const body = c.req.valid('json');
    const repo = new CommitRepository(c.env.DB);
    const userEmail = getUserEmail(c);

    try {
        const id = await repo.stageChange({
            target: body.target,
            entityType: body.entity_type,
            action: body.action,
            entityId: body.entity_id ?? undefined,
            stableId: body.stable_id ?? undefined,
            payload: body.payload,
            summary: body.summary,
            createdBy: userEmail,
        });

        return c.json({
            success: true,
            staged_id: id,
            message: 'Change staged successfully',
        }, 201);
    } catch (error) {
        console.error('Stage error:', error);
        return errorResponse(`Failed to stage change: ${error}`, 500);
    }
});

/**
 * GET /v2/staged
 * Get uncommitted staged changes
 */
commits.get('/v2/staged', async (c) => {
    const repo = new CommitRepository(c.env.DB);

    try {
        const changes = await repo.getUncommittedChanges();
        return c.json({
            changes,
            count: changes.length,
        });
    } catch (error) {
        console.error('Get staged error:', error);
        return errorResponse(`Failed to get staged changes: ${error}`, 500);
    }
});

/**
 * DELETE /v2/staged/:id
 * Unstage a change (remove from uncommitted)
 */
commits.delete('/v2/staged/:id', async (c) => {
    const id = c.req.param('id');
    const repo = new CommitRepository(c.env.DB);

    try {
        const deleted = await repo.unstageChange(id);
        if (!deleted) {
            return errorResponse('Staged change not found or already committed', 404);
        }
        return c.json({ success: true, message: 'Change unstaged' });
    } catch (error) {
        console.error('Unstage error:', error);
        return errorResponse(`Failed to unstage change: ${error}`, 500);
    }
});

/**
 * DELETE /v2/staged
 * Clear all uncommitted changes
 */
commits.delete('/v2/staged', async (c) => {
    const repo = new CommitRepository(c.env.DB);

    try {
        const count = await repo.clearUncommitted();
        return c.json({ success: true, cleared: count });
    } catch (error) {
        console.error('Clear staged error:', error);
        return errorResponse(`Failed to clear staged changes: ${error}`, 500);
    }
});

/**
 * POST /v2/commit
 * Create a commit from staged changes
 */
commits.post('/v2/commit', zValidator('json', CreateCommitRequestSchema), async (c) => {
    const body = c.req.valid('json');
    const repo = new CommitRepository(c.env.DB);
    const userEmail = getUserEmail(c);

    try {
        const commitId = await repo.createCommit({
            message: body.message,
            stagedIds: body.staged_ids,
            createdBy: userEmail,
        });

        const commit = await repo.getCommitWithChanges(commitId);

        return c.json({
            success: true,
            commit,
            message: 'Commit created successfully',
        }, 201);
    } catch (error) {
        console.error('Commit error:', error);
        return errorResponse(`Failed to create commit: ${error}`, 500);
    }
});

/**
 * GET /v2/commits
 * List commits (optionally filter by status)
 */
commits.get('/v2/commits', async (c) => {
    const repo = new CommitRepository(c.env.DB);
    const status = c.req.query('status') as 'pending' | 'applied_d1cv' | 'applied_ai' | 'applied_all' | 'failed' | undefined;

    try {
        const commits = await repo.listCommits(status);
        return c.json({ commits, count: commits.length });
    } catch (error) {
        console.error('List commits error:', error);
        return errorResponse(`Failed to list commits: ${error}`, 500);
    }
});

/**
 * GET /v2/commits/:id
 * Get a commit with its changes
 */
commits.get('/v2/commits/:id', async (c) => {
    const id = c.req.param('id');
    const repo = new CommitRepository(c.env.DB);

    try {
        const commit = await repo.getCommitWithChanges(id);
        if (!commit) {
            return errorResponse('Commit not found', 404);
        }
        return c.json({ commit });
    } catch (error) {
        console.error('Get commit error:', error);
        return errorResponse(`Failed to get commit: ${error}`, 500);
    }
});

/**
 * DELETE /v2/commits/:id
 * Delete a pending commit
 */
commits.delete('/v2/commits/:id', async (c) => {
    const id = c.req.param('id');
    const repo = new CommitRepository(c.env.DB);

    try {
        const deleted = await repo.deleteCommit(id);
        if (!deleted) {
            return errorResponse('Commit not found or not in pending status', 404);
        }
        return c.json({ success: true, message: 'Commit deleted' });
    } catch (error) {
        console.error('Delete commit error:', error);
        return errorResponse(`Failed to delete commit: ${error}`, 500);
    }
});

/**
 * POST /v2/push/d1cv
 * Push a commit to D1CV with real-time status via Durable Object
 */
commits.post('/v2/push/d1cv', zValidator('json', PushRequestSchema), async (c) => {
    const { commit_id } = c.req.valid('json');
    const repo = new CommitRepository(c.env.DB);
    const userEmail = getUserEmail(c);
    const d1cvUrl = c.env.D1CV_API_URL;

    if (!d1cvUrl) {
        return errorResponse('D1CV_API_URL not configured', 500);
    }

    try {
        const commit = await repo.getCommitWithChanges(commit_id);
        if (!commit) {
            return errorResponse('Commit not found', 404);
        }

        if (commit.status !== 'pending' && commit.status !== 'failed') {
            return errorResponse(`Cannot push commit with status: ${commit.status}`, 400);
        }

        const d1cvChanges = commit.changes.filter(
            ch => ch.target === 'd1cv' || ch.target === 'both'
        );

        if (d1cvChanges.length === 0) {
            return errorResponse('No D1CV changes in this commit', 400);
        }

        const jobId = await repo.createJob({
            commitId: commit_id,
            target: 'd1cv',
        });

        const doId = c.env.JOB_ORCHESTRATOR.idFromName('singleton');
        const stub = c.env.JOB_ORCHESTRATOR.get(doId);
        await stub.fetch('https://orchestrator/job/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId, commitId: commit_id, target: 'd1cv' }),
        });

        await stub.fetch('https://orchestrator/job/update-target-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId, target: 'd1cv', status: 'in-progress' }),
        });

        let inserted = 0, updated = 0, deleted = 0;

        for (const change of d1cvChanges) {
            const payload = change.payload ? JSON.parse(change.payload) : {};

            try {
                let response: Response;

                if (change.action === 'CREATE') {
                    response = await fetch(`${d1cvUrl}/api/technologies`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload),
                    });
                    if (response.ok) inserted++;
                } else if (change.action === 'UPDATE' && change.entity_id) {
                    response = await fetch(`${d1cvUrl}/api/technologies/${change.entity_id}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload),
                    });
                    if (response.ok) updated++;
                } else if (change.action === 'DELETE' && change.entity_id) {
                    response = await fetch(`${d1cvUrl}/api/technologies/${change.entity_id}`, {
                        method: 'DELETE',
                    });
                    if (response.ok) deleted++;
                }
            } catch (err) {
                console.error(`Failed to apply change ${change.id}:`, err);
            }
        }

        await repo.updateJobStatus({
            id: jobId,
            status: 'completed',
            result: { inserted, updated, deleted },
        });

        await repo.updateCommitStatus({
            id: commit_id,
            status: 'applied_d1cv',
            appliedBy: userEmail,
        });

        await stub.fetch('https://orchestrator/job/update-target-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId, target: 'd1cv', status: 'success' }),
        });

        await purgeD1CVCache(d1cvUrl);

        return c.json({
            success: true,
            job_id: jobId,
            result: { inserted, updated, deleted },
            message: 'Commit pushed to D1CV successfully',
        });
    } catch (error) {
        console.error('Push to D1CV error:', error);

        await repo.updateCommitStatus({
            id: commit_id,
            status: 'failed',
            errorTarget: 'd1cv',
            errorMessage: String(error),
        });

        return errorResponse(`Failed to push to D1CV: ${error}`, 500);
    }
});

/**
 * POST /v2/push/ai
 * Push a commit to AI Agent (triggers reindex) with webhook callback
 */
commits.post('/v2/push/ai', zValidator('json', PushRequestSchema), async (c) => {
    const { commit_id } = c.req.valid('json');
    const repo = new CommitRepository(c.env.DB);
    const userEmail = getUserEmail(c);
    const aiAgentUrl = c.env.AI_AGENT_API_URL;

    if (!aiAgentUrl) {
        return errorResponse('AI_AGENT_API_URL not configured', 500);
    }

    try {
        const commit = await repo.getCommitWithChanges(commit_id);
        if (!commit) {
            return errorResponse('Commit not found', 404);
        }

        if (commit.status !== 'applied_d1cv' && commit.status !== 'pending') {
            return errorResponse(`Cannot push to AI from status: ${commit.status}`, 400);
        }

        const aiChanges = commit.changes.filter(
            ch => ch.target === 'ai-agent' || ch.target === 'both'
        );

        if (aiChanges.length === 0) {
            return errorResponse('No AI Agent changes in this commit', 400);
        }

        const jobId = await repo.createJob({
            commitId: commit_id,
            target: 'ai-agent',
        });

        const doId = c.env.JOB_ORCHESTRATOR.idFromName('singleton');
        const stub = c.env.JOB_ORCHESTRATOR.get(doId);
        await stub.fetch('https://orchestrator/job/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId, commitId: commit_id, target: 'ai-agent' }),
        });

        await stub.fetch('https://orchestrator/job/update-target-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId, target: 'ai-agent', status: 'in-progress' }),
        });

        await repo.updateJobStatus({
            id: jobId,
            status: 'processing',
        });

        const operations = {
            inserts: aiChanges.filter(ch => ch.action === 'CREATE').map(ch => JSON.parse(ch.payload || '{}')),
            updates: aiChanges.filter(ch => ch.action === 'UPDATE').map(ch => ({
                id: ch.stable_id || ch.entity_id,
                changes: JSON.parse(ch.payload || '{}'),
            })),
            deletes: aiChanges.filter(ch => ch.action === 'DELETE').map(ch => ch.stable_id || ch.entity_id),
        };

        const callbackUrl = new URL(c.req.url);
        callbackUrl.pathname = '/v2/webhook';

        const response = await fetch(`${aiAgentUrl}/api/admin/apply`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                job_id: jobId,
                operations,
                callback_url: callbackUrl.toString(),
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`AI Agent returned ${response.status}: ${errorText}`);
        }

        const result = await response.json() as {
            success: boolean;
            async?: boolean;
            inserted?: number;
            updated?: number;
            deleted?: number;
            message?: string;
        };

        if (!result.async) {
            await repo.updateJobStatus({
                id: jobId,
                status: 'completed',
                result,
            });

            await repo.updateCommitStatus({
                id: commit_id,
                status: 'applied_all',
                appliedBy: userEmail,
            });

            await stub.fetch('https://orchestrator/job/update-target-status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jobId, target: 'ai-agent', status: 'success' }),
            });
        }

        return c.json({
            success: true,
            job_id: jobId,
            async: result.async || false,
            result: result.async ? undefined : result,
            message: result.async
                ? 'Push initiated, awaiting AI Agent callback'
                : 'Commit pushed to AI Agent successfully',
        });
    } catch (error) {
        console.error('Push to AI Agent error:', error);

        await repo.updateCommitStatus({
            id: commit_id,
            status: 'failed',
            errorTarget: 'ai-agent',
            errorMessage: String(error),
        });

        return errorResponse(`Failed to push to AI Agent: ${error}`, 500);
    }
});

/**
 * GET /v2/stats
 * Get staging statistics
 */
commits.get('/v2/stats', async (c) => {
    const repo = new CommitRepository(c.env.DB);

    try {
        const stats = await repo.getStats();
        return c.json(stats);
    } catch (error) {
        console.error('Get stats error:', error);
        return errorResponse(`Failed to get stats: ${error}`, 500);
    }
});

/**
 * WebSocket endpoint for real-time job updates
 */
commits.get('/v2/ws', async (c) => {
    const upgradeHeader = c.req.header('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
        return c.text('Expected Upgrade: websocket', 426);
    }

    const id = c.env.JOB_ORCHESTRATOR.idFromName('singleton');
    const stub = c.env.JOB_ORCHESTRATOR.get(id);

    const url = new URL(c.req.url);
    return stub.fetch(`https://orchestrator${url.pathname}${url.search}`, {
        headers: c.req.raw.headers,
    });
});

/**
 * POST /v2/webhook
 * Receive webhook callbacks from D1CV and AI Agent
 */
commits.post('/v2/webhook', async (c) => {
    const signature = c.req.header('X-Webhook-Signature');
    const webhookSecret = c.env.WEBHOOK_SECRET;

    if (webhookSecret && signature) {
        const body = await c.req.text();
        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey(
            'raw',
            encoder.encode(webhookSecret),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign']
        );
        const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
        const expectedSig = Array.from(new Uint8Array(sig))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');

        if (signature !== expectedSig) {
            return c.json({ error: 'Invalid webhook signature' }, 401);
        }
    }

    const id = c.env.JOB_ORCHESTRATOR.idFromName('singleton');
    const stub = c.env.JOB_ORCHESTRATOR.get(id);

    return stub.fetch('https://orchestrator/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(await c.req.json()),
    });
});

/**
 * GET /v2/jobs/:jobId/status
 * Get job status from Durable Object
 */
commits.get('/v2/jobs/:jobId/status', async (c) => {
    const { jobId } = c.req.param();

    const id = c.env.JOB_ORCHESTRATOR.idFromName('singleton');
    const stub = c.env.JOB_ORCHESTRATOR.get(id);

    return stub.fetch(`https://orchestrator/job/status?jobId=${jobId}`, {
        method: 'GET',
    });
});

export { commits };
