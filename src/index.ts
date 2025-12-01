import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import {
  technologies,
  staging,
  apply,
  entities,
  d1cv,
  aiAgent,
  commits,
  lookup,
} from './routes';

// Export Durable Object
export { JobOrchestrator } from './durable-objects/JobOrchestrator';

const app = new Hono<{ Bindings: Env }>();

// CORS middleware - credentials required for Zero Trust cookies
app.use(
  '*',
  cors({
    origin: ['https://admin.{YOUR_DOMAIN}', 'http://localhost:5173'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'CF-Access-JWT-Assertion'],
    credentials: true,
    maxAge: 86400,
  })
);

// Health check
app.get('/', (c) => {
  return c.json({
    status: 'ok',
    service: 'cv-admin-worker',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// ==========================================
// ROUTE MODULES
// ==========================================

app.route('/', technologies);
app.route('/', staging);
app.route('/', apply);
app.route('/', entities);
app.route('/', d1cv);
app.route('/', aiAgent);
app.route('/', commits);
app.route('/', lookup);

export default app;