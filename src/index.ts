import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { zValidator } from '@hono/zod-validator';
import type { Env, StageResponse, SimilarityMatch } from './types';
import { StageRequestSchema, StageChangeRequestSchema, CreateCommitRequestSchema, PushRequestSchema } from './schemas';
import { StagingRepository, CommitRepository } from './repository';
import { generateStableId, errorResponse, validateEntityId } from './utils';

// Export Durable Object
export { JobOrchestrator } from './durable-objects/JobOrchestrator';

const app = new Hono<{ Bindings: Env }>();

/**
 * Purge D1CV cache for a specific entity type
 * Called after successful mutations to invalidate cached responses
 */
async function purgeD1CVCache(d1cvUrl: string, entityType?: string): Promise<void> {
  try {
    const purgeUrl = entityType
      ? `${d1cvUrl}/api/cache/purge/${entityType}`
      : `${d1cvUrl}/api/cache/purge`;

    const response = await fetch(purgeUrl, { method: 'POST' });
    if (!response.ok) {
      console.warn(`Cache purge failed: ${response.status}`);
    } else {
      const result = await response.json() as { purged: number };
      console.log(`Cache purged: ${result.purged} entries for ${entityType || 'all'}`);
    }
  } catch (error) {
    // Don't fail the mutation if cache purge fails
    console.error('Cache purge error (non-fatal):', error);
  }
}

/**
 * Fix encoding issues in strings (mojibake from UTF-8 misinterpretation)
 * Common issues: ÔÇô → – (en-dash), ÔÇæ → (zero-width/space)
 */
function fixEncoding(text: string | null | undefined): string | null {
  if (!text) return text as null;
  return text
    .replace(/ÔÇô/g, '–')      // en-dash
    .replace(/ÔÇæ/g, '-')       // zero-width joiner → regular hyphen
    .replace(/ÔÇö/g, '—')       // em-dash
    .replace(/ÔÇÿ/g, "'")       // smart quote
    .replace(/ÔÇ£/g, '"')       // smart quote open
    .replace(/ÔÇØ/g, '"');      // smart quote close
}

/**
 * Recursively fix encoding issues in an object
 */
function fixEncodingInObject<T>(obj: T): T {
  if (typeof obj === 'string') {
    return fixEncoding(obj) as T;
  }
  if (Array.isArray(obj)) {
    return obj.map(item => fixEncodingInObject(item)) as T;
  }
  if (obj && typeof obj === 'object') {
    const fixed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      fixed[key] = fixEncodingInObject(value);
    }
    return fixed as T;
  }
  return obj;
}

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
// D1CV PROXY ENDPOINTS
// Proxy read requests to D1CV worker for unified auth
// Transforms D1CV v2 API responses to Admin Portal format
// ==========================================

// Types for D1CV responses
interface D1CVTechCategory {
  name: string;
  icon: string;
  technologies: Array<{
    name: string;
    experience: string;
    experienceYears: number;
    proficiencyPercent: number;
    level: string;
  }>;
}

interface D1CVTechnologiesResponse {
  heroSkills: Array<{
    name: string;
    experience: string;
    experienceYears: number;
    proficiencyPercent: number;
    level: string;
    icon: string;
  }>;
  technologyCategories: D1CVTechCategory[];
}

interface AdminTechnology {
  id: number;
  name: string;
  experience: string;
  experience_years: number;
  proficiency_percent: number;
  level: string;
  category: string;
  category_id: number;
  is_active: boolean;
}

/**
 * GET /api/technologies
 * Fetch all technologies, transform from D1CV v2 format to flat array
 */
app.get('/api/technologies', async (c) => {
  const d1cvUrl = c.env.D1CV_API_URL;
  if (!d1cvUrl) {
    return c.json({ error: 'D1CV_API_URL not configured' }, 500);
  }

  try {
    const response = await fetch(`${d1cvUrl}/api/v2/cvs/1/technologies`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      return c.json({ error: 'Failed to fetch technologies from D1CV' }, response.status as 500);
    }

    const data = await response.json() as D1CVTechnologiesResponse;

    // Transform to flat array with category info
    const technologies: AdminTechnology[] = [];
    let idCounter = 1;
    let categoryIdCounter = 1;
    const categoryMap = new Map<string, number>();

    // Process each category
    for (const category of data.technologyCategories) {
      if (!categoryMap.has(category.name)) {
        categoryMap.set(category.name, categoryIdCounter++);
      }
      const categoryId = categoryMap.get(category.name)!;

      for (const tech of category.technologies) {
        technologies.push({
          id: idCounter++,
          name: tech.name,
          experience: tech.experience,
          experience_years: tech.experienceYears,
          proficiency_percent: tech.proficiencyPercent,
          level: tech.level,
          category: category.name,
          category_id: categoryId,
          is_active: true,
        });
      }
    }

    return c.json(technologies);
  } catch (error) {
    console.error('D1CV proxy error:', error);
    return c.json({ error: 'Failed to fetch from D1CV' }, 502);
  }
});

