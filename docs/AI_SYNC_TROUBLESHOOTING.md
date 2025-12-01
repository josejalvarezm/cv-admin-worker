# AI Sync Flow - Troubleshooting Guide

## Problem Statement

The Admin Portal's "Apply to AI" functionality was failing to sync technology data to the AI Agent's semantic search index. Changes staged in the Admin Portal were not being reflected in the chatbot's knowledge base.

---

## System Architecture Overview

```mermaid
graph TB
    subgraph "Frontend Layer"
        PORTAL[Admin Portal<br/>admin.{YOUR_DOMAIN}]
    end

    subgraph "Orchestration Layer"
        WORKER[cv-admin-worker<br/>cv-admin.{YOUR_WORKERS_SUBDOMAIN}]
        STAGING[(cv-admin-staging<br/>D1 Database)]
    end

    subgraph "AI Layer"
        AI[cv-assistant-worker-production<br/>cv-assistant-worker-production.{YOUR_WORKERS_SUBDOMAIN}]
        AIDB[(cv_assistant_db<br/>D1 Database)]
        VECTORIZE[(Vectorize Index<br/>cv-skills-index)]
    end

    PORTAL -->|1. Stage changes| WORKER
    WORKER -->|2. Store| STAGING
    PORTAL -->|3. Apply to AI| WORKER
    WORKER -->|4. POST /api/admin/apply| AI
    AI -->|5. Insert/Update| AIDB
    AI -->|6. Generate embeddings| VECTORIZE

    style WORKER fill:#ff9999,stroke:#cc0000
    style AI fill:#99ff99,stroke:#00cc00
```

---

## The Sync Flow in Detail

### Step-by-Step Process

```mermaid
sequenceDiagram
    participant User as Admin User
    participant Portal as Admin Portal
    participant Worker as cv-admin-worker
    participant Staging as cv-admin-staging DB
    participant AI as cv-assistant-worker-production
    participant D1 as cv_assistant_db
    participant Vec as Vectorize

    Note over User,Vec: STAGING PHASE
    User->>Portal: Edit technology (e.g., update TypeScript description)
    Portal->>Worker: POST /stage {entity: "technology", data: {...}}
    Worker->>Staging: INSERT into staged_ai_changes
    Worker-->>Portal: {success: true, id: 123}
    Portal-->>User: "Change staged for AI sync"

    Note over User,Vec: APPLY PHASE
    User->>Portal: Click "Apply to AI"
    Portal->>Worker: POST /api/apply/ai
    Worker->>Staging: SELECT * FROM staged_ai_changes WHERE status='pending'
    Staging-->>Worker: [{id: 123, operation: 'UPDATE', data: {...}}]
    
    rect rgb(255, 200, 200)
        Note over Worker,AI: THIS IS WHERE THE ISSUE WAS
        Worker->>AI: POST /api/admin/apply<br/>{operations: [...]}
    end
    
    AI->>D1: INSERT/UPDATE technology record
    AI->>AI: Generate BGE-base embedding (768 dimensions)
    AI->>Vec: Upsert vector with metadata
    AI-->>Worker: {success: true, inserted: 1}
    Worker->>Staging: UPDATE status='applied' WHERE id=123
    Worker-->>Portal: {success: true, applied: 1}
    Portal-->>User: "1 change applied to AI"
```

---

## The Issue

### Root Cause

The `AI_AGENT_API_URL` secret in cv-admin-worker was configured with an **incorrect URL**:

| Configuration | Value | Status |
|--------------|-------|--------|
| **Configured URL** | `https://cv-ai-agent.{YOUR_WORKERS_SUBDOMAIN}` | ❌ Does not exist |
| **Correct URL** | `https://cv-assistant-worker-production.{YOUR_WORKERS_SUBDOMAIN}` | ✅ Working |

### What Was Happening

