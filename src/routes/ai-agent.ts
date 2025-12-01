/**
 * AI Agent Routes
 * 
 * Single Responsibility: Handle all AI Agent (cv-ai-agent) operations
 * - Read technologies
 * - Read categories
 * - Vectorize status and reindex
 */

import { Hono } from 'hono';
import type { Env } from '../types';
import { errorResponse } from '../utils';
import { fixEncodingInObject } from '../helpers';

const aiAgent = new Hono<{ Bindings: Env }>();

/**
 * GET /api/ai-agent/technologies
 * Fetch all technologies from cv-ai-agent database
 */
aiAgent.get('/api/ai-agent/technologies', async (c) => {
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
aiAgent.get('/api/ai-agent/technologies/:stableId', async (c) => {
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
aiAgent.get('/api/ai-agent/categories', async (c) => {
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
aiAgent.get('/api/ai-agent/vectorize/status', async (c) => {
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
aiAgent.post('/api/ai-agent/vectorize/reindex', async (c) => {
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

export { aiAgent };
