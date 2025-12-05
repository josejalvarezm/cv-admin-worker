# CV Admin Worker - CI/CD & Testing Architecture

**Project:** cv-admin-worker-private (Cloudflare Worker + D1 Database)  
**Framework:** TypeScript Worker  
**Deployment Target:** Cloudflare Workers  
**Infrastructure:** Terraform (D1, custom domains, routes)  
**Last Updated:** December 4, 2025

## Architecture Overview

This document outlines the continuous integration, testing, and deployment strategy for the backend worker that powers the admin portal with D1 database integration.

## Technology Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| **Runtime** | Cloudflare Workers | — |
| **Language** | TypeScript | 5.7+ |
| **Database** | Cloudflare D1 | — |
| **Test Runner** | Vitest | Latest |
| **CI/CD** | GitHub Actions | — |
| **Infrastructure** | Terraform | 1.0+ |
| **Package Manager** | npm/Wrangler | Latest |

## Testing Strategy

### Unit Tests
- **Framework:** Vitest
- **Count:** 69 tests
- **Scope:** Route handlers, database queries, authentication, error handling
- **Execution:** `npm run test`
- **Coverage Target:** >80% (backend is critical path)

### Vitest Configuration

```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',  // Workers run in JS runtime, not browser
    include: ['src/**/*.test.ts']
  }
});
```

### Why Vitest for Workers?

| Reason | Benefit |
|--------|---------|
| **Zero config** | Works with Wrangler setup automatically |
| **ESM native** | Workers use ES modules natively |
| **Fast** | No transpilation overhead |
| **Mocking** | Built-in mocking for Bindings, KV, D1 |

## CI/CD Pipeline

### Workflow: `ci-cd.yml`

```
Trigger: Push to main branch
│
├─ Job: Test (Vitest)
│  ├─ Runs: npm run test
│  └─ Coverage: Must pass
│
├─ Job: Lint (ESLint)
│  ├─ Runs: npm run lint
│  └─ Type check: npm run type-check
│
├─ Job: Terraform Plan (Preview infrastructure changes)
│  ├─ Runs: terraform plan -no-color
│  ├─ Cloud: HCP Terraform (josejalverezmterraform/cloudflare-d1-cv-main)
│  └─ Output: Plan comments on PRs
│
├─ Job: Deploy Worker (only on main)
│  ├─ Runs: wrangler deploy
│  ├─ Secrets: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
│  └─ Target: Workers production
│
└─ Job: Terraform Apply (only on main)
   ├─ Runs: terraform apply
   ├─ Backend: HCP Terraform
   └─ Manages: D1 bindings, custom domains, worker routes
```

### Two-Phase Deployment

| Phase | What | Tool | When |
|-------|------|------|------|
| **Code Deploy** | Worker code (.js) | Wrangler CLI | Every main push |
| **Infra Deploy** | Database bindings, routes | Terraform | After code succeeds |

**Why Two Tools?**
- Wrangler: Fast code deployment, handles bundling/publishing
- Terraform: Version-controlled infrastructure, disaster recovery

## Build & Deployment

### Build Process
```bash
npm run build
# Wrangler bundles TypeScript → JavaScript
# Output: Hidden in node_modules/.wrangler/
```

### Wrangler Configuration

```toml
# wrangler.toml
name = "cv-admin-worker"
main = "src/index.ts"
compatibility_date = "2024-12-04"

[env.production]
vars = { ENVIRONMENT = "production" }
d1_databases = [
  { binding = "DB", database_name = "cv_database", database_id = "..." }
]
```

### Deployment Security

- **API Token:** `CLOUDFLARE_API_TOKEN` (scoped to Workers:Edit)
- **Account ID:** `CLOUDFLARE_ACCOUNT_ID`
- **D1 Binding:** Set via wrangler.toml + Terraform

## Infrastructure as Code (Terraform)

### Terraform Structure

```
infra/terraform/
├── main.tf           # D1 database resource
├── variables.tf      # Input variables (environment, region)
├── outputs.tf        # Database ID, host exports
├── provider.tf       # Cloudflare provider config
└── backend.tf        # HCP Terraform backend config
```

### Key Resources Managed

```terraform
resource "cloudflare_d1_database" "cv_database" {
  account_id = local.account_id
  name       = var.database_name
  description = "CV data storage for admin portal"
}

resource "cloudflare_worker_route" "api_route" {
  zone_id     = local.zone_id
  pattern     = "api.{YOUR_DOMAIN}/*"
  script_name = "cv-admin-worker"
}
```

### State Management

- **Backend:** HCP Terraform Cloud
- **Organization:** josejalverezmterraform
- **Workspace:** cloudflare-d1-cv-main
- **State Lock:** Automatic (prevents concurrent applies)

## Disaster Recovery

### Recovery Time Objective (RTO)
- **Target:** <10 minutes
- **Process:** Automated Terraform apply from Git history

### Recovery Point Objective (RPO)
- **Target:** Last commit (no data loss)
- **Backup Strategy:** D1 exports to storage, versioned in Git

### Recovery Procedure

```bash
# 1. Infrastructure rebuilt from Terraform
terraform apply

# 2. Latest backup loaded into D1
npm run db:restore

# 3. Worker redeployed
wrangler deploy

# 4. Verify connectivity
npm run test:integration
```

**Full recovery in ~10 minutes with zero code changes required.**

## Version Management

### Semantic Versioning

```bash
# Tag releases
git tag v1.1.0-ci-cd
git push origin v1.1.0-ci-cd

# GitHub Actions can auto-deploy tagged releases
# Useful for rollback: git checkout v1.0.0
```

## Monitoring & Debugging

### Production Logs

```bash
# Stream live logs from Cloudflare
wrangler tail

# Filter by status code
wrangler tail --format json | grep "status: 5"
```

### Database Queries

```bash
# Local D1 shell
npm run db:shell

# Production export
wrangler d1 export cv_database > backup-$(date +%s).sql
```

## Common Issues & Solutions

### Terraform Apply Fails: "Database already exists"

**Cause:** D1 created manually, not via Terraform  
**Fix:** Import into state: `terraform import cloudflare_d1_database.cv_database <db_id>`

### Worker Routes Not Resolving

**Cause:** CNAME record not pointing to Cloudflare  
**Fix:** Verify DNS in Cloudflare dashboard matches Terraform output

### Test Fails: D1 Binding Not Found

**Cause:** Vitest doesn't load wrangler.toml bindings  
**Fix:** Mock D1 in tests or use Wrangler's test environment

```typescript
// Mock example
const mockDB = {
  prepare: (sql: string) => ({
    bind: (...args) => ({ ... })
  })
};
```

## Performance Targets

- **Response time:** <200ms p95 (including D1 query)
- **Availability:** 99.95% (Cloudflare SLA)
- **Database:** <50ms query latency for common queries

## Related Documentation

- [ARCHITECTURE.md](../docs/ARCHITECTURE.md) — Worker design patterns
- [Cloudflare D1 Guide](https://developers.cloudflare.com/d1/)
- [Terraform Cloudflare Provider](https://registry.terraform.io/providers/cloudflare/cloudflare/latest)
