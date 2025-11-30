import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types';

export interface DOJobStatus {
    jobId: string;
    commitId: string;
    target: 'both' | 'd1cv' | 'ai-agent';
    overallStatus: 'pending' | 'in-progress' | 'd1cv-done' | 'ai-done' | 'completed' | 'failed';
    d1cvStatus: 'pending' | 'in-progress' | 'success' | 'failed' | 'skipped';
    aiAgentStatus: 'pending' | 'in-progress' | 'success' | 'failed' | 'skipped';
    d1cvResult?: { success: boolean; message?: string; error?: string };
    aiAgentResult?: { success: boolean; message?: string; error?: string };
    startedAt: string;
    updatedAt: string;
    completedAt?: string;
}

export interface WebSocketMessage {
    type: 'status' | 'progress' | 'complete' | 'error' | 'ping';
    jobId?: string;
    data?: DOJobStatus | string;
    timestamp: string;
}

export interface WebhookPayload {
    jobId: string;
    source: 'd1cv' | 'ai-agent';
    status: 'success' | 'failed';
    message?: string;
    error?: string;
    details?: Record<string, unknown>;
}

/**
 * JobOrchestrator Durable Object
 * 
 * Manages push jobs and provides real-time updates via WebSocket.
 * Receives webhook callbacks from D1CV and AI Agent workers.
 */
export class JobOrchestrator extends DurableObject<Env> {
    private sessions: Map<WebSocket, { userId?: string; subscribedJobs: Set<string> }>;
    private jobs: Map<string, DOJobStatus>;

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        this.sessions = new Map();
        this.jobs = new Map();

        // Restore jobs from storage on wake
        this.ctx.blockConcurrencyWhile(async () => {
            const storedJobs = await this.ctx.storage.get<Map<string, DOJobStatus>>('jobs');
            if (storedJobs) {
                this.jobs = storedJobs;
            }
        });
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        // WebSocket upgrade for Admin UI connections
        if (request.headers.get('Upgrade') === 'websocket') {
            return this.handleWebSocketUpgrade(request);
        }

        // HTTP endpoints for webhooks and job management
        if (url.pathname === '/webhook' && request.method === 'POST') {
            return this.handleWebhook(request);
        }

        if (url.pathname === '/job/create' && request.method === 'POST') {
            return this.handleCreateJob(request);
        }

        if (url.pathname === '/job/status' && request.method === 'GET') {
            const jobId = url.searchParams.get('jobId');
            if (!jobId) {
                return new Response(JSON.stringify({ error: 'jobId required' }), { status: 400 });
            }
            const job = this.jobs.get(jobId);
            return new Response(JSON.stringify(job || { error: 'Job not found' }), {
                status: job ? 200 : 404,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        if (url.pathname === '/job/update-target-status' && request.method === 'POST') {
            return this.handleUpdateTargetStatus(request);
        }

        return new Response('Not Found', { status: 404 });
    }

    private handleWebSocketUpgrade(request: Request): Response {
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);

        this.ctx.acceptWebSocket(server);

        const userId = new URL(request.url).searchParams.get('userId') || undefined;
        this.sessions.set(server, { userId, subscribedJobs: new Set() });

        // Send initial connection confirmation
        server.send(JSON.stringify({
            type: 'connected',
            timestamp: new Date().toISOString(),
            message: 'Connected to JobOrchestrator'
        }));

        return new Response(null, { status: 101, webSocket: client });
    }

    webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
        try {
            const data = JSON.parse(message as string);
            const session = this.sessions.get(ws);

            if (!session) return;

            switch (data.type) {
                case 'subscribe':
                    // Subscribe to job updates
                    if (data.jobId) {
                        session.subscribedJobs.add(data.jobId);
                        const job = this.jobs.get(data.jobId);
                        if (job) {
                            ws.send(JSON.stringify({
                                type: 'status',
                                jobId: data.jobId,
                                data: job,
                                timestamp: new Date().toISOString()
                            }));
                        }
                    }
                    break;

                case 'unsubscribe':
                    if (data.jobId) {
                        session.subscribedJobs.delete(data.jobId);
                    }
                    break;

                case 'ping':
                    ws.send(JSON.stringify({
                        type: 'pong',
                        timestamp: new Date().toISOString()
                    }));
                    break;

                case 'list-active':
                    // List all active jobs for this user
                    const activeJobs = Array.from(this.jobs.values())
                        .filter(j => j.overallStatus !== 'completed' && j.overallStatus !== 'failed');
                    ws.send(JSON.stringify({
                        type: 'active-jobs',
                        data: activeJobs,
                        timestamp: new Date().toISOString()
                    }));
                    break;
            }
        } catch (error) {
            console.error('WebSocket message error:', error);
        }
    }

    webSocketClose(ws: WebSocket): void {
        this.sessions.delete(ws);
    }

    webSocketError(ws: WebSocket, error: unknown): void {
        console.error('WebSocket error:', error);
        this.sessions.delete(ws);
    }

