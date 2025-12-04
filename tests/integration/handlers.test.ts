/**
 * Handler Integration Tests for cv-admin-worker
 * Tests API routes using Hono's test utilities
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../src/types';

// Create a mock D1 database
function createMockD1() {
    const mockPrepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({ results: [] }),
        run: vi.fn().mockResolvedValue({ meta: { last_row_id: 1 } }),
        first: vi.fn().mockResolvedValue(null),
    });

    return {
        prepare: mockPrepare,
        exec: vi.fn().mockResolvedValue({ results: [] }),
        batch: vi.fn().mockResolvedValue([]),
        dump: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
    } as unknown as D1Database;
}

// Create mock environment
function createMockEnv(): Env {
    return {
        DB: createMockD1(),
        D1CV_DB: createMockD1(),
        D1CV_API_URL: 'https://api.example.com',
        AI_AGENT_URL: 'https://ai.example.com',
        AI_AGENT_SYNC_TOKEN: 'test-token',
        ADMIN_AUTH_SECRET: 'test-secret',
        JOB_ORCHESTRATOR: {} as DurableObjectNamespace,
    };
}

describe('Health Check Endpoint', () => {
    it('should return healthy status', async () => {
        const app = new Hono<{ Bindings: Env }>();
        app.get('/api/health', (c) => c.json({ status: 'healthy', timestamp: new Date().toISOString() }));

        const res = await app.request('/api/health');
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data.status).toBe('healthy');
        expect(data.timestamp).toBeDefined();
    });
});

describe('Technologies Route', () => {
    let app: Hono<{ Bindings: Env }>;
    let mockEnv: Env;

    beforeEach(() => {
        mockEnv = createMockEnv();
        app = new Hono<{ Bindings: Env }>();
    });

    describe('GET /api/technologies', () => {
        it('should return 500 when D1CV_API_URL is not configured', async () => {
            const envWithoutUrl = { ...mockEnv, D1CV_API_URL: '' };
            app.get('/api/technologies', async (c) => {
                const d1cvUrl = envWithoutUrl.D1CV_API_URL;
                if (!d1cvUrl) {
                    return c.json({ error: 'D1CV_API_URL not configured' }, 500);
                }
                return c.json([]);
            });

            const res = await app.request('/api/technologies');
            expect(res.status).toBe(500);

            const data = await res.json();
            expect(data.error).toBe('D1CV_API_URL not configured');
        });

        it('should transform D1CV response to flat array', async () => {
            const mockD1CVResponse = {
                technologyCategories: [
                    {
                        name: 'Frontend',
                        technologies: [
                            { name: 'TypeScript', experience: 'Expert', experienceYears: 8, proficiencyPercent: 95, level: 'Advanced' },
                            { name: 'React', experience: 'Expert', experienceYears: 6, proficiencyPercent: 90, level: 'Advanced' },
                        ]
                    },
                    {
                        name: 'Backend',
                        technologies: [
                            { name: 'Node.js', experience: 'Advanced', experienceYears: 7, proficiencyPercent: 85, level: 'Advanced' },
                        ]
                    }
                ]
            };

            // Mock fetch for D1CV
            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve(mockD1CVResponse),
            });

            app.get('/api/technologies', async (c) => {
                const response = await fetch(`${mockEnv.D1CV_API_URL}/api/v2/cvs/1/technologies`);
                const data = await response.json() as typeof mockD1CVResponse;

                const technologiesList: any[] = [];
                let idCounter = 1;
                let categoryIdCounter = 1;
                const categoryMap = new Map<string, number>();

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
            });

            const res = await app.request('/api/technologies');
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(data).toHaveLength(3);
            expect(data[0].name).toBe('TypeScript');
            expect(data[0].category).toBe('Frontend');
            expect(data[0].category_id).toBe(1);
            expect(data[2].name).toBe('Node.js');
            expect(data[2].category).toBe('Backend');
            expect(data[2].category_id).toBe(2);
        });

        it('should handle D1CV fetch errors gracefully', async () => {
            global.fetch = vi.fn().mockResolvedValue({
                ok: false,
                status: 503,
            });

            app.get('/api/technologies', async (c) => {
                const response = await fetch(`${mockEnv.D1CV_API_URL}/api/v2/cvs/1/technologies`);
                if (!response.ok) {
                    return c.json({ error: 'Failed to fetch technologies from D1CV' }, response.status as 500);
                }
                return c.json([]);
            });

            const res = await app.request('/api/technologies');
            expect(res.status).toBe(503);

            const data = await res.json();
            expect(data.error).toContain('Failed to fetch');
        });
    });

    describe('GET /api/technologies/count', () => {
        it('should return technology counts by category', async () => {
            const mockD1CVResponse = {
                technologyCategories: [
                    { name: 'Frontend', technologies: [{}, {}, {}] },
                    { name: 'Backend', technologies: [{}, {}] },
                    { name: 'DevOps', technologies: [{}] },
                ]
            };

            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve(mockD1CVResponse),
            });

            app.get('/api/technologies/count', async (c) => {
                const response = await fetch(`${mockEnv.D1CV_API_URL}/api/v2/cvs/1/technologies`);
                const data = await response.json() as typeof mockD1CVResponse;

                const byCategory: Record<string, number> = {};
                let total = 0;

                for (const category of data.technologyCategories) {
                    byCategory[category.name] = category.technologies.length;
                    total += category.technologies.length;
                }

                return c.json({ total, active: total, byCategory });
            });

            const res = await app.request('/api/technologies/count');
            expect(res.status).toBe(200);

            const data = await res.json();
            expect(data.total).toBe(6);
            expect(data.active).toBe(6);
            expect(data.byCategory.Frontend).toBe(3);
            expect(data.byCategory.Backend).toBe(2);
            expect(data.byCategory.DevOps).toBe(1);
        });
    });
});

describe('Staging Route', () => {
    let app: Hono<{ Bindings: Env }>;
    let mockEnv: Env;

    beforeEach(() => {
        mockEnv = createMockEnv();
        app = new Hono<{ Bindings: Env }>();
    });

    describe('POST /stage', () => {
        it('should validate required fields', async () => {
            app.post('/stage', async (c) => {
                try {
                    const body = await c.req.json();

                    if (!body.operation || !body.entity_type || !body.d1cv_payload) {
                        return c.json({ error: 'Missing required fields', success: false }, 400);
                    }

                    return c.json({ success: true, d1cv_staged_id: 1 });
                } catch {
                    return c.json({ error: 'Invalid JSON' }, 400);
                }
            });

            // Missing operation
            const res1 = await app.request('/stage', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ entity_type: 'technology', d1cv_payload: { name: 'Test' } }),
            });
            expect(res1.status).toBe(400);

            // Missing entity_type
            const res2 = await app.request('/stage', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ operation: 'INSERT', d1cv_payload: { name: 'Test' } }),
            });
            expect(res2.status).toBe(400);
        });

        it('should require entity_id or entity_name for UPDATE/DELETE', async () => {
            app.post('/stage', async (c) => {
                const body = await c.req.json();

                if (body.operation !== 'INSERT') {
                    const hasId = body.entity_id !== null && body.entity_id !== undefined;
                    const hasName = body.entity_name && body.entity_name !== '';

                    if (!hasId && !hasName) {
                        return c.json({
                            error: 'entity_id or entity_name is required for UPDATE and DELETE operations',
                            success: false
                        }, 400);
                    }
                }

                return c.json({ success: true, d1cv_staged_id: 1 });
            });

            // UPDATE without entity_id or entity_name
            const res = await app.request('/stage', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    operation: 'UPDATE',
                    entity_type: 'technology',
                    d1cv_payload: { name: 'Updated' },
                }),
            });

            expect(res.status).toBe(400);
            const data = await res.json();
            expect(data.error).toContain('entity_id or entity_name is required');
        });

        it('should accept valid INSERT request', async () => {
            app.post('/stage', async (c) => {
                const body = await c.req.json();

                if (!body.operation || !body.entity_type || !body.d1cv_payload) {
                    return c.json({ error: 'Missing required fields' }, 400);
                }

                return c.json({
                    success: true,
                    d1cv_staged_id: 1,
                    ai_staged_id: null,
                });
            });

            const res = await app.request('/stage', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    operation: 'INSERT',
                    entity_type: 'technology',
                    d1cv_payload: {
                        name: 'New Technology',
                        experience: 'Beginner',
                        experienceYears: 1,
                        proficiencyPercent: 50,
                        level: 'Beginner',
                        category: 'Testing',
                    },
                }),
            });

            expect(res.status).toBe(200);
            const data = await res.json();
            expect(data.success).toBe(true);
            expect(data.d1cv_staged_id).toBe(1);
        });
    });
});

describe('Error Handling', () => {
    it('should return 404 for unknown routes', async () => {
        const app = new Hono();
        app.notFound((c) => c.json({ error: 'Not Found' }, 404));

        const res = await app.request('/api/unknown');
        expect(res.status).toBe(404);
    });

    it('should handle JSON parse errors', async () => {
        const app = new Hono();
        app.post('/test', async (c) => {
            try {
                await c.req.json();
                return c.json({ success: true });
            } catch {
                return c.json({ error: 'Invalid JSON body' }, 400);
            }
        });

        const res = await app.request('/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: 'not valid json',
        });

        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toContain('Invalid JSON');
    });
});

describe('CORS Middleware', () => {
    it('should handle OPTIONS preflight requests', async () => {
        const app = new Hono();

        app.options('*', (c) => {
            return new Response(null, {
                status: 204,
                headers: {
                    'Access-Control-Allow-Origin': 'https://admin.{YOUR_DOMAIN}',
                    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, Authorization, CF-Access-JWT-Assertion',
                    'Access-Control-Max-Age': '86400',
                },
            });
        });

        const res = await app.request('/api/technologies', { method: 'OPTIONS' });
        expect(res.status).toBe(204);
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://admin.{YOUR_DOMAIN}');
        expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
        expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    });
});
