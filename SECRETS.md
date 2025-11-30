# CV Admin Worker - Secrets Reference

> ⚠️ **PRIVATE FILE** - Never commit to public repos

## Cloudflare Worker Secrets

### cv-admin-worker

**Worker URL:** https://cv-admin-worker.{YOUR_WORKERS_SUBDOMAIN}

| Secret | Value | Description |
|--------|-------|-------------|
| `D1CV_API_URL` | `https://api.d1.worker.{YOUR_DOMAIN}` | D1CV Worker API |
| `AI_AGENT_API_URL` | `https://cv-ai-agent.{YOUR_WORKERS_SUBDOMAIN}` | AI Agent Worker API |
| `ALLOWED_EMAILS` | `{YOUR_EMAIL}` | Authorized admin emails |

### D1 Database

| Resource | ID | Region |
|----------|-------|--------|
| `cv-admin-staging` | `{ADMIN_WORKER_DATABASE_ID}` | EEUR |

---

## Cloudflare Access (Future)

For Zero Trust protection on `admin.{YOUR_DOMAIN}`:

- **Team Name:** `josealvarez`
- **Auth Method:** PIN to email
- **Allowed Email:** `{YOUR_EMAIL}`

---

## Related API URLs

| Service | URL | Auth |
|---------|-----|------|
| cv-admin-worker | https://cv-admin-worker.{YOUR_WORKERS_SUBDOMAIN} | Cloudflare Access |
| cv-admin-portal | http://localhost:5173 (dev) | — |
| D1CV | https://api.d1.worker.{YOUR_DOMAIN} | Public read |
| cv-ai-agent | https://cv-ai-agent.{YOUR_WORKERS_SUBDOMAIN} | Public |

---

## Set Secrets Commands

```powershell
cd D:\Code\cv-admin-worker-private

# Set secrets via Wrangler
wrangler secret put D1CV_API_URL
# Enter: https://api.d1.worker.{YOUR_DOMAIN}

wrangler secret put AI_AGENT_API_URL
# Enter: https://cv-ai-agent.{YOUR_WORKERS_SUBDOMAIN}

wrangler secret put ALLOWED_EMAILS
# Enter: {YOUR_EMAIL}

# NEW: Webhook secret for HMAC signature verification
wrangler secret put WEBHOOK_SECRET
# Enter: (generate with command below)
```

### Generate Webhook Secret

```powershell
# Generate secure 32-byte base64 secret
[System.Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

### cv-ai-agent Webhook Secret

The AI Agent needs the same secret to sign webhook callbacks:

```powershell
cd D:\Code\cv-ai-agent-private

wrangler secret put ADMIN_WEBHOOK_SECRET
# Enter: (same value as WEBHOOK_SECRET above)
```

---

## Webhook Flow

```
cv-admin-worker                    cv-ai-agent
     │                                  │
     │  POST /api/admin/apply           │
     │  {job_id, operations,            │
     │   callback_url}                  │
     ├─────────────────────────────────►│
     │                                  │
     │                          Process operations
     │                          (D1 + Vectorize)
     │                                  │
     │  POST /v2/webhook                │
     │  X-Webhook-Signature: <hmac>     │
     │  {jobId, source, status}         │
     │◄─────────────────────────────────┤
     │                                  │
  Verify HMAC                           │
  Update job status                     │
  Notify WebSocket                      │
```

---

**Last Updated:** 2025-11-29