    private async handleCreateJob(request: Request): Promise<Response> {
        try {
            const { jobId, commitId, target } = await request.json() as {
                jobId: string;
                commitId: string;
                target: 'both' | 'd1cv' | 'ai-agent';
            };

            const now = new Date().toISOString();
            const job: DOJobStatus = {
                jobId,
                commitId,
                target,
                overallStatus: 'pending',
                d1cvStatus: target === 'ai-agent' ? 'skipped' : 'pending',
                aiAgentStatus: target === 'd1cv' ? 'skipped' : 'pending',
                startedAt: now,
                updatedAt: now
            };

            this.jobs.set(jobId, job);
            await this.persistJobs();

            this.broadcastJobUpdate(job);

            return new Response(JSON.stringify({ success: true, job }), {
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (error) {
            return new Response(JSON.stringify({ error: String(error) }), { status: 500 });
        }
    }

    private async handleUpdateTargetStatus(request: Request): Promise<Response> {
        try {
            const { jobId, target, status } = await request.json() as {
                jobId: string;
                target: 'd1cv' | 'ai-agent';
                status: 'in-progress' | 'success' | 'failed';
            };

            const job = this.jobs.get(jobId);
            if (!job) {
                return new Response(JSON.stringify({ error: 'Job not found' }), { status: 404 });
            }

            if (target === 'd1cv') {
                job.d1cvStatus = status;
            } else {
                job.aiAgentStatus = status;
            }

            job.updatedAt = new Date().toISOString();

            // Update overall status
            this.updateOverallStatus(job);

            await this.persistJobs();
            this.broadcastJobUpdate(job);

            return new Response(JSON.stringify({ success: true, job }), {
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (error) {
            return new Response(JSON.stringify({ error: String(error) }), { status: 500 });
        }
    }

    private async handleWebhook(request: Request): Promise<Response> {
        try {
            const payload: WebhookPayload = await request.json();
            const { jobId, source, status, message, error, details } = payload;

            const job = this.jobs.get(jobId);
            if (!job) {
                return new Response(JSON.stringify({ error: 'Job not found' }), { status: 404 });
            }

            // Update the appropriate target status
            if (source === 'd1cv') {
                job.d1cvStatus = status;
                job.d1cvResult = { success: status === 'success', message, error };
            } else if (source === 'ai-agent') {
                job.aiAgentStatus = status;
                job.aiAgentResult = { success: status === 'success', message, error, ...details };
            }

            job.updatedAt = new Date().toISOString();

            // Update overall status based on both targets
            this.updateOverallStatus(job);

            await this.persistJobs();
            this.broadcastJobUpdate(job);

            return new Response(JSON.stringify({
                success: true,
                jobStatus: job.overallStatus,
                message: `Webhook processed for ${source}`
            }), {
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (error) {
            console.error('Webhook error:', error);
            return new Response(JSON.stringify({ error: String(error) }), { status: 500 });
        }
    }

    private updateOverallStatus(job: DOJobStatus): void {
        const d1Done = job.d1cvStatus === 'success' || job.d1cvStatus === 'skipped';
        const aiDone = job.aiAgentStatus === 'success' || job.aiAgentStatus === 'skipped';
        const d1Failed = job.d1cvStatus === 'failed';
        const aiFailed = job.aiAgentStatus === 'failed';

        if (d1Failed || aiFailed) {
            job.overallStatus = 'failed';
            job.completedAt = new Date().toISOString();
        } else if (d1Done && aiDone) {
            job.overallStatus = 'completed';
            job.completedAt = new Date().toISOString();
        } else if (d1Done && job.target === 'both') {
            job.overallStatus = 'd1cv-done';
        } else if (aiDone && job.target === 'both') {
            job.overallStatus = 'ai-done';
        } else if (job.d1cvStatus === 'in-progress' || job.aiAgentStatus === 'in-progress') {
            job.overallStatus = 'in-progress';
        }
    }

    private broadcastJobUpdate(job: DOJobStatus): void {
        const message: WebSocketMessage = {
            type: 'status',
            jobId: job.jobId,
            data: job,
            timestamp: new Date().toISOString()
        };

        const messageStr = JSON.stringify(message);

        for (const [ws, session] of this.sessions) {
            // Broadcast to all sessions that subscribed to this job OR all sessions if subscribed to 'all'
            if (session.subscribedJobs.has(job.jobId) || session.subscribedJobs.has('all')) {
                try {
                    ws.send(messageStr);
                } catch (error) {
                    console.error('Error sending to WebSocket:', error);
                    this.sessions.delete(ws);
                }
            }
        }
    }

    private async persistJobs(): Promise<void> {
        // Keep only last 100 jobs, remove old completed ones
        if (this.jobs.size > 100) {
            const sortedJobs = Array.from(this.jobs.entries())
                .sort((a, b) => new Date(b[1].updatedAt).getTime() - new Date(a[1].updatedAt).getTime());

            this.jobs = new Map(sortedJobs.slice(0, 100));
        }

        await this.ctx.storage.put('jobs', this.jobs);
    }

    // Alarm for cleanup of old jobs
    async alarm(): Promise<void> {
        const now = Date.now();
        const oneDayAgo = now - 24 * 60 * 60 * 1000;

        for (const [jobId, job] of this.jobs) {
            if (job.completedAt && new Date(job.completedAt).getTime() < oneDayAgo) {
                this.jobs.delete(jobId);
            }
        }

        await this.persistJobs();
    }
}