```mermaid
flowchart LR
    subgraph "Expected Flow"
        A1[cv-admin-worker] -->|POST /api/admin/apply| B1[cv-assistant-worker-production]
        B1 -->|Success| C1[Changes applied]
    end

    subgraph "Actual Flow (Broken)"
        A2[cv-admin-worker] -->|POST /api/admin/apply| B2[cv-ai-agent<br/>❌ DNS_NOT_FOUND]
        B2 -->|Network Error| C2[Changes marked 'failed']
    end

    style B2 fill:#ff6666,stroke:#cc0000
    style C2 fill:#ffcccc
    style B1 fill:#66ff66,stroke:#00cc00
    style C1 fill:#ccffcc
```

### Symptoms

1. **In Admin Portal**: "Apply to AI" button would fail or timeout
2. **In Staging DB**: Changes stuck in `pending` or marked as `failed`
3. **In Chatbot**: New or updated skills not appearing in search results
4. **In Logs**: Network errors like `ENOTFOUND` or `DNS resolution failed`

---

## The Fix

### What Was Done

1. **Updated the secret** in cv-admin-worker:
   ```bash
   npx wrangler secret put AI_AGENT_API_URL
   # Entered: https://cv-assistant-worker-production.{YOUR_WORKERS_SUBDOMAIN}
   ```

2. **Updated documentation** in `SECRETS.md` with correct URLs

3. **Created architecture documentation** to prevent future confusion

### Expected Outcome After Fix

```mermaid
flowchart TD
    subgraph "After Fix"
        A[Admin Portal] -->|1. Apply to AI| B[cv-admin-worker]
        B -->|2. Fetch pending changes| C[(cv-admin-staging)]
        C -->|3. Return operations| B
        B -->|4. POST to correct URL| D[cv-assistant-worker-production<br/>✅ WORKING]
        D -->|5. Insert to D1| E[(cv_assistant_db)]
        D -->|6. Generate embedding| F[Workers AI]
        F -->|7. 768-dim vector| D
        D -->|8. Upsert| G[(Vectorize<br/>cv-skills-index)]
        D -->|9. Success response| B
        B -->|10. Mark applied| C
        B -->|11. Return result| A
    end

    style D fill:#66ff66,stroke:#00cc00
    style G fill:#66ffff,stroke:#0099cc
```

---

## Verification Checklist

### Pre-Verification (Already Confirmed ✅)

| Check | Status | Details |
|-------|--------|---------|
| AI Agent health | ✅ | `/health` returns `{status: "healthy", db: "connected"}` |
| Database connectivity | ✅ | cv_assistant_db connected |
| AI quota available | ✅ | 9490/9500 neurons remaining |
| Secret updated | ✅ | `wrangler secret put` succeeded |

### End-to-End Verification (Pending)

| Step | How to Verify |
|------|---------------|
| 1. Stage a change | Open Admin Portal → Edit a technology → Save |
| 2. Check staging | Portal should show 1 pending AI change |
| 3. Apply to AI | Click "Apply to AI" button |
| 4. Verify success | Should show "1 change applied" |
| 5. Test search | Query chatbot for the updated technology |
| 6. Confirm in Vectorize | `/api/debug/vectors` should show updated timestamp |

---

## Related Files

| File | Purpose |
|------|---------|
| `cv-admin-worker/src/index.ts` | Contains `applyAiHandler` that calls AI Agent |
| `cv-admin-worker/SECRETS.md` | Documents all required secrets |
| `cv-admin-worker/docs/ARCHITECTURE.md` | Full system architecture diagrams |
| `cv-ai-agent/src/index.ts` | AI Agent's `/api/admin/apply` handler |

---

## Naming Confusion (Historical Context)

The project has two similar worker names which caused confusion:

| Worker Name | Purpose | Status |
|-------------|---------|--------|
| `cv-assistant-worker` | Was the dev environment | ❌ Deleted (redundant) |
| `cv-ai-agent` | Conceptual name used in documentation | ⚠️ No worker with this exact name exists |
| `cv-assistant-worker-production` | The actual AI Agent (semantic search) | ✅ Active, correct URL |

**Recommendation**: Consolidate to single worker name to avoid future confusion.
