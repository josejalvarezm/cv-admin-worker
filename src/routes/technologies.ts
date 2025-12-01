/**
 * Technologies Routes
 * 
 * Single Responsibility: Handle all technology-related endpoints
 * - List technologies (transformed from D1CV)
 * - Get technology count
 * - Get technologies with AI match status
 * - Get single technology by ID
 * - Similarity search via AI Agent
 */

import { Hono } from 'hono';
import type { Env, D1CVTechnologiesResponse, AdminTechnology } from '../types';

const technologies = new Hono<{ Bindings: Env }>();

/**
 * GET /api/technologies
 * Fetch all technologies, transform from D1CV v2 format to flat array
 */
technologies.get('/api/technologies', async (c) => {
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
    const technologiesList: AdminTechnology[] = [];
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
        technologiesList.push({
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

    return c.json(technologiesList);
  } catch (error) {
    console.error('D1CV proxy error:', error);
    return c.json({ error: 'Failed to fetch from D1CV' }, 502);
  }
});

/**
 * GET /api/technologies/count
 * Get technology count statistics
 */
technologies.get('/api/technologies/count', async (c) => {
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
technologies.get('/api/technologies/with-ai-match', async (c) => {
  const d1cvUrl = c.env.D1CV_API_URL;

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
    const technologiesList: (AdminTechnology & { ai_synced: boolean })[] = [];
    let idCounter = 1;
    let categoryIdCounter = 1;
    const categoryMap = new Map<string, number>();

    for (const category of d1cvData.technologyCategories) {
      if (!categoryMap.has(category.name)) {
        categoryMap.set(category.name, categoryIdCounter++);
      }
      const categoryId = categoryMap.get(category.name)!;

      for (const tech of category.technologies) {
        technologiesList.push({
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

    return c.json(technologiesList);
  } catch (error) {
    console.error('D1CV proxy error:', error);
    return c.json({ error: 'Failed to fetch from D1CV' }, 502);
  }
});

/**
 * GET /api/technologies/:id
 * Get single technology by ID
 */
technologies.get('/api/technologies/:id', async (c) => {
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

/**
 * GET /api/similarity/:name
 * Search for similar technologies in AI Agent using semantic search
 */
technologies.get('/api/similarity/:name', async (c) => {
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

export { technologies };
