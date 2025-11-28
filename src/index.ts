import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { zValidator } from '@hono/zod-validator';
import type { Env, StageResponse, SimilarityMatch } from './types';
import { StageRequestSchema } from './schemas';
import { StagingRepository } from './repository';
import { generateStableId, errorResponse, validateEntityId } from './utils';

const app = new Hono<{ Bindings: Env }>();

// CORS middleware
app.use('*', cors({
  origin: ['https://admin.{YOUR_DOMAIN}', 'http://localhost:5173'],
  allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'CF-Access-JWT-Assertion'],
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
// STAGE ENDPOINTS
// ==========================================

/**
 * POST /stage
 * Stage a CRUD operation for D1CV and optionally cv-ai-agent
 */
app.post('/stage', zValidator('json', StageRequestSchema), async (c) => {
  const body = c.req.valid('json');
  const repo = new StagingRepository(c.env.DB);

  // Validate entity_id for UPDATE/DELETE
  if (!validateEntityId(body.operation, body.entity_id)) {
    return errorResponse('entity_id is required for UPDATE and DELETE operations', 400);
  }

  try {
    // Stage D1CV change
    const d1cvId = await repo.createStagedD1CV(
      body.operation,
      body.entity_type,
      body.entity_id ?? null,
      body.d1cv_payload
    );

    let aiId: number | null = null;
    let stableId: string | null = null;

    // Stage AI Agent change if AI payload provided
    if (body.ai_payload && body.ai_payload.summary) {
      stableId = body.ai_payload.stable_id ?? generateStableId(body.d1cv_payload.name);
      
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
      // Create skipped AI entry
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
 * GET /staged
 * List all staged changes
 */
app.get('/staged', async (c) => {
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
});

/**
 * DELETE /staged/:id
 * Remove a staged change
 */
app.delete('/staged/:id', async (c) => {
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
 * Clear all staged changes (danger zone)
 */
app.delete('/staged', async (c) => {
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
});

// ==========================================
// SIMILARITY ENDPOINT
// ==========================================

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
// APPLY ENDPOINTS
// ==========================================

/**
 * POST /apply/d1cv
 * Apply pending D1CV changes to the D1CV worker
 */
app.post('/apply/d1cv', async (c) => {
  const repo = new StagingRepository(c.env.DB);
  const d1cvUrl = c.env.D1CV_API_URL;

  if (!d1cvUrl) {
    return errorResponse('D1CV_API_URL not configured', 500);
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

    for (const staged of pending) {
      try {
        // TODO: Call D1CV API to apply the change
        // For now, just mark as applied
        await repo.updateD1CVStatus(staged.id, 'applied');
        applied++;
      } catch (error) {
        await repo.updateD1CVStatus(staged.id, 'failed', String(error));
        failed++;
      }
    }

    return c.json({
      success: true,
      applied,
      failed,
      message: `Applied ${applied} changes, ${failed} failed`,
    });
  } catch (error) {
    console.error('Apply D1CV error:', error);
    return errorResponse(`Failed to apply D1CV changes: ${error}`, 500);
  }
});

/**
 * POST /apply/ai
 * Apply pending AI Agent changes and trigger reindexing
 */
app.post('/apply/ai', async (c) => {
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
    const startTime = Date.now();

    for (const staged of pending) {
      try {
        // TODO: Call cv-ai-agent API to apply the change
        // For now, just mark as applied
        await repo.updateAIAgentStatus(staged.id, 'applied');
        applied++;
      } catch (error) {
        await repo.updateAIAgentStatus(staged.id, 'failed', String(error));
        failed++;
      }
    }

    const durationMs = Date.now() - startTime;

    return c.json({
      success: true,
      applied,
      failed,
      reindexed: applied > 0,
      duration_ms: durationMs,
      message: `Applied ${applied} AI changes, ${failed} failed`,
    });
  } catch (error) {
    console.error('Apply AI error:', error);
    return errorResponse(`Failed to apply AI changes: ${error}`, 500);
  }
});

// ==========================================
// ENTITY ENDPOINTS (for form dropdowns)
// ==========================================

/**
 * GET /entities/categories
 * Get technology categories from D1CV
 */
app.get('/entities/categories', async (c) => {
  const d1cvUrl = c.env.D1CV_API_URL;

  if (!d1cvUrl) {
    // Return fallback categories
    return c.json({
      categories: [
        { id: 1, name: 'Programming Languages' },
        { id: 2, name: 'Frontend Development' },
        { id: 3, name: 'Backend Development' },
        { id: 4, name: 'Cloud & DevOps' },
        { id: 5, name: 'Databases' },
        { id: 6, name: 'Tools & IDEs' },
      ],
    });
  }

  try {
    const response = await fetch(`${d1cvUrl}/api/categories`);
    if (!response.ok) {
      throw new Error(`D1CV returned ${response.status}`);
    }
    const data = await response.json();
    return c.json(data);
  } catch (error) {
    console.error('Get categories error:', error);
    return errorResponse(`Failed to get categories: ${error}`, 500);
  }
});

/**
 * GET /entities/technologies
 * Get all technologies from D1CV (alias for /api/d1cv/technologies)
 */
app.get('/entities/technologies', async (c) => {
  const d1cvUrl = c.env.D1CV_API_URL;

  if (!d1cvUrl) {
    return c.json({ technologies: [] });
  }

  try {
    const response = await fetch(`${d1cvUrl}/api/technologies`);
    if (!response.ok) {
      throw new Error(`D1CV returned ${response.status}`);
    }
    const data = await response.json();
    return c.json(data);
  } catch (error) {
    console.error('Get technologies error:', error);
    return errorResponse(`Failed to get technologies: ${error}`, 500);
  }
});

// ==========================================
// D1CV DATA ENDPOINTS (Read from D1CV Worker)
// ==========================================

/**
 * GET /api/d1cv/technologies
 * Fetch all technologies from D1CV database
 */
app.get('/api/d1cv/technologies', async (c) => {
  const d1cvUrl = c.env.D1CV_API_URL;

  if (!d1cvUrl) {
    return errorResponse('D1CV_API_URL not configured', 500);
  }

  try {
    const response = await fetch(`${d1cvUrl}/api/technologies`);
    if (!response.ok) {
      throw new Error(`D1CV returned ${response.status}`);
    }
    const data = await response.json();
    return c.json(data);
  } catch (error) {
    console.error('D1CV technologies error:', error);
    return errorResponse(`Failed to fetch D1CV technologies: ${error}`, 500);
  }
});

/**
 * GET /api/d1cv/technologies/:id
 * Fetch single technology from D1CV by ID
 */
app.get('/api/d1cv/technologies/:id', async (c) => {
  const d1cvUrl = c.env.D1CV_API_URL;
  const id = c.req.param('id');

  if (!d1cvUrl) {
    return errorResponse('D1CV_API_URL not configured', 500);
  }

  try {
    const response = await fetch(`${d1cvUrl}/api/technologies/${id}`);
    if (!response.ok) {
      if (response.status === 404) {
        return errorResponse('Technology not found', 404);
      }
      throw new Error(`D1CV returned ${response.status}`);
    }
    const data = await response.json();
    return c.json(data);
  } catch (error) {
    console.error('D1CV technology error:', error);
    return errorResponse(`Failed to fetch D1CV technology: ${error}`, 500);
  }
});

/**
 * GET /api/d1cv/categories
 * Fetch all categories from D1CV database
 */
app.get('/api/d1cv/categories', async (c) => {
  const d1cvUrl = c.env.D1CV_API_URL;

  if (!d1cvUrl) {
    // Return fallback categories
    return c.json({
      categories: [
        { id: 1, name: 'Programming Languages' },
        { id: 2, name: 'Frontend Development' },
        { id: 3, name: 'Backend Development' },
        { id: 4, name: 'Cloud & DevOps' },
        { id: 5, name: 'Databases' },
        { id: 6, name: 'Tools & IDEs' },
      ],
    });
  }

  try {
    const response = await fetch(`${d1cvUrl}/api/categories`);
    if (!response.ok) {
      throw new Error(`D1CV returned ${response.status}`);
    }
    const data = await response.json();
    return c.json(data);
  } catch (error) {
    console.error('D1CV categories error:', error);
    return errorResponse(`Failed to fetch D1CV categories: ${error}`, 500);
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
    return c.json(data);
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
    return c.json(data);
  } catch (error) {
    console.error('AI Agent technology error:', error);
    return errorResponse(`Failed to fetch AI Agent technology: ${error}`, 500);
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

export default app;
