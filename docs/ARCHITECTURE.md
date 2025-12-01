# CV Admin System - Architecture Documentation

> **Last Updated:** 2025-12-01  
> **Status:** Production  
> **Author:** Jose Alvarez

---

## Overview

The CV Admin System is a multi-service architecture for managing portfolio content with AI-powered semantic search. It consists of three main components that work together to stage, apply, and index technology skills data.

---

## System Architecture

```mermaid
graph TB
    subgraph "Frontend"
        PORTAL[cv-admin-portal<br/>React + MUI]
    end

    subgraph "Orchestration Layer"
        WORKER[cv-admin-worker<br/>Hono + D1]
        STAGING[(cv-admin-staging<br/>D1 Database)]
    end

    subgraph "Production Systems"
        D1CV[D1CV Worker<br/>Portfolio API]
        D1CV_DB[(cv-database<br/>D1 Production)]
        
        AI[cv-ai-agent<br/>Semantic Search]
        AI_DB[(cv_assistant_db<br/>D1 + Vectorize)]
    end

    PORTAL -->|Stage changes| WORKER
    WORKER -->|Store staged| STAGING
    WORKER -->|Apply to D1CV| D1CV
    WORKER -->|Apply to AI| AI
    D1CV -->|Read/Write| D1CV_DB
    AI -->|Read/Write| AI_DB
    
    style PORTAL fill:#61dafb,color:#000
    style WORKER fill:#f6821f,color:#fff
    style D1CV fill:#f6821f,color:#fff
    style AI fill:#f6821f,color:#fff
    style STAGING fill:#4a5568,color:#fff
    style D1CV_DB fill:#4a5568,color:#fff
    style AI_DB fill:#4a5568,color:#fff
```

---

## Component Responsibilities

### 1. cv-admin-portal (Frontend)

**Repository:** `cv-admin-portal-private`  
**URL:** `https://admin.{YOUR_DOMAIN}`  
**Stack:** React 18, TypeScript, Material UI, TanStack Query

| Responsibility | Description |
|----------------|-------------|
| UI for content management | CRUD operations for technologies, experience, etc. |
| Staging workflow | Stage changes before applying to production |
| Dual-queue management | Separate queues for D1CV and AI Agent |
| Apply triggers | Buttons to apply staged changes to target systems |

### 2. cv-admin-worker (Orchestrator)

**Repository:** `cv-admin-worker-private`  
**URL:** `https://api.admin.{YOUR_DOMAIN}`  
**Stack:** Hono, TypeScript, Cloudflare Workers, D1

| Responsibility | Description |
|----------------|-------------|
| Staging database | Stores pending changes in `cv-admin-staging` D1 |
| D1CV proxy | Proxies read requests to D1CV for unified auth |
| Apply to D1CV | Direct D1 writes to `cv-database` |
| Apply to AI Agent | Calls `/api/admin/apply` on cv-ai-agent |
| Cache purging | Invalidates D1CV cache after mutations |

### 3. cv-ai-agent (Semantic Search Engine)

**Repository:** `cv-ai-agent-private`  
**URL:** `https://cv-assistant-worker-production.{YOUR_WORKERS_SUBDOMAIN}`  
**Stack:** TypeScript, Cloudflare Workers, D1, Vectorize, Workers AI

| Responsibility | Description |
|----------------|-------------|
| D1 data storage | Stores technology records in `cv_assistant_db` |
| Embedding generation | Creates 768-dim vectors via Workers AI (BGE-base) |
| Vector indexing | Upserts embeddings to Vectorize index |
| Semantic search | Handles `/query` endpoint for chatbot |
| Admin apply endpoint | `/api/admin/apply` for batch operations |

---

## Data Flow: Staging to Production

### Flow 1: Apply to D1CV (Portfolio)

```mermaid
sequenceDiagram
    participant Portal as Admin Portal
    participant Worker as cv-admin-worker
    participant Staging as Staging DB
    participant D1CV as D1CV Database
    participant Cache as D1CV Cache

    Portal->>Worker: POST /api/apply/d1cv
    Worker->>Staging: Get pending D1CV changes
    Staging-->>Worker: Pending records
    
    loop For each change
        Worker->>D1CV: INSERT/UPDATE/DELETE
        D1CV-->>Worker: Success
        Worker->>Staging: Update status = 'applied'
    end
    
    Worker->>Cache: POST /api/cache/purge/technologies
    Cache-->>Worker: Purged
    Worker-->>Portal: {applied: N, failed: 0}
```

### Flow 2: Apply to AI Agent (Semantic Search)

```mermaid
sequenceDiagram
    participant Portal as Admin Portal
    participant Worker as cv-admin-worker
    participant Staging as Staging DB
    participant AI as cv-ai-agent
    participant D1 as AI D1 Database
    participant Vec as Vectorize
    participant WAI as Workers AI

    Portal->>Worker: POST /api/apply/ai
    Worker->>Staging: Get pending AI changes
    Staging-->>Worker: Pending records
    
    Worker->>AI: POST /api/admin/apply<br/>{job_id, operations}
    
    Note over AI: Process operations
    
    loop For each INSERT/UPDATE
        AI->>D1: INSERT/UPDATE technology
        D1-->>AI: Record ID
        AI->>WAI: Generate embedding
        WAI-->>AI: 768-dim vector
        AI->>Vec: Upsert vector
        Vec-->>AI: Success
    end
    
    loop For each DELETE
        AI->>D1: DELETE technology
        AI->>Vec: Delete vector
    end
    
    AI-->>Worker: {success: true, inserted: N}
    Worker->>Staging: Update status = 'applied'
    Worker-->>Portal: {applied: N, reindexed: true}
```

