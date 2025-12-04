/**
 * Entities Routes
 * 
 * Single Responsibility: Handle entity lookup endpoints for form dropdowns
 * - Categories listing
 * - Technologies listing  
 * - D1CV cache purging
 */

import { Hono } from 'hono';
import type { Env } from '../types';
import { errorResponse } from '../utils';

const entities = new Hono<{ Bindings: Env }>();

/**
 * GET /entities/categories
 * Get technology categories from D1CV
 */
entities.get('/entities/categories', async (c) => {
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
 * POST /api/d1cv/cache/purge
 * Manually purge the D1CV cache
 * This forces the portfolio to fetch fresh data on next request
 */
entities.post('/api/d1cv/cache/purge', async (c) => {
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

        const data = await response.json() as Record<string, unknown>;
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
entities.get('/entities/technologies', async (c) => {
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

export { entities };