/**
 * GET /api/technologies/count
 * Get technology count statistics
 */
app.get('/api/technologies/count', async (c) => {
  const d1cvUrl = c.env.D1CV_API_URL;
  if (!d1cvUrl) {
    return c.json({ error: 'D1CV_API_URL not configured' }, 500);
  }

  try {
    const response = await fetch(`${d1cvUrl}/api/v2/cvs/1/technologies`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      return c.json({ error: 'Failed to fetch technologies from D1CV' }, response.status as 500);
    }

    const data = await response.json() as D1CVTechnologiesResponse;

    // Calculate counts
    const byCategory: Record<string, number> = {};
    let total = 0;

    for (const category of data.technologyCategories) {
      byCategory[category.name] = category.technologies.length;
      total += category.technologies.length;
    }

    return c.json({
      total,
      active: total, // All are active in current D1CV
      byCategory,
    });
  } catch (error) {
    console.error('D1CV proxy error:', error);
    return c.json({ error: 'Failed to fetch from D1CV' }, 502);
  }
});

/**
 * GET /api/technologies/with-ai-match
 * Get technologies with AI agent matching status
 * Fetches from both D1CV and AI Agent, merges results
 */
app.get('/api/technologies/with-ai-match', async (c) => {
  const d1cvUrl = c.env.D1CV_API_URL;
  const aiAgentUrl = c.env.AI_AGENT_API_URL;

  if (!d1cvUrl) {
    return c.json({ error: 'D1CV_API_URL not configured' }, 500);
  }

  try {
    // Fetch from D1CV
    const d1cvResponse = await fetch(`${d1cvUrl}/api/v2/cvs/1/technologies`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!d1cvResponse.ok) {
      return c.json({ error: 'Failed to fetch technologies from D1CV' }, d1cvResponse.status as 500);
    }

    const d1cvData = await d1cvResponse.json() as D1CVTechnologiesResponse;

    // Transform to flat array
    const technologies: (AdminTechnology & { ai_synced: boolean })[] = [];
    let idCounter = 1;
    let categoryIdCounter = 1;
    const categoryMap = new Map<string, number>();

    for (const category of d1cvData.technologyCategories) {
      if (!categoryMap.has(category.name)) {
        categoryMap.set(category.name, categoryIdCounter++);
      }
      const categoryId = categoryMap.get(category.name)!;

      for (const tech of category.technologies) {
        technologies.push({
          id: idCounter++,
          name: tech.name,
          experience: tech.experience,
          experience_years: tech.experienceYears,
          proficiency_percent: tech.proficiencyPercent,
          level: tech.level,
          category: category.name,
          category_id: categoryId,
          is_active: true,
          ai_synced: false, // Will be updated if AI agent has this tech
        });
      }
    }

    // TODO: Fetch AI agent technologies and merge
    // For now, return with ai_synced = false
    // When AI agent endpoint is available, we can merge the data

    return c.json(technologies);
  } catch (error) {
    console.error('D1CV proxy error:', error);
    return c.json({ error: 'Failed to fetch from D1CV' }, 502);
  }
});

/**
 * GET /api/technologies/:id
 * Get single technology by ID
 */
app.get('/api/technologies/:id', async (c) => {
  const d1cvUrl = c.env.D1CV_API_URL;
  if (!d1cvUrl) {
    return c.json({ error: 'D1CV_API_URL not configured' }, 500);
  }

  const id = parseInt(c.req.param('id'), 10);
  if (isNaN(id)) {
    return c.json({ error: 'Invalid technology ID' }, 400);
  }

  try {
    const response = await fetch(`${d1cvUrl}/api/v2/cvs/1/technologies`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      return c.json({ error: 'Failed to fetch technologies from D1CV' }, response.status as 500);
    }

    const data = await response.json() as D1CVTechnologiesResponse;

    // Find technology by ID (sequential ID based on order)
    let idCounter = 1;
    let categoryIdCounter = 1;
    const categoryMap = new Map<string, number>();

    for (const category of data.technologyCategories) {
      if (!categoryMap.has(category.name)) {
        categoryMap.set(category.name, categoryIdCounter++);
      }
      const categoryId = categoryMap.get(category.name)!;

      for (const tech of category.technologies) {
        if (idCounter === id) {
          return c.json({
            id: idCounter,
            name: tech.name,
            experience: tech.experience,
            experience_years: tech.experienceYears,
            proficiency_percent: tech.proficiencyPercent,
            level: tech.level,
            category: category.name,
            category_id: categoryId,
            is_active: true,
          });
        }
        idCounter++;
      }
    }

    return c.json({ error: 'Technology not found' }, 404);
  } catch (error) {
    console.error('D1CV proxy error:', error);
    return c.json({ error: 'Failed to fetch from D1CV' }, 502);
  }
});

