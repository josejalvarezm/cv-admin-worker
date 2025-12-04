/**
 * Test utilities for cv-admin-worker
 * Provides mock factories for Cloudflare D1, KV, and Durable Objects
 */

import { vi } from 'vitest';

// ==========================================
// MOCK D1 DATABASE
// ==========================================

export interface MockD1Result<T = unknown> {
    results: T[];
    success: boolean;
    meta: {
        duration: number;
        rows_read: number;
        rows_written: number;
        last_row_id?: number;
    };
}

export interface MockD1PreparedStatement {
    bind: (...values: unknown[]) => MockD1PreparedStatement;
    first: <T = unknown>() => Promise<T | null>;
    all: <T = unknown>() => Promise<MockD1Result<T>>;
    run: () => Promise<MockD1Result>;
    raw: <T = unknown>() => Promise<T[]>;
}

export function createMockD1Database(options?: {
    firstResult?: unknown;
    allResults?: unknown[];
    runSuccess?: boolean;
    lastRowId?: number;
}) {
    const mockStatement: MockD1PreparedStatement = {
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(options?.firstResult ?? null),
        all: vi.fn().mockResolvedValue({
            results: options?.allResults ?? [],
            success: true,
            meta: { duration: 1, rows_read: 0, rows_written: 0 },
        }),
        run: vi.fn().mockResolvedValue({
            results: [],
            success: options?.runSuccess ?? true,
            meta: {
                duration: 1,
                rows_read: 0,
                rows_written: 1,
                last_row_id: options?.lastRowId ?? 1,
            },
        }),
        raw: vi.fn().mockResolvedValue([]),
    };

    return {
        prepare: vi.fn().mockReturnValue(mockStatement),
        dump: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
        batch: vi.fn().mockResolvedValue([]),
        exec: vi.fn().mockResolvedValue({
            results: [],
            success: true,
            meta: { duration: 1, rows_read: 0, rows_written: 0 },
        }),
        _statement: mockStatement, // Expose for test assertions
    };
}

// ==========================================
// MOCK KV NAMESPACE
// ==========================================

export function createMockKV(initialData: Record<string, string> = {}) {
    const store = new Map<string, string>(Object.entries(initialData));

    return {
        get: vi.fn(async (key: string) => store.get(key) ?? null),
        put: vi.fn(async (key: string, value: string) => {
            store.set(key, value);
        }),
        delete: vi.fn(async (key: string) => {
            store.delete(key);
        }),
        list: vi.fn(async () => ({
            keys: Array.from(store.keys()).map((name) => ({ name })),
            list_complete: true,
            cursor: '',
        })),
        _store: store, // Expose for test assertions
    };
}

// ==========================================
// MOCK DURABLE OBJECT
// ==========================================

export function createMockDurableObjectStub() {
    return {
        fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' },
        })),
    };
}

export function createMockDurableObjectNamespace() {
    return {
        idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-do-id' }),
        get: vi.fn().mockReturnValue(createMockDurableObjectStub()),
    };
}

// ==========================================
// MOCK ENVIRONMENT
// ==========================================

export interface MockEnv {
    CV_ADMIN_DB: ReturnType<typeof createMockD1Database>;
    D1CV_DB: ReturnType<typeof createMockD1Database>;
    AI_AGENT_DB: ReturnType<typeof createMockD1Database>;
    STAGING_KV: ReturnType<typeof createMockKV>;
    ENVIRONMENT: string;
    ADMIN_SECRET?: string;
    D1CV_API_URL?: string;
    AI_AGENT_API_URL?: string;
}

export function createMockEnv(overrides?: Partial<MockEnv>): MockEnv {
    return {
        CV_ADMIN_DB: createMockD1Database(),
        D1CV_DB: createMockD1Database(),
        AI_AGENT_DB: createMockD1Database(),
        STAGING_KV: createMockKV(),
        ENVIRONMENT: 'test',
        ADMIN_SECRET: 'test-secret',
        D1CV_API_URL: 'https://test-d1cv.example.com',
        AI_AGENT_API_URL: 'https://test-ai.example.com',
        ...overrides,
    };
}

// ==========================================
// REQUEST HELPERS
// ==========================================

export function createAuthenticatedRequest(
    path: string,
    options?: {
        method?: string;
        body?: unknown;
        email?: string;
    }
): Request {
    const { method = 'GET', body, email = 'admin@{YOUR_DOMAIN}' } = options ?? {};

    const init: RequestInit = {
        method,
        headers: {
            'Content-Type': 'application/json',
            'CF-Access-Authenticated-User-Email': email,
            'CF-Access-JWT-Assertion': 'test-jwt-token',
        },
    };

    if (body && method !== 'GET') {
        init.body = JSON.stringify(body);
    }

    return new Request(`http://localhost${path}`, init);
}

export function createUnauthenticatedRequest(
    path: string,
    options?: {
        method?: string;
        body?: unknown;
    }
): Request {
    const { method = 'GET', body } = options ?? {};

    const init: RequestInit = {
        method,
        headers: {
            'Content-Type': 'application/json',
        },
    };

    if (body && method !== 'GET') {
        init.body = JSON.stringify(body);
    }

    return new Request(`http://localhost${path}`, init);
}

// ==========================================
// TEST DATA FACTORIES
// ==========================================

export function createSampleTechnology(overrides?: Record<string, unknown>) {
    return {
        id: 1,
        category_id: 1,
        name: 'TypeScript',
        experience: '5+ years of TypeScript development',
        experience_years: 5,
        proficiency_percent: 90,
        level: 'Expert',
        display_order: 1,
        is_active: true,
        ...overrides,
    };
}

export function createSampleStagedChange(overrides?: Record<string, unknown>) {
    return {
        id: 'stage-123',
        action: 'CREATE',
        target: 'both',
        entity_type: 'technology',
        entity_id: null,
        stable_id: 'tech-typescript',
        payload: createSampleTechnology(),
        summary: 'Add TypeScript technology',
        created_at: new Date().toISOString(),
        ...overrides,
    };
}

export function createSampleCommit(overrides?: Record<string, unknown>) {
    return {
        id: 'commit-abc123',
        message: 'Add TypeScript technology',
        author: 'admin@{YOUR_DOMAIN}',
        created_at: new Date().toISOString(),
        pushed_at: null,
        status: 'pending',
        ...overrides,
    };
}
