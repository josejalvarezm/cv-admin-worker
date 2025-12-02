# CV Admin Worker - Copilot Agent Instructions

## Project Overview

**cv-admin-worker** is a Cloudflare Worker that serves as the backend API for the CV Admin Portal. It orchestrates data between:
- **D1CV** (portfolio database on Cloudflare D1)
- **cv-ai-agent** (AI enrichment service)
- **Staging system** (git-like workflow for changes)

## Architecture

### Tech Stack
- **Runtime**: Cloudflare Workers
- **Framework**: Hono (lightweight web framework)
- **Database**: Cloudflare D1 (SQLite-compatible)
- **Validation**: Zod schemas
- **Build**: Wrangler

### SOLID Architecture (v1.6.0+)

The codebase follows Single Responsibility Principle with routes extracted into separate modules:

```
src/
├── index.ts              # Minimal entry (55 lines) - CORS, health check, route mounting
├── routes/
│   ├── index.ts          # Barrel export
│   ├── technologies.ts   # Technology CRUD operations (253 lines)
│   ├── staging.ts        # Legacy staging system (379 lines)
│   ├── apply.ts          # Apply staged changes to production (223 lines)
│   ├── entities.ts       # Entity lookups for forms (93 lines)
│   ├── d1cv.ts           # D1CV database operations (591 lines)
│   ├── ai-agent.ts       # AI Agent proxy endpoints (126 lines)
│   ├── commits.ts        # Git-like v2 workflow (479 lines)
│   └── lookup.ts         # Unified lookup + similarity (263 lines)
├── helpers/
│   ├── cache.ts          # Cache purging utilities
│   ├── encoding.ts       # UTF-8 encoding fixes
│   └── index.ts          # Barrel export
├── repository.ts         # StagingRepository, CommitRepository
├── schemas.ts            # Zod validation schemas
├── types.ts              # TypeScript interfaces
├── utils.ts              # Error response helpers
└── durable-objects/
    └── JobOrchestrator.ts # Async job processing
```

## Key Patterns

### Route Module Pattern
Each route file exports a Hono instance with full paths:

```typescript
// src/routes/technologies.ts
import { Hono } from 'hono';
import type { Env } from '../types';

const technologies = new Hono<{ Bindings: Env }>();

technologies.get('/api/technologies', async (c) => { ... });
technologies.post('/api/technologies', async (c) => { ... });

export { technologies };
```

Routes are mounted in `index.ts`:
```typescript
app.route('/', technologies);
app.route('/', staging);
// etc.
```

### Unified Technology Lookup
The `/api/technology/unified/:name` endpoint fetches data from all sources in one request:
- D1CV production database
- AI Agent production
- Staging tables

### Git-like Workflow (v2 API)
Changes go through a staging workflow:
1. `POST /v2/stage` - Stage a change
2. `POST /v2/commit` - Commit staged changes
3. `POST /v2/push/d1cv` or `/v2/push/ai` - Push to production

## Environment Bindings

```toml
[vars]
D1CV_API_URL = "https://{YOUR_DOMAIN}"
AI_AGENT_API_URL = "https://cv.{YOUR_DOMAIN}"
AI_AGENT_URL = "https://cv.{YOUR_DOMAIN}"

[[d1_databases]]
binding = "DB"              # cv-admin-staging
database_name = "cv-admin-staging"

[[d1_databases]]
binding = "D1CV_DB"         # cv-database (read-only)
database_name = "cv-database"

[[durable_objects.bindings]]
name = "JOB_ORCHESTRATOR"
class_name = "JobOrchestrator"
```

## Common Operations

### Adding a New Route Module

1. Create file in `src/routes/`:
```typescript
import { Hono } from 'hono';
import type { Env } from '../types';

const myRoute = new Hono<{ Bindings: Env }>();

myRoute.get('/api/my-endpoint', async (c) => {
  // Implementation
});

export { myRoute };
```

2. Add to barrel export in `src/routes/index.ts`:
```typescript
export { myRoute } from './my-route';
```

3. Mount in `src/index.ts`:
```typescript
import { ..., myRoute } from './routes';
app.route('/', myRoute);
```

### Build and Deploy

```powershell
# Verify build
npx wrangler deploy --dry-run

# Deploy to production
npm run deploy
# or
npx wrangler deploy
```

### Testing Endpoints

```powershell
# Health check
Invoke-RestMethod "https://api.admin.{YOUR_DOMAIN}/"

# Get technologies with AI match status
Invoke-RestMethod "https://api.admin.{YOUR_DOMAIN}/api/d1cv/technologies/with-ai-match"

# Unified lookup
Invoke-RestMethod "https://api.admin.{YOUR_DOMAIN}/api/technology/unified/JavaScript"

# Check staging stats
Invoke-RestMethod "https://api.admin.{YOUR_DOMAIN}/v2/stats"
```

## Related Projects

| Project | Type | Deployment | Purpose |
|---------|------|------------|---------|
| cv-admin-portal-private | Cloudflare Pages | `npx wrangler pages deploy dist` | React admin UI |
| cv-admin-worker-private | Cloudflare Worker | `npm run deploy` | This API |
| d1-cv-private | Cloudflare Worker | `npm run deploy` | Portfolio API |
| cv-ai-agent | Cloudflare Worker | `npm run deploy` | AI chatbot backend |

## Version History

- **v1.6.0** - SOLID refactoring complete (2908 lines extracted from index.ts)
- **v1.5.0** - Earlier version
- **v1.0.0** - Initial release

## Debugging Tips

1. **Encoding issues**: Use `fixEncodingInObject()` from helpers for UTF-8 fixes
2. **Cache issues**: Use `/api/d1cv/cache/purge` to clear D1CV cache
3. **Build failures**: Check for unused imports after refactoring
4. **API errors**: Check `errorResponse()` usage for consistent error format
