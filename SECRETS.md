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
cd D:\Code\cv-admin-worker

# Set secrets via Wrangler
echo "https://api.d1.worker.{YOUR_DOMAIN}" | npx wrangler secret put D1CV_API_URL
echo "https://cv-ai-agent.{YOUR_WORKERS_SUBDOMAIN}" | npx wrangler secret put AI_AGENT_API_URL
echo "{YOUR_EMAIL}" | npx wrangler secret put ALLOWED_EMAILS
```

---

**Last Updated:** 2025-11-28
