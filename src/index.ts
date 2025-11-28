import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { zValidator } from '@hono/zod-validator';
import type { Env, StageResponse, SimilarityMatch } from './types';
import { StageRequestSchema } from './schemas';
import { StagingRepository } from './repository';
import { generateStableId, errorResponse, validateEntityId } from './utils';

const app = new Hono<{ Bindings: Env }>();

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
  allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
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
 * GET /staged/count
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
    // D1CV uses v2 normalized endpoint with CV ID 1
    const response = await fetch(`${d1cvUrl}/api/v2/cvs/1/technologies`);
    if (!response.ok) {
      throw new Error(`D1CV returned ${response.status}`);
    }
    const data = await response.json();
    return c.json(data);
  } catch (error) {
    console.error('D1CV technologies error:', error);
    return errorResponse(`Failed to fetch technologies: ${error}`, 500);
  }
});

/**
 * GET /api/d1cv/technologies/with-ai-match
 * Fetch all technologies from D1CV with AI Agent match status
 * Returns array of technologies with aiMatch field containing matched AI data or null
 */
app.get('/api/d1cv/technologies/with-ai-match', async (c) => {
  const d1cvUrl = c.env.D1CV_API_URL;
  const aiAgentUrl = c.env.AI_AGENT_API_URL;

  if (!d1cvUrl) {
    return errorResponse('D1CV_API_URL not configured', 500);
  }

  try {
    // Fetch D1CV technologies
    const d1cvResponse = await fetch(`${d1cvUrl}/api/v2/cvs/1/technologies`);
    if (!d1cvResponse.ok) {
      throw new Error(`D1CV returned ${d1cvResponse.status}`);
    }
    const d1cvData = await d1cvResponse.json() as {
      heroSkills?: Array<{ name: string; [key: string]: unknown }>;
      technologyCategories?: Array<{
        name: string;
        icon: string;
        technologies: Array<{ name: string; [key: string]: unknown }>;
      }>;
    };

    // Flatten D1CV response - skip heroSkills (they're just highlighted duplicates)
    const d1cvTechs: Array<{ name: string; category?: string; [key: string]: unknown }> = [];
    if (d1cvData.technologyCategories) {
      for (const cat of d1cvData.technologyCategories) {
        if (cat.technologies) {
          d1cvTechs.push(...cat.technologies.map(t => ({ ...t, category: cat.name })));
        }
      }
    }

    // Fetch AI Agent technologies (if configured)
    let aiTechs: Array<{ name: string; stable_id: string; [key: string]: unknown }> = [];
    if (aiAgentUrl) {
      try {
        const aiResponse = await fetch(`${aiAgentUrl}/api/technologies`);
        if (aiResponse.ok) {
          const aiData = await aiResponse.json() as { technologies?: Array<{ name: string; stable_id: string; [key: string]: unknown }> };
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
      heroSkills?: Array<{ name: string; [key: string]: unknown }>;
      technologyCategories?: Array<{
        name: string;
        icon: string;
        technologies: Array<{ name: string; [key: string]: unknown }>;
      }>;
    };

    // Flatten categories only (skip heroSkills - they're just highlighted duplicates)
    const allTechs: Array<{ name: string; category?: string; [key: string]: unknown }> = [];
    
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

export default app;