// ==========================================
// AI AGENT PROXY ENDPOINTS
// Similarity search for duplicate detection
// ==========================================

/**
 * GET /api/similarity/:name
 * Search for similar technologies in AI Agent using semantic search
 */
app.get('/api/similarity/:name', async (c) => {
  const aiAgentUrl = c.env.AI_AGENT_API_URL;
  if (!aiAgentUrl) {
    return c.json({ error: 'AI_AGENT_API_URL not configured' }, 500);
  }

  const name = c.req.param('name');
  if (!name || name.trim().length === 0) {
    return c.json({ error: 'Technology name is required' }, 400);
  }

  try {
    // Call AI Agent's search endpoint
    const encodedName = encodeURIComponent(name.trim());
    const response = await fetch(`${aiAgentUrl}/api/search?q=${encodedName}&limit=5`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      // If AI Agent doesn't have search endpoint or fails, return empty matches
      console.warn(`AI Agent similarity search failed: ${response.status}`);
      return c.json({
        query: name,
        matches: [],
      });
    }

    const data = await response.json() as { results?: Array<{ id: string; score: number; metadata?: { name?: string; category?: string; summary?: string } }> };

    // Transform AI Agent response to SimilarTechnology format
    const matches = (data.results || []).map(result => ({
      stable_id: result.id || '',
      name: result.metadata?.name || result.id || '',
      score: result.score || 0,
      category: result.metadata?.category,
      summary: result.metadata?.summary,
    }));

    return c.json({
      query: name,
      matches,
    });
  } catch (error) {
    console.error('AI Agent similarity search error:', error);
    // Return empty matches on error - don't block the user
    return c.json({
      query: name,
      matches: [],
    });
  }
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
            409  // Conflict
          );
        }

        // Also check staging queue for pending INSERTs with same name
        const pendingStaged = await repo.getStagedD1CV('pending');
        const duplicateStaged = pendingStaged.find(s => {
          if (s.operation !== 'INSERT' || s.entity_type !== 'technology') {
            return false;
          }
          try {
            // payload is stored as JSON string in the database
            const payload = typeof s.payload === 'string' ? JSON.parse(s.payload) : s.payload;
            return payload?.name?.toLowerCase() === techName.toLowerCase();
          } catch {
            return false;
          }
        });

        if (duplicateStaged) {
          return errorResponse(
            `Technology "${techName}" is already staged for insertion. Review the staged changes first.`,
            409  // Conflict
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
 * GET /staged/count and /api/staged/count
 * Get count of staged changes by status
 */
app.get('/staged/count', async (c) => {
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
});

// Alias with /api/ prefix for frontend compatibility
app.get('/api/staged/count', async (c) => {
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
});

/**
 * GET /staged and /api/staged
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

// Alias with /api/ prefix for frontend compatibility
app.get('/api/staged', async (c) => {
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
 * DELETE /staged and /api/staged
 * Clear all staged changes (danger zone)
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

app.delete('/staged', clearAllStagedHandler);
app.delete('/api/staged', clearAllStagedHandler);

/**
 * GET /staged/ai-by-name/:name and /api/staged/ai-by-name/:name
 * Get pending staged AI enrichment data by technology name
 * 
 * This enables idempotent editing: when editing a technology that has pending
 * AI enrichment data, the form can show that data even before it's applied
 * to the production AI Agent database.
 * 
 * Flow: D1CV staged record → linked AI staged record → return AI payload
 */
const getStagedAIByNameHandler = async (c: any) => {
  const name = decodeURIComponent(c.req.param('name'));
  const repo = new StagingRepository(c.env.DB);

  try {
    // Get all pending D1CV staged records for technologies
    const pendingD1CV = await repo.getStagedD1CV('pending');

    // Find matching D1CV staged record by technology name
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

    // Get the linked AI staged record
    const pendingAI = await repo.getStagedAIAgent('pending');
    const linkedAI = pendingAI.find(ai => ai.linked_d1cv_staged_id === matchingD1CV.id);

    if (!linkedAI) {
      // Check if there's a skipped AI record (no AI data provided)
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

    // Parse the AI payload
    let aiData = {};
    try {
      aiData = JSON.parse(linkedAI.payload);
    } catch {
      // ignore parse error
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

app.get('/staged/ai-by-name/:name', getStagedAIByNameHandler);
app.get('/api/staged/ai-by-name/:name', getStagedAIByNameHandler);

/**
 * GET /staged/technology/:name and /api/staged/technology/:name
 * Get complete staged technology data (D1CV + AI) by name
 * 
 * This allows editing staged (not yet applied) technologies.
 * Returns both D1CV and AI payloads from the staging tables.
 */
const getStagedTechnologyByNameHandler = async (c: any) => {
  const name = decodeURIComponent(c.req.param('name'));
  const repo = new StagingRepository(c.env.DB);

  try {
    // Get all pending D1CV staged records for technologies
    const pendingD1CV = await repo.getStagedD1CV('pending');

    // Find matching D1CV staged record by technology name
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

    // Parse D1CV payload
    let d1cvData: Record<string, unknown> = {};
    try {
      d1cvData = JSON.parse(matchingD1CV.payload);
    } catch {
      // ignore parse error
    }

    // Get the linked AI staged record
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
        // ignore parse error
      }
    }

    return c.json({
      found: true,
      staged_id: matchingD1CV.id,
      ai_staged_id: linkedAI?.id || null,
      operation: matchingD1CV.operation,
      status: matchingD1CV.status,
      created_at: matchingD1CV.created_at,
      // Combined data for form population
      d1cvData,
      aiData,
      hasAIData: Object.keys(aiData).length > 0,
    });
  } catch (error) {
    console.error('Get staged technology error:', error);
    return errorResponse(`Failed to get staged technology: ${error}`, 500);
  }
};

app.get('/staged/technology/:name', getStagedTechnologyByNameHandler);
app.get('/api/staged/technology/:name', getStagedTechnologyByNameHandler);

/**
 * PUT /staged/technology/:id and /api/staged/technology/:id
 * Update a staged technology (both D1CV and AI payloads)
 * 
 * This allows editing staged changes before they are applied.
 */
const updateStagedTechnologyHandler = async (c: any) => {
  const id = parseInt(c.req.param('id'), 10);
  const repo = new StagingRepository(c.env.DB);
  const body = await c.req.json();

  try {
    // Get the existing staged D1CV record
    const allD1CV = await repo.getStagedD1CV('pending');
    const existingD1CV = allD1CV.find(item => item.id === id);

    if (!existingD1CV) {
      return errorResponse('Staged technology not found', 404);
    }

    // Update D1CV staged record
    if (body.d1cv_payload) {
      await c.env.DB.prepare(`
        UPDATE staged_d1cv 
        SET payload = ?, updated_at = datetime('now')
        WHERE id = ?
      `).bind(JSON.stringify(body.d1cv_payload), id).run();
    }

    // Update linked AI staged record
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

app.put('/staged/technology/:id', updateStagedTechnologyHandler);
app.put('/api/staged/technology/:id', updateStagedTechnologyHandler);

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
        const stableId = name.toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '');

        const aiResponse = await fetch(`${aiAgentUrl}/api/technologies/${encodeURIComponent(stableId)}`);
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
// APPLY ENDPOINTS
// ==========================================

/**
 * POST /apply/d1cv (and /api/apply/d1cv alias)
 * Apply pending D1CV changes to the D1CV database
 */
const applyD1cvHandler = async (c: any) => {
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
        } await repo.updateD1CVStatus(staged.id, 'applied');
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

// Register both routes
app.post('/apply/d1cv', applyD1cvHandler);
app.post('/api/apply/d1cv', applyD1cvHandler);

/**
 * POST /apply/ai (and /api/apply/ai alias)
 * Apply pending AI Agent changes and trigger reindexing
 */
const applyAiHandler = async (c: any) => {
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
};

// Register both routes
app.post('/apply/ai', applyAiHandler);
app.post('/api/apply/ai', applyAiHandler);

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

// ==========================================
// D1CV CACHE MANAGEMENT
// ==========================================

/**
 * POST /api/d1cv/cache/purge
 * Manually purge the D1CV cache
 * This forces the portfolio to fetch fresh data on next request
 */
app.post('/api/d1cv/cache/purge', async (c) => {
  const d1cvUrl = c.env.D1CV_API_URL;

  if (!d1cvUrl) {
    return errorResponse('D1CV_API_URL not configured', 500);
  }

  try {
    const response = await fetch(`${d1cvUrl}/api/cache/purge`, {
      method: 'POST',
    });

    if (!response.ok) {
      throw new Error(`D1CV cache purge returned ${response.status}`);
    }

    const data = await response.json();
    return c.json({
      success: true,
      message: 'Portfolio cache purged successfully',
      ...data,
    });
  } catch (error) {
    console.error('Cache purge error:', error);
    return errorResponse(`Failed to purge cache: ${error}`, 500);
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
 * GET /api/d1cv/categories
 * Fetch all technology categories directly from D1CV database
 * Used by forms to populate category dropdowns with real DB data
 */
app.get('/api/d1cv/categories', async (c) => {
  const d1cvDb = c.env.D1CV_DB;

  if (!d1cvDb) {
    return errorResponse('D1CV_DB not configured', 500);
  }

  try {
    const { results: categories } = await d1cvDb.prepare(`
      SELECT id, name, icon, display_order
      FROM TechnologyCategory
      ORDER BY display_order
    `).all<{
      id: number;
      name: string;
      icon: string;
      display_order: number;
    }>();

    return c.json(categories);
  } catch (error) {
    console.error('D1CV categories error:', error);
    return errorResponse(`Failed to fetch categories: ${error}`, 500);
  }
});

/**
 * GET /api/d1cv/technologies
 * Fetch all technologies directly from D1CV database with real IDs
 * Admin endpoint - includes id for CRUD operations
 */
app.get('/api/d1cv/technologies', async (c) => {
  const d1cvDb = c.env.D1CV_DB;

  if (!d1cvDb) {
    return errorResponse('D1CV_DB not configured', 500);
  }

  try {
    // Query directly from D1CV database to get real IDs
    const { results: technologies } = await d1cvDb.prepare(`
      SELECT 
        t.id,
        t.category_id,
        t.name,
        t.experience,
        t.experience_years,
        t.proficiency_percent,
        t.level,
        t.display_order,
        t.is_active,
        t.created_at,
        t.updated_at,
        tc.name as category
      FROM Technology t
      LEFT JOIN TechnologyCategory tc ON t.category_id = tc.id
      WHERE t.is_active = 1
      ORDER BY tc.display_order, t.display_order
    `).all();

    return c.json(technologies);
  } catch (error) {
    console.error('D1CV technologies error:', error);
    return errorResponse(`Failed to fetch technologies: ${error}`, 500);
  }
});

/**
 * GET /api/d1cv/technologies/with-ai-match
 * Fetch all technologies from D1CV with AI Agent match status
 * Returns array of technologies with aiMatch field containing matched AI data or null
 * Uses direct D1CV_DB query to include real IDs for admin operations
 */
app.get('/api/d1cv/technologies/with-ai-match', async (c) => {
  const d1cvDb = c.env.D1CV_DB;
  const aiAgentUrl = c.env.AI_AGENT_API_URL;

  if (!d1cvDb) {
    return errorResponse('D1CV_DB not configured', 500);
  }

  try {
    // Query directly from D1CV database to get real IDs
    const { results: d1cvTechs } = await d1cvDb.prepare(`
      SELECT 
        t.id,
        t.category_id,
        t.name,
        t.experience,
        t.experience_years,
        t.proficiency_percent,
        t.level,
        t.display_order,
        t.is_active,
        t.created_at,
        t.updated_at,
        tc.name as category
      FROM Technology t
      LEFT JOIN TechnologyCategory tc ON t.category_id = tc.id
      WHERE t.is_active = 1
      ORDER BY tc.display_order, t.display_order
    `).all<{
      id: number;
      category_id: number;
      name: string;
      experience: string;
      experience_years: number;
      proficiency_percent: number;
      level: string;
      display_order: number;
      is_active: number;
      created_at: string;
      updated_at: string;
      category: string;
    }>();

    // Fetch AI Agent technologies (if configured)
    let aiTechs: Array<{ name: string; stable_id: string;[key: string]: unknown }> = [];
    if (aiAgentUrl) {
      try {
        const aiResponse = await fetch(`${aiAgentUrl}/api/technologies`);
        if (aiResponse.ok) {
          const aiData = await aiResponse.json() as { technologies?: Array<{ name: string; stable_id: string;[key: string]: unknown }> };
          aiTechs = aiData.technologies || [];
        }
      } catch (aiError) {
        console.warn('AI Agent fetch failed, continuing without AI data:', aiError);
      }
    }

    /**
     * Fuzzy matching function - finds best AI match for a D1CV technology
     * Matches if:
     * 1. Exact match (case-insensitive)
     * 2. AI tech name starts with D1CV name (e.g., "Angular" matches "Angular 17")
     * 3. D1CV name contains AI tech name (e.g., "AWS (Lambda, S3)" matches "AWS Lambda")
     * 4. Acronym in parentheses matches (e.g., "Google Cloud Platform (GCP)" matches "GCP Firestore")
     */
    const findAiMatch = (d1cvName: string): Record<string, unknown> | null => {
      const normalized = d1cvName.toLowerCase().trim();

      // Try exact match first
      for (const aiTech of aiTechs) {
        if (aiTech.name.toLowerCase().trim() === normalized) {
          return aiTech;
        }
      }

      // Extract acronym from parentheses if present (e.g., "Google Cloud Platform (GCP)" -> "gcp")
      const acronymMatch = normalized.match(/\(([^)]+)\)/);
      const acronym = acronymMatch ? acronymMatch[1].toLowerCase() : null;

      // Try fuzzy match - check if D1CV name contains AI tech name
      // e.g., "AWS (Lambda, S3, API Gateway)" should match "AWS Lambda"
      for (const aiTech of aiTechs) {
        const aiName = aiTech.name.toLowerCase().trim();
        // Check if the D1CV name contains the core part of AI name
        // Split by spaces and check if first word matches
        const aiFirstWord = aiName.split(/[\s(]/)[0];
        const d1cvFirstWord = normalized.split(/[\s(]/)[0];

        if (aiFirstWord === d1cvFirstWord && aiFirstWord.length >= 2) {
          // First word matches - likely the same technology family
          // For "AWS Lambda" matching "AWS (Lambda, S3)", check if Lambda is in the D1CV name
          const aiKeyword = aiName.replace(aiFirstWord, '').trim();
          if (!aiKeyword || normalized.includes(aiKeyword.replace(/[()]/g, '').trim())) {
            return aiTech;
          }
        }

        // Check if acronym matches the AI tech first word
        // e.g., "Google Cloud Platform (GCP)" matches "GCP Firestore"
        if (acronym && aiFirstWord === acronym) {
          return aiTech;
        }
      }

      return null;
    };

    // Merge with AI match status
    const technologiesWithMatch = d1cvTechs.map(tech => {
      const aiMatch = findAiMatch(tech.name);
      return {
        ...tech,
        aiMatch: aiMatch ? fixEncodingInObject(aiMatch) : null,
        hasAiMatch: aiMatch !== null,
      };
    });

    return c.json({
      technologies: technologiesWithMatch,
      stats: {
        total: d1cvTechs.length,
        withAiMatch: technologiesWithMatch.filter(t => t.hasAiMatch).length,
        withoutAiMatch: technologiesWithMatch.filter(t => !t.hasAiMatch).length,
      },
    });
  } catch (error) {
    console.error('D1CV technologies with AI match error:', error);
    return errorResponse(`Failed to fetch technologies: ${error}`, 500);
  }
});

/**
 * GET /api/d1cv/technologies/:identifier
 * Fetch single technology from D1CV by name (URL-encoded)
 * D1CV v2 API doesn't include IDs, so we match by name
 */
app.get('/api/d1cv/technologies/:identifier', async (c) => {
  const d1cvUrl = c.env.D1CV_API_URL;
  const identifier = decodeURIComponent(c.req.param('identifier'));

  if (!d1cvUrl) {
    return errorResponse('D1CV_API_URL not configured', 500);
  }

  try {
    // Fetch all technologies (D1CV doesn't have single-item endpoint)
    const response = await fetch(`${d1cvUrl}/api/v2/cvs/1/technologies`);
    if (!response.ok) {
      throw new Error(`D1CV returned ${response.status}`);
    }

    const data = await response.json() as {
      heroSkills?: Array<{ name: string;[key: string]: unknown }>;
      technologyCategories?: Array<{
        name: string;
        icon: string;
        technologies: Array<{ name: string;[key: string]: unknown }>;
      }>;
    };

    // Flatten categories only (skip heroSkills - they're just highlighted duplicates)
    const allTechs: Array<{ name: string; category?: string;[key: string]: unknown }> = [];

    if (data.technologyCategories) {
      for (const cat of data.technologyCategories) {
        if (cat.technologies) {
          allTechs.push(...cat.technologies.map(t => ({ ...t, category: cat.name })));
        }
      }
    }

    // Find by name (case-insensitive)
    const technology = allTechs.find(t =>
      t.name.toLowerCase() === identifier.toLowerCase()
    );

    if (!technology) {
      return errorResponse('Technology not found', 404);
    }

    return c.json(technology);
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

/**
 * GET /api/d1cv/experience
 * Fetch all experience entries from D1CV database (v2 normalized)
 */
app.get('/api/d1cv/experience', async (c) => {
  const d1cvUrl = c.env.D1CV_API_URL;

  if (!d1cvUrl) {
    return errorResponse('D1CV_API_URL not configured', 500);
  }

  try {
    const response = await fetch(`${d1cvUrl}/api/v2/cvs/1/experience`);
    if (!response.ok) {
      throw new Error(`D1CV returned ${response.status}`);
    }
    const data = await response.json();
    return c.json(data);
  } catch (error) {
    console.error('D1CV experience error:', error);
    return errorResponse(`Failed to fetch experience: ${error}`, 500);
  }
});

/**
 * GET /api/d1cv/education
 * Fetch all education entries from D1CV database (v2 normalized)
 */
app.get('/api/d1cv/education', async (c) => {
  const d1cvUrl = c.env.D1CV_API_URL;

  if (!d1cvUrl) {
    return errorResponse('D1CV_API_URL not configured', 500);
  }

  try {
    const response = await fetch(`${d1cvUrl}/api/v2/cvs/1/education`);
    if (!response.ok) {
      throw new Error(`D1CV returned ${response.status}`);
    }
    const data = await response.json();
    return c.json(data);
  } catch (error) {
    console.error('D1CV education error:', error);
    return errorResponse(`Failed to fetch education: ${error}`, 500);
  }
});

/**
 * GET /api/d1cv/contact
 * Fetch contact info from D1CV database (v2 normalized)
 */
app.get('/api/d1cv/contact', async (c) => {
  const d1cvUrl = c.env.D1CV_API_URL;

  if (!d1cvUrl) {
    return errorResponse('D1CV_API_URL not configured', 500);
  }

  try {
    const response = await fetch(`${d1cvUrl}/api/v2/cvs/1/contact`);
    if (!response.ok) {
      throw new Error(`D1CV returned ${response.status}`);
    }
    const data = await response.json();
    return c.json(data);
  } catch (error) {
    console.error('D1CV contact error:', error);
    return errorResponse(`Failed to fetch contact: ${error}`, 500);
  }
});

/**
 * GET /api/d1cv/profile
 * Fetch profile info from D1CV database (v2 normalized)
 */
app.get('/api/d1cv/profile', async (c) => {
  const d1cvUrl = c.env.D1CV_API_URL;

  if (!d1cvUrl) {
    return errorResponse('D1CV_API_URL not configured', 500);
  }

  try {
    const response = await fetch(`${d1cvUrl}/api/v2/cvs/1/profile`);
    if (!response.ok) {
      throw new Error(`D1CV returned ${response.status}`);
    }
    const data = await response.json();
    return c.json(data);
  } catch (error) {
    console.error('D1CV profile error:', error);
    return errorResponse(`Failed to fetch profile: ${error}`, 500);
  }
});

/**
 * GET /api/d1cv/sections/:sectionType
 * Fetch content sections (home, achievements) from D1CV database (v1 JSON blob)
 */
app.get('/api/d1cv/sections/:sectionType', async (c) => {
  const d1cvUrl = c.env.D1CV_API_URL;
  const sectionType = c.req.param('sectionType');

  if (!d1cvUrl) {
    return errorResponse('D1CV_API_URL not configured', 500);
  }

  try {
    const response = await fetch(`${d1cvUrl}/api/cvs/1/sections/${sectionType}`);
    if (!response.ok) {
      throw new Error(`D1CV returned ${response.status}`);
    }
    const data = await response.json();
    return c.json(data);
  } catch (error) {
    console.error(`D1CV ${sectionType} section error:`, error);
    return errorResponse(`Failed to fetch ${sectionType} section: ${error}`, 500);
  }
});

// ==========================================
// D1CV MUTATION ENDPOINTS (Write to D1CV Worker)
// ==========================================

/**
 * POST /api/d1cv/experience
 * Create a new experience entry
 */
app.post('/api/d1cv/experience', async (c) => {
  const d1cvUrl = c.env.D1CV_API_URL;

  if (!d1cvUrl) {
    return errorResponse('D1CV_API_URL not configured', 500);
  }

  try {
    const body = await c.req.json();
    const response = await fetch(`${d1cvUrl}/api/v2/cvs/1/experience`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`D1CV returned ${response.status}: ${errorData}`);
    }

    const data = await response.json();

    // Purge cache after successful creation
    await purgeD1CVCache(d1cvUrl, 'experience');

    return c.json(data, 201);
  } catch (error) {
    console.error('Create experience error:', error);
    return errorResponse(`Failed to create experience: ${error}`, 500);
  }
});

/**
 * PUT /api/d1cv/experience/:id
 * Update an experience entry
 */
app.put('/api/d1cv/experience/:id', async (c) => {
  const d1cvUrl = c.env.D1CV_API_URL;
  const experienceId = c.req.param('id');

  if (!d1cvUrl) {
    return errorResponse('D1CV_API_URL not configured', 500);
  }

  try {
    const body = await c.req.json();
    const response = await fetch(`${d1cvUrl}/api/v2/cvs/1/experience/${experienceId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`D1CV returned ${response.status}: ${errorData}`);
    }

    const data = await response.json();

    // Purge cache after successful update
    await purgeD1CVCache(d1cvUrl, 'experience');

    return c.json(data);
  } catch (error) {
    console.error('Update experience error:', error);
    return errorResponse(`Failed to update experience: ${error}`, 500);
  }
});

/**
 * DELETE /api/d1cv/experience/:id
 * Delete an experience entry (soft delete)
 */
app.delete('/api/d1cv/experience/:id', async (c) => {
  const d1cvUrl = c.env.D1CV_API_URL;
  const experienceId = c.req.param('id');

  if (!d1cvUrl) {
    return errorResponse('D1CV_API_URL not configured', 500);
  }

  try {
    const response = await fetch(`${d1cvUrl}/api/v2/cvs/1/experience/${experienceId}`, {
      method: 'DELETE',
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`D1CV returned ${response.status}: ${errorData}`);
    }

    const data = await response.json();

    // Purge cache after successful delete
    await purgeD1CVCache(d1cvUrl, 'experience');

    return c.json(data);
  } catch (error) {
    console.error('Delete experience error:', error);
    return errorResponse(`Failed to delete experience: ${error}`, 500);
  }
});

/**
 * POST /api/d1cv/education
 * Create a new education entry
 */
app.post('/api/d1cv/education', async (c) => {
  const d1cvUrl = c.env.D1CV_API_URL;

  if (!d1cvUrl) {
    return errorResponse('D1CV_API_URL not configured', 500);
  }

  try {
    const body = await c.req.json();
    const response = await fetch(`${d1cvUrl}/api/v2/cvs/1/education`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`D1CV returned ${response.status}: ${errorData}`);
    }

    const data = await response.json();

    // Purge cache after successful creation
    await purgeD1CVCache(d1cvUrl, 'education');

    return c.json(data, 201);
  } catch (error) {
    console.error('Create education error:', error);
    return errorResponse(`Failed to create education: ${error}`, 500);
  }
});

/**
 * PUT /api/d1cv/education/:id
 * Update an education entry
 */
app.put('/api/d1cv/education/:id', async (c) => {
  const d1cvUrl = c.env.D1CV_API_URL;
  const educationId = c.req.param('id');

  if (!d1cvUrl) {
    return errorResponse('D1CV_API_URL not configured', 500);
  }

  try {
    const body = await c.req.json();
    const response = await fetch(`${d1cvUrl}/api/v2/cvs/1/education/${educationId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`D1CV returned ${response.status}: ${errorData}`);
    }

    const data = await response.json();

    // Purge cache after successful update
    await purgeD1CVCache(d1cvUrl, 'education');

    return c.json(data);
  } catch (error) {
    console.error('Update education error:', error);
    return errorResponse(`Failed to update education: ${error}`, 500);
  }
});

/**
 * DELETE /api/d1cv/education/:id
 * Delete an education entry (soft delete)
 */
app.delete('/api/d1cv/education/:id', async (c) => {
  const d1cvUrl = c.env.D1CV_API_URL;
  const educationId = c.req.param('id');

  if (!d1cvUrl) {
    return errorResponse('D1CV_API_URL not configured', 500);
  }

  try {
    const response = await fetch(`${d1cvUrl}/api/v2/cvs/1/education/${educationId}`, {
      method: 'DELETE',
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`D1CV returned ${response.status}: ${errorData}`);
    }

    const data = await response.json();

    // Purge cache after successful delete
    await purgeD1CVCache(d1cvUrl, 'education');

    return c.json(data);
  } catch (error) {
    console.error('Delete education error:', error);
    return errorResponse(`Failed to delete education: ${error}`, 500);
  }
});

/**
 * PUT /api/d1cv/contact
 * Update contact info (upsert - only one per CV)
 */
app.put('/api/d1cv/contact', async (c) => {
  const d1cvUrl = c.env.D1CV_API_URL;

  if (!d1cvUrl) {
    return errorResponse('D1CV_API_URL not configured', 500);
  }

  try {
    const body = await c.req.json();
    const response = await fetch(`${d1cvUrl}/api/v2/cvs/1/contact`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`D1CV returned ${response.status}: ${errorData}`);
    }

    const data = await response.json();

    // Purge cache after successful update
    await purgeD1CVCache(d1cvUrl, 'contact');

    return c.json(data);
  } catch (error) {
    console.error('Update contact error:', error);
    return errorResponse(`Failed to update contact: ${error}`, 500);
  }
});

/**
 * PUT /api/d1cv/profile
 * Update profile info (upsert - only one per CV)
 */
app.put('/api/d1cv/profile', async (c) => {
  const d1cvUrl = c.env.D1CV_API_URL;

  if (!d1cvUrl) {
    return errorResponse('D1CV_API_URL not configured', 500);
  }

  try {
    const body = await c.req.json();
    const response = await fetch(`${d1cvUrl}/api/v2/cvs/1/profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`D1CV returned ${response.status}: ${errorData}`);
    }

    const data = await response.json();

    // Purge cache after successful update
    await purgeD1CVCache(d1cvUrl, 'profile');

    return c.json(data);
  } catch (error) {
    console.error('Update profile error:', error);
    return errorResponse(`Failed to update profile: ${error}`, 500);
  }
});

/**
 * PUT /api/d1cv/sections/:sectionType
 * Update content section (home, achievements - JSON blob)
 */
app.put('/api/d1cv/sections/:sectionType', async (c) => {
  const d1cvUrl = c.env.D1CV_API_URL;
  const sectionType = c.req.param('sectionType');

  if (!d1cvUrl) {
    return errorResponse('D1CV_API_URL not configured', 500);
  }

  try {
    const body = await c.req.json();
    const response = await fetch(`${d1cvUrl}/api/v2/cvs/1/sections/${sectionType}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`D1CV returned ${response.status}: ${errorData}`);
    }

    const data = await response.json();

    // Purge cache after successful update
    await purgeD1CVCache(d1cvUrl, 'sections');

    return c.json(data);
  } catch (error) {
    console.error(`Update ${sectionType} section error:`, error);
    return errorResponse(`Failed to update ${sectionType} section: ${error}`, 500);
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
