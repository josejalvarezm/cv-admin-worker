/**
 * D1CV Routes
 * 
 * Single Responsibility: Handle all D1CV database operations
 * - Read endpoints (categories, technologies, experience, education, etc.)
 * - Mutation endpoints (create, update, delete)
 */

import { Hono } from 'hono';
import type { Env } from '../types';
import { errorResponse } from '../utils';
import { fixEncodingInObject, purgeD1CVCache } from '../helpers';

const d1cv = new Hono<{ Bindings: Env }>();

// ==========================================
// D1CV DATA ENDPOINTS (Read from D1CV Worker)
// ==========================================

/**
 * GET /api/d1cv/categories
 * Fetch all technology categories directly from D1CV database
 * Used by forms to populate category dropdowns with real DB data
 */
d1cv.get('/api/d1cv/categories', async (c) => {
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
d1cv.get('/api/d1cv/technologies', async (c) => {
    const d1cvDb = c.env.D1CV_DB;

    if (!d1cvDb) {
        return errorResponse('D1CV_DB not configured', 500);
    }

    try {
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
 */
d1cv.get('/api/d1cv/technologies/with-ai-match', async (c) => {
    const d1cvDb = c.env.D1CV_DB;
    const aiAgentUrl = c.env.AI_AGENT_API_URL;

    if (!d1cvDb) {
        return errorResponse('D1CV_DB not configured', 500);
    }

    try {
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
         */
        const findAiMatch = (d1cvName: string): Record<string, unknown> | null => {
            const normalized = d1cvName.toLowerCase().trim();

            // Try exact match first
            for (const aiTech of aiTechs) {
                if (aiTech.name.toLowerCase().trim() === normalized) {
                    return aiTech;
                }
            }

            // Extract acronym from parentheses if present
            const acronymMatch = normalized.match(/\(([^)]+)\)/);
            const acronym = acronymMatch ? acronymMatch[1].toLowerCase() : null;

            // Try fuzzy match
            for (const aiTech of aiTechs) {
                const aiName = aiTech.name.toLowerCase().trim();
                const aiFirstWord = aiName.split(/[\s(]/)[0];
                const d1cvFirstWord = normalized.split(/[\s(]/)[0];

                if (aiFirstWord === d1cvFirstWord && aiFirstWord.length >= 2) {
                    const aiKeyword = aiName.replace(aiFirstWord, '').trim();
                    if (!aiKeyword || normalized.includes(aiKeyword.replace(/[()]/g, '').trim())) {
                        return aiTech;
                    }
                }

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
 */
d1cv.get('/api/d1cv/technologies/:identifier', async (c) => {
    const d1cvUrl = c.env.D1CV_API_URL;
    const identifier = decodeURIComponent(c.req.param('identifier'));

    if (!d1cvUrl) {
        return errorResponse('D1CV_API_URL not configured', 500);
    }

    try {
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

        const allTechs: Array<{ name: string; category?: string;[key: string]: unknown }> = [];

        if (data.technologyCategories) {
            for (const cat of data.technologyCategories) {
                if (cat.technologies) {
                    allTechs.push(...cat.technologies.map(t => ({ ...t, category: cat.name })));
                }
            }
        }

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
 * GET /api/d1cv/experience
 * Fetch all experience entries from D1CV database (v2 normalized)
 */
d1cv.get('/api/d1cv/experience', async (c) => {
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
d1cv.get('/api/d1cv/education', async (c) => {
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
d1cv.get('/api/d1cv/contact', async (c) => {
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
d1cv.get('/api/d1cv/profile', async (c) => {
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
d1cv.get('/api/d1cv/sections/:sectionType', async (c) => {
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
d1cv.post('/api/d1cv/experience', async (c) => {
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
d1cv.put('/api/d1cv/experience/:id', async (c) => {
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
d1cv.delete('/api/d1cv/experience/:id', async (c) => {
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
d1cv.post('/api/d1cv/education', async (c) => {
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
d1cv.put('/api/d1cv/education/:id', async (c) => {
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
d1cv.delete('/api/d1cv/education/:id', async (c) => {
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
d1cv.put('/api/d1cv/contact', async (c) => {
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
d1cv.put('/api/d1cv/profile', async (c) => {
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
d1cv.put('/api/d1cv/sections/:sectionType', async (c) => {
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
        await purgeD1CVCache(d1cvUrl, 'sections');

        return c.json(data);
    } catch (error) {
        console.error(`Update ${sectionType} section error:`, error);
        return errorResponse(`Failed to update ${sectionType} section: ${error}`, 500);
    }
});

export { d1cv };