---

## Database Schema

### cv-admin-staging (Staging Database)

```mermaid
erDiagram
    staged_d1cv {
        integer id PK
        string entity_type
        string entity_id
        string stable_id
        string operation
        text payload
        string status
        string error
        datetime created_at
        datetime updated_at
    }
    
    staged_ai_agent {
        integer id PK
        string entity_type
        string entity_id
        string stable_id
        string operation
        text payload
        boolean requires_reindex
        string status
        string error
        datetime created_at
        datetime updated_at
    }
```

### cv_assistant_db (AI Agent Database)

```mermaid
erDiagram
    technology {
        integer id PK
        string stable_id UK
        string name
        string experience
        integer experience_years
        string level
        integer category_id FK
        string summary
        string action
        string effect
        string outcome
        string related_project
        string employer
    }
    
    technology_category {
        integer id PK
        string name
        string icon
    }
    
    vectors {
        string id PK
        blob embedding
        text metadata
        datetime created_at
    }
    
    technology_category ||--o{ technology : contains
```

---

## API Endpoints

### cv-admin-worker

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/technologies` | List all technologies (proxy to D1CV) |
| GET | `/api/technologies/with-ai-match` | Technologies with AI sync status |
| POST | `/stage` | Stage a new change |
| GET | `/staged` | Get all staged changes |
| POST | `/api/apply/d1cv` | Apply D1CV changes |
| POST | `/api/apply/ai` | Apply AI Agent changes |
| POST | `/api/purge-d1cv-cache` | Purge D1CV cache |

### cv-ai-agent

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check with quota info |
| POST | `/query` | Semantic search query |
| POST | `/api/admin/apply` | Batch apply operations |
| POST | `/index` | Trigger vector indexing |
| GET | `/api/admin/quota` | AI quota status |

---

## Secrets Configuration

### cv-admin-worker Secrets

```powershell
cd D:\Code\cv-admin-worker-private

# D1CV API for portfolio data
npx wrangler secret put D1CV_API_URL
# Value: https://api.d1.worker.{YOUR_DOMAIN}

# AI Agent API for semantic search (CORRECTED 2025-12-01)
npx wrangler secret put AI_AGENT_API_URL
# Value: https://cv-assistant-worker-production.{YOUR_WORKERS_SUBDOMAIN}

# Authorised admin emails
npx wrangler secret put ALLOWED_EMAILS
# Value: {YOUR_EMAIL}

# Webhook HMAC secret
npx wrangler secret put WEBHOOK_SECRET
# Value: (generate with command below)
```

### Generate Webhook Secret

```powershell
[System.Convert]::ToBase64String(
  [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
)
```

---

## Manual Operations (cv-skills-ops)

The `cv-skills-ops` folder in `cv-ai-agent-private` contains scripts for manual maintenance:

| Script | Purpose | When to Use |
|--------|---------|-------------|
| `reindex.ps1` | Full vector re-indexing | After bulk data changes |
| `add-technology.ps1` | Add single technology | Quick manual adds |
| `verify-sync.ps1` | Check D1/Vectorize sync | Debugging mismatches |

### Re-index All Vectors

```powershell
cd D:\Code\cv-ai-agent-private\cv-skills-ops
.\reindex.ps1 -Environment production
```

---

## Troubleshooting

### AI Sync Failing

1. **Check AI_AGENT_API_URL secret is correct:**
   ```powershell
   # Correct URL (as of 2025-12-01):
   # https://cv-assistant-worker-production.{YOUR_WORKERS_SUBDOMAIN}
   ```

2. **Verify AI Agent is healthy:**
   ```powershell
   Invoke-RestMethod -Uri "https://cv-assistant-worker-production.{YOUR_WORKERS_SUBDOMAIN}/health"
   ```

3. **Check AI quota:**
   ```powershell
   Invoke-RestMethod -Uri "https://cv-assistant-worker-production.{YOUR_WORKERS_SUBDOMAIN}/api/admin/quota"
   ```

### D1CV Apply Failing

1. **Check D1CV_DB binding in wrangler.toml**
2. **Verify category_id exists in target database**
3. **Check for constraint violations (unique names)**

---

## Version History

| Date | Change | Author |
|------|--------|--------|
| 2025-12-01 | Fixed AI_AGENT_API_URL secret (was pointing to non-existent URL) | Jose |
| 2025-11-29 | Added webhook flow documentation | Jose |
| 2025-11-15 | Initial architecture documentation | Jose |

---

## Related Documentation

- [SECRETS.md](./SECRETS.md) - Secret values reference
- [README.md](./README.md) - Quick start guide
- [cv-ai-agent-private/cv-skills-ops/README.md](../cv-ai-agent-private/cv-skills-ops/README.md) - Manual ops guide
