# cv-admin-worker

Admin API for CV data management - Cloudflare Worker with D1 staging database.

## Architecture

This worker provides a staging layer between the Admin UI and target databases:

```
Admin UI → cv-admin-worker → D1 Staging DB
                           → D1CV Worker (portfolio)
                           → cv-ai-agent (AI chatbot)
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Health check |
| `POST` | `/stage` | Stage a CRUD operation |
| `GET` | `/staged` | List staged changes |
| `DELETE` | `/staged/:id` | Remove staged change |
| `DELETE` | `/staged` | Clear all staged (danger) |
| `GET` | `/similarity/:name` | Check for similar technologies |
| `POST` | `/apply/d1cv` | Apply D1CV changes |
| `POST` | `/apply/ai` | Apply AI changes + reindex |
| `GET` | `/entities/categories` | Get categories |
| `GET` | `/entities/technologies` | Get technologies |

## Setup

1. Create D1 database:
```bash
npm run db:create
```

2. Copy the database ID to `wrangler.toml`

3. Run migration:
```bash
npm run db:migrate        # Local
npm run db:migrate:remote # Production
```

4. Set secrets:
```bash
wrangler secret put D1CV_API_URL
wrangler secret put AI_AGENT_API_URL
wrangler secret put ALLOWED_EMAILS
```

5. Run locally:
```bash
npm run dev
```

6. Deploy:
```bash
npm run deploy
```

## Development

```bash
# Type check
npm run typecheck

# Run locally with D1
npm run dev
```

## Related Projects

- [cv-admin-portal](../cv-admin-portal) - React Admin UI
- [D1CV](../D1CV) - Portfolio API
- [cv-ai-agent](../cv-ai-agent) - AI Chatbot
