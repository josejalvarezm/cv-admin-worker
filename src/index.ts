import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { zValidator } from '@hono/zod-validator';
import type {
  Env,
  SimilarityMatch,
} from './types';
import { StageChangeRequestSchema, CreateCommitRequestSchema, PushRequestSchema } from './schemas';
import { StagingRepository, CommitRepository } from './repository';
import { errorResponse } from './utils';
import { fixEncodingInObject, purgeD1CVCache } from './helpers';
import { technologies, staging, apply, entities, d1cv } from './routes';

// Export Durable Object
export { JobOrchestrator } from './durable-objects/JobOrchestrator';

const app = new Hono<{ Bindings: Env }>();

// CORS middleware - credentials required for Zero Trust cookies
app.use('*', cors({
  origin: ['https://admin.{YOUR_DOMAIN}', 'http://localhost:5173'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'CF-Access-JWT-Assertion'],
  credentials: true,
  maxAge: 86400,
}));

// Health check
app.get('/', (c) => {
  return c.json({
    status: 'ok',
    service: 'cv-admin-worker',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// ==========================================
// ROUTE MODULES
// ==========================================

// Technologies routes (mounted at root, routes have full paths)
app.route('/', technologies);
app.route('/', staging);
app.route('/', apply);
app.route('/', entities);
app.route('/', d1cv);

// ==========================================
// UNIFIED TECHNOLOGY LOOKUP ENDPOINT
// ==========================================

/**
 * GET /api/technology/unified/:name
 * 
 * Single endpoint to get all technology data from all sources:
 * - D1CV production database
 * - AI Agent production database  
 * - Staging tables (for pending changes)
 * 
 * Returns a combined response indicating what data exists where,
 * reducing the need for multiple round-trips from the client.
 */
const getUnifiedTechnologyHandler = async (c: any) => {
  const name = decodeURIComponent(c.req.param('name'));
  const d1cvDb = c.env.D1CV_DB;
  const repo = new StagingRepository(c.env.DB);
  const d1cvUrl = c.env.D1CV_URL || 'https://{YOUR_DOMAIN}';
  const aiAgentUrl = c.env.AI_AGENT_URL || 'https://cv.{YOUR_DOMAIN}';

  const response: {
    found: boolean;
    source: 'production' | 'staged' | 'none';
    d1cv: {
      found: boolean;
      data: Record<string, unknown> | null;
    };
    aiAgent: {
      found: boolean;
      source: 'production' | 'staged' | 'none';
      data: Record<string, unknown> | null;
    };
    staged: {
      found: boolean;
      operation: string | null;
      staged_id: number | null;
      ai_staged_id: number | null;
      d1cvData: Record<string, unknown> | null;
      aiData: Record<string, unknown> | null;
    };
  } = {
    found: false,
    source: 'none',
    d1cv: { found: false, data: null },
    aiAgent: { found: false, source: 'none', data: null },
    staged: { found: false, operation: null, staged_id: null, ai_staged_id: null, d1cvData: null, aiData: null },
  };

  try {
    // 1. Check D1CV production database
    if (d1cvDb) {
      const { results } = await d1cvDb.prepare(`
        SELECT t.*, tc.name as category
        FROM Technology t
        LEFT JOIN TechnologyCategory tc ON t.category_id = tc.id
        WHERE LOWER(t.name) = LOWER(?)
      `).bind(name).all<Record<string, unknown>>();

      if (results && results.length > 0) {
        response.d1cv.found = true;
        response.d1cv.data = results[0];
        response.found = true;
        response.source = 'production';
      }
    }

    // 2. Check staging tables for this technology
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

    if (matchingD1CV) {
      response.staged.found = true;
      response.staged.operation = matchingD1CV.operation;
      response.staged.staged_id = matchingD1CV.id;

      try {
        response.staged.d1cvData = JSON.parse(matchingD1CV.payload);
      } catch {
        response.staged.d1cvData = null;
      }

      // If not found in production but found in staging, it's a staged INSERT
      if (!response.d1cv.found) {
        response.found = true;
        response.source = 'staged';
      }

      // Get linked AI staged record
      const allAI = await repo.getStagedAIAgent();
      const linkedAI = allAI.find(ai =>
        ai.linked_d1cv_staged_id === matchingD1CV.id && ai.status !== 'skipped'
      );

      if (linkedAI) {
        response.staged.ai_staged_id = linkedAI.id;
        try {
          response.staged.aiData = JSON.parse(linkedAI.payload);
          response.aiAgent.found = true;
          response.aiAgent.source = 'staged';
          response.aiAgent.data = response.staged.aiData;
        } catch {
          response.staged.aiData = null;
        }
      }
    }

    // 3. If AI not found in staging, check AI Agent production (only if we have production D1CV)
    if (response.d1cv.found && !response.aiAgent.found) {
      try {
        // Use the technology name directly - AI Agent now supports lookup by name
        const aiResponse = await fetch(`${aiAgentUrl}/api/technologies/${encodeURIComponent(name)}`);
        if (aiResponse.ok) {
          const aiData = await aiResponse.json() as Record<string, unknown>;
          response.aiAgent.found = true;
          response.aiAgent.source = 'production';
          response.aiAgent.data = aiData;
        }
      } catch (error) {
        console.warn('AI Agent lookup failed (non-fatal):', error);
      }
    }

    // Return 404 only if nothing found anywhere
    if (!response.found) {
      return c.json({
        ...response,
        message: 'Technology not found in production or staging'
      }, 404);
    }

    return c.json(response);
  } catch (error) {
    console.error('Unified technology lookup error:', error);
    return errorResponse(`Failed to lookup technology: ${error}`, 500);
  }
};

app.get('/technology/unified/:name', getUnifiedTechnologyHandler);
app.get('/api/technology/unified/:name', getUnifiedTechnologyHandler);

// ==========================================
// SIMILARITY ENDPOINT
// ==========================================

/**
 * GET /api/d1cv/technologies/check/:name
 * Check if a technology with the given name exists in D1CV
 * Used to prevent duplicates during form entry
 */
app.get('/api/d1cv/technologies/check/:name', async (c) => {
  const name = decodeURIComponent(c.req.param('name'));
  const d1cvDb = c.env.D1CV_DB;

  if (!d1cvDb) {
    return errorResponse('D1CV_DB not configured', 500);
  }

  try {
    const { results: existing } = await d1cvDb.prepare(
      'SELECT id, name, category_id FROM Technology WHERE LOWER(name) = LOWER(?) AND is_active = 1'
    ).bind(name).all<{ id: number; name: string; category_id: number }>();

    if (existing && existing.length > 0) {
      return c.json({
        exists: true,
        technology: existing[0],
        message: `Technology "${name}" already exists`,
      });
    }

    return c.json({
      exists: false,
      technology: null,
      message: 'Technology name is available',
    });
  } catch (error) {
    console.error('Check technology error:', error);
    return errorResponse(`Failed to check technology: ${error}`, 500);
  }
});

/**
 * GET /similarity/:name
 * Check cv-ai-agent for similar technologies
 */
app.get('/similarity/:name', async (c) => {
  const name = c.req.param('name');
  const aiAgentUrl = c.env.AI_AGENT_API_URL;

  if (!aiAgentUrl) {
    return c.json({ query: name, matches: [] });
  }

  try {
    // Call cv-ai-agent semantic search
    const response = await fetch(`${aiAgentUrl}/api/search?q=${encodeURIComponent(name)}&limit=5`, {
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      console.error('AI Agent search failed:', response.status);
      return c.json({ query: name, matches: [] });
    }

    const data = await response.json() as { results?: SimilarityMatch[] };

    return c.json({
      query: name,
      matches: data.results ?? [],
    });
  } catch (error) {
    console.error('Similarity check error:', error);
    return c.json({ query: name, matches: [] });
  }
});

// ==========================================
// AI AGENT DATA ENDPOINTS (Read from cv-ai-agent Worker)
// ==========================================

/**
 * GET /api/ai-agent/technologies
 * Fetch all technologies from cv-ai-agent database
 */
app.get('/api/ai-agent/technologies', async (c) => {
  const aiAgentUrl = c.env.AI_AGENT_API_URL;

  if (!aiAgentUrl) {
    return errorResponse('AI_AGENT_API_URL not configured', 500);
  }

  try {
    const response = await fetch(`${aiAgentUrl}/api/technologies`);
    if (!response.ok) {
      throw new Error(`AI Agent returned ${response.status}`);
    }
    const data = await response.json();
    // Fix encoding issues in the response
    return c.json(fixEncodingInObject(data));
  } catch (error) {
    console.error('AI Agent technologies error:', error);
    return errorResponse(`Failed to fetch AI Agent technologies: ${error}`, 500);
  }
});

/**
 * GET /api/ai-agent/technologies/:stableId
 * Fetch single technology from cv-ai-agent by stable_id
 */
app.get('/api/ai-agent/technologies/:stableId', async (c) => {
  const aiAgentUrl = c.env.AI_AGENT_API_URL;
  const stableId = c.req.param('stableId');

  if (!aiAgentUrl) {
    return errorResponse('AI_AGENT_API_URL not configured', 500);
  }

  try {
    const response = await fetch(`${aiAgentUrl}/api/technologies/${stableId}`);
    if (!response.ok) {
      if (response.status === 404) {
        return errorResponse('Technology not found', 404);
      }
      throw new Error(`AI Agent returned ${response.status}`);
    }
    const data = await response.json();
    // Fix encoding issues in the response
    return c.json(fixEncodingInObject(data));
  } catch (error) {
    console.error('AI Agent technology error:', error);
    return errorResponse(`Failed to fetch AI Agent technology: ${error}`, 500);
  }
});

/**
 * GET /api/ai-agent/categories
 * Fetch distinct categories from cv-ai-agent for dropdown population
 */
app.get('/api/ai-agent/categories', async (c) => {
  const aiAgentUrl = c.env.AI_AGENT_API_URL;

  if (!aiAgentUrl) {
    return errorResponse('AI_AGENT_API_URL not configured', 500);
  }

  try {
    const response = await fetch(`${aiAgentUrl}/api/categories`);
    if (!response.ok) {
      throw new Error(`AI Agent returned ${response.status}`);
    }
    const data = await response.json();
    return c.json(data);
  } catch (error) {
    console.error('AI Agent categories error:', error);
    return errorResponse(`Failed to fetch AI Agent categories: ${error}`, 500);
  }
});

/**
 * GET /api/ai-agent/vectorize/status
 * Get Vectorize index status from cv-ai-agent
 */
app.get('/api/ai-agent/vectorize/status', async (c) => {
  const aiAgentUrl = c.env.AI_AGENT_API_URL;

  if (!aiAgentUrl) {
    return errorResponse('AI_AGENT_API_URL not configured', 500);
  }

  try {
    const response = await fetch(`${aiAgentUrl}/api/vectorize/status`);
    if (!response.ok) {
      throw new Error(`AI Agent returned ${response.status}`);
    }
    const data = await response.json();
    return c.json(data);
  } catch (error) {
    console.error('Vectorize status error:', error);
    return errorResponse(`Failed to fetch Vectorize status: ${error}`, 500);
  }
});

/**
 * POST /api/ai-agent/vectorize/reindex
 * Trigger reindex of all technologies in Vectorize
 */
app.post('/api/ai-agent/vectorize/reindex', async (c) => {
  const aiAgentUrl = c.env.AI_AGENT_API_URL;

  if (!aiAgentUrl) {
    return errorResponse('AI_AGENT_API_URL not configured', 500);
  }

  try {
    const response = await fetch(`${aiAgentUrl}/api/admin/reindex`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`AI Agent returned ${response.status}`);
    }
    const data = await response.json();
    return c.json(data);
  } catch (error) {
    console.error('Reindex error:', error);
    return errorResponse(`Failed to trigger reindex: ${error}`, 500);
  }
});

// ==========================================
// GIT-LIKE STAGING & COMMIT ENDPOINTS
// ==========================================

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
app.post('/v2/stage', zValidator('json', StageChangeRequestSchema), async (c) => {
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
app.get('/v2/staged', async (c) => {
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
app.delete('/v2/staged/:id', async (c) => {
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
app.delete('/v2/staged', async (c) => {
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
app.post('/v2/commit', zValidator('json', CreateCommitRequestSchema), async (c) => {
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
app.get('/v2/commits', async (c) => {
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
app.get('/v2/commits/:id', async (c) => {
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
app.delete('/v2/commits/:id', async (c) => {
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
app.post('/v2/push/d1cv', zValidator('json', PushRequestSchema), async (c) => {
  const { commit_id } = c.req.valid('json');
  const repo = new CommitRepository(c.env.DB);
  const userEmail = getUserEmail(c);
  const d1cvUrl = c.env.D1CV_API_URL;

  if (!d1cvUrl) {
    return errorResponse('D1CV_API_URL not configured', 500);
  }

  try {
    // Get commit and changes
    const commit = await repo.getCommitWithChanges(commit_id);
    if (!commit) {
      return errorResponse('Commit not found', 404);
    }

    if (commit.status !== 'pending' && commit.status !== 'failed') {
      return errorResponse(`Cannot push commit with status: ${commit.status}`, 400);
    }

    // Filter changes for D1CV target
    const d1cvChanges = commit.changes.filter(
      ch => ch.target === 'd1cv' || ch.target === 'both'
    );

    if (d1cvChanges.length === 0) {
      return errorResponse('No D1CV changes in this commit', 400);
    }

    // Create job for tracking
    const jobId = await repo.createJob({
      commitId: commit_id,
      target: 'd1cv',
    });

    // Register job with Durable Object for real-time updates
    const doId = c.env.JOB_ORCHESTRATOR.idFromName('singleton');
    const stub = c.env.JOB_ORCHESTRATOR.get(doId);
    await stub.fetch('https://orchestrator/job/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, commitId: commit_id, target: 'd1cv' }),
    });

    // Update DO status to in-progress
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
          // Soft delete - set deleted_at
          response = await fetch(`${d1cvUrl}/api/technologies/${change.entity_id}`, {
            method: 'DELETE',
          });
          if (response.ok) deleted++;
        }
      } catch (err) {
        console.error(`Failed to apply change ${change.id}:`, err);
      }
    }

    // Update job and commit status
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

    // Notify DO of completion
    await stub.fetch('https://orchestrator/job/update-target-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, target: 'd1cv', status: 'success' }),
    });

    // Purge D1CV cache
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
app.post('/v2/push/ai', zValidator('json', PushRequestSchema), async (c) => {
  const { commit_id } = c.req.valid('json');
  const repo = new CommitRepository(c.env.DB);
  const userEmail = getUserEmail(c);
  const aiAgentUrl = c.env.AI_AGENT_API_URL;

  if (!aiAgentUrl) {
    return errorResponse('AI_AGENT_API_URL not configured', 500);
  }

  try {
    // Get commit and changes
    const commit = await repo.getCommitWithChanges(commit_id);
    if (!commit) {
      return errorResponse('Commit not found', 404);
    }

    if (commit.status !== 'applied_d1cv' && commit.status !== 'pending') {
      return errorResponse(`Cannot push to AI from status: ${commit.status}`, 400);
    }

    // Filter changes for AI Agent target
    const aiChanges = commit.changes.filter(
      ch => ch.target === 'ai-agent' || ch.target === 'both'
    );

    if (aiChanges.length === 0) {
      return errorResponse('No AI Agent changes in this commit', 400);
    }

    // Create job for tracking
    const jobId = await repo.createJob({
      commitId: commit_id,
      target: 'ai-agent',
    });

    // Register job with Durable Object for real-time updates
    const doId = c.env.JOB_ORCHESTRATOR.idFromName('singleton');
    const stub = c.env.JOB_ORCHESTRATOR.get(doId);
    await stub.fetch('https://orchestrator/job/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, commitId: commit_id, target: 'ai-agent' }),
    });

    // Update DO status to in-progress
    await stub.fetch('https://orchestrator/job/update-target-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, target: 'ai-agent', status: 'in-progress' }),
    });

    await repo.updateJobStatus({
      id: jobId,
      status: 'processing',
    });

    // Build operations for AI Agent
    const operations = {
      inserts: aiChanges.filter(ch => ch.action === 'CREATE').map(ch => JSON.parse(ch.payload || '{}')),
      updates: aiChanges.filter(ch => ch.action === 'UPDATE').map(ch => ({
        id: ch.stable_id || ch.entity_id,
        changes: JSON.parse(ch.payload || '{}'),
      })),
      deletes: aiChanges.filter(ch => ch.action === 'DELETE').map(ch => ch.stable_id || ch.entity_id),
    };

    // Build callback URL for webhook
    const callbackUrl = new URL(c.req.url);
    callbackUrl.pathname = '/v2/webhook';

    // Call AI Agent admin endpoint with callback URL
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

    // If AI Agent processed synchronously
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

      // Notify DO of completion
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
app.get('/v2/stats', async (c) => {
  const repo = new CommitRepository(c.env.DB);

  try {
    const stats = await repo.getStats();
    return c.json(stats);
  } catch (error) {
    console.error('Get stats error:', error);
    return errorResponse(`Failed to get stats: ${error}`, 500);
  }
});

// ============================================================================
// WebSocket & Durable Object Routes
// ============================================================================

/**
 * WebSocket endpoint for real-time job updates
 * Upgrades connection and forwards to JobOrchestrator DO
 */
app.get('/v2/ws', async (c) => {
  const upgradeHeader = c.req.header('Upgrade');
  if (!upgradeHeader || upgradeHeader !== 'websocket') {
    return c.text('Expected Upgrade: websocket', 426);
  }

  // Get the singleton DO instance
  const id = c.env.JOB_ORCHESTRATOR.idFromName('singleton');
  const stub = c.env.JOB_ORCHESTRATOR.get(id);

  // Forward the WebSocket upgrade request to the DO
  const url = new URL(c.req.url);
  return stub.fetch(`https://orchestrator${url.pathname}${url.search}`, {
    headers: c.req.raw.headers,
  });
});

/**
 * POST /v2/webhook
 * Receive webhook callbacks from D1CV and AI Agent
 */
app.post('/v2/webhook', async (c) => {
  // Verify webhook signature if configured
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

  // Forward to DO
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
app.get('/v2/jobs/:jobId/status', async (c) => {
  const { jobId } = c.req.param();

  const id = c.env.JOB_ORCHESTRATOR.idFromName('singleton');
  const stub = c.env.JOB_ORCHESTRATOR.get(id);

  return stub.fetch(`https://orchestrator/job/status?jobId=${jobId}`, {
    method: 'GET',
  });
});

export default app;
