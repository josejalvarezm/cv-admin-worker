# CV Admin Worker - Terraform Infrastructure

This directory contains Terraform configuration for the cv-admin-worker infrastructure on Cloudflare.

## What This Manages

| Resource | Description |
|----------|-------------|
| **D1 Database** | `cv-admin-staging` - Stores commits, staged changes, jobs |
| **Custom Domain** | `api.admin.{YOUR_DOMAIN}` → `cv-admin-worker` |

## What Wrangler Manages

- Worker script deployment
- Durable Object (`JobOrchestrator`) migrations
- D1 database bindings
- Secrets (`WEBHOOK_SECRET`, `D1CV_API_URL`, `AI_AGENT_API_URL`)

## Prerequisites

1. **Terraform** installed (>= 1.0)
   ```powershell
   winget install Hashicorp.Terraform
   ```

2. **Cloudflare API Token** with permissions:
   - Account: D1 Edit
   - Zone: Workers Routes Edit
   - Zone: DNS Edit

3. Set environment variable:
   ```powershell
   $env:CLOUDFLARE_API_TOKEN = "your-api-token"
   ```

## Usage

### Initialize (one-time)

```powershell
cd D:\Code\cv-admin-worker-private\infra\terraform
terraform init
```

### Plan changes

```powershell
terraform plan
```

### Apply infrastructure

```powershell
terraform apply
```

### Import existing resources

If resources already exist (created via Wrangler):

```powershell
# Import D1 database
terraform import cloudflare_d1_database.admin_staging <account_id>/<database_id>

# Import custom domain
terraform import cloudflare_worker_domain.admin_api <account_id>/<domain_id>
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Cloudflare Edge                          │
├─────────────────────────────────────────────────────────────┤
│  api.admin.{YOUR_DOMAIN}                                  │
│         │                                                   │
│         ▼                                                   │
│  ┌─────────────────┐    ┌──────────────────────┐           │
│  │ cv-admin-worker │───▶│ JobOrchestrator (DO) │           │
│  └────────┬────────┘    └──────────────────────┘           │
│           │                                                 │
│           ▼                                                 │
│  ┌─────────────────┐                                       │
│  │ cv-admin-staging│  (D1 Database)                        │
│  │ - commits       │                                       │
│  │ - staged_changes│                                       │
│  │ - jobs          │                                       │
│  └─────────────────┘                                       │
└─────────────────────────────────────────────────────────────┘
```

## Related Resources

- **Worker code**: `../../src/`
- **Migrations**: `../../migrations/`
- **Secrets**: See `../../SECRETS.md`
