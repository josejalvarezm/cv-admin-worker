import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env, SimilarityMatch } from './types';
import { StagingRepository } from './repository';
import { errorResponse } from './utils';
import { technologies, staging, apply, entities, d1cv, aiAgent, commits } from './routes';

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
app.route('/', aiAgent);
app.route('/', commits);

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

export default app;