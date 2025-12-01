/**
 * Cloudflare Worker environment bindings
 */
export interface Env {
  // D1 Staging Database
  DB: D1Database;

  // D1CV Production Database (for applying changes)
  D1CV_DB: D1Database;

  // Durable Object for job orchestration
  JOB_ORCHESTRATOR: DurableObjectNamespace;

  // API URLs for target systems
  D1CV_API_URL: string;
  AI_AGENT_API_URL: string;

  // Auth
  ALLOWED_EMAILS: string;

  // Webhook secret for HMAC signing
  WEBHOOK_SECRET?: string;
}

/**
 * Staging operation types (legacy)
 */
export type Operation = 'INSERT' | 'UPDATE' | 'DELETE';

/**
 * Git-like action types
 */
export type Action = 'CREATE' | 'UPDATE' | 'DELETE';

/**
 * Target systems for staging
 */
export type Target = 'd1cv' | 'ai-agent' | 'both';

/**
 * Commit status (git-like workflow)
 */
export type CommitStatus =
  | 'pending'       // Created, not pushed yet
  | 'applied_d1cv'  // Pushed to D1CV, pending AI Agent
  | 'applied_ai'    // Pushed to AI Agent only
  | 'applied_all'   // Fully synced to both targets
  | 'failed';       // Push failed

/**
 * Job status for async operations
 */
export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'timeout';

/**
 * Staging status types (legacy)
 */
export type StagingStatus = 'pending' | 'applied' | 'failed' | 'skipped';

/**
 * Entity types that can be staged
 */
export type EntityType = 'technology' | 'experience' | 'education' | 'project' | 'profile' | 'contact';

/**
 * Staged change for D1CV database
 */
export interface StagedD1CV {
  id: number;
  operation: Operation;
  entity_type: EntityType;
  entity_id: number | null;
  payload: string; // JSON string
  status: StagingStatus;
  created_at: string;
  applied_at: string | null;
  error_message: string | null;
}

/**
 * Staged change for cv-ai-agent database
 */
export interface StagedAIAgent {
  id: number;
  operation: Operation;
  stable_id: string | null;
  payload: string; // JSON string
  status: StagingStatus;
  requires_reindex: boolean;
  created_at: string;
  applied_at: string | null;
  error_message: string | null;
  linked_d1cv_staged_id: number | null;
}

/**
 * D1CV Technology payload
 */
export interface D1CVTechnologyPayload {
  category_id: number;
  name: string;
  experience: string;
  experience_years: number;
  proficiency_percent: number;
  level: string;
  display_order: number;
  is_active: boolean;
}

/**
 * AI Agent Technology payload (enriched)
 */
export interface AIAgentTechnologyPayload {
  stable_id: string;
  name: string;
  experience: string;
  experience_years: number;
  proficiency_percent: number;
  level: string;
  category: string; // Denormalized category name
  summary: string;
  recency: 'current' | 'recent' | 'legacy';
  action: string;
  effect: string;
  outcome: string;
  related_project: string;
  employer: string;
}

/**
 * Stage request from Admin UI
 */
export interface StageRequest {
  operation: Operation;
  entity_type: EntityType;
  entity_id?: number | null;
  d1cv_payload: D1CVTechnologyPayload;
  ai_payload?: Partial<AIAgentTechnologyPayload>;
}

/**
 * Stage response
 */
export interface StageResponse {
  success: boolean;
  staged: {
    d1cv_id: number;
    ai_id: number | null;
    stable_id: string | null;
  };
  message: string;
}

/**
 * Similarity match from cv-ai-agent
 */
export interface SimilarityMatch {
  stable_id: string;
  name: string;
  score: number;
  category: string;
  summary: string;
}

/**
 * Apply result for a single staged change
 */
export interface ApplyResult {
  id: number;
  stable_id?: string;
  operation: Operation;
  status: 'applied' | 'failed';
  error?: string;
}

// ==========================================
// GIT-LIKE COMMIT & STAGING TYPES
// ==========================================

/**
 * Commit (groups staged changes)
 */
export interface Commit {
  id: string;
  message: string | null;
  status: CommitStatus;
  created_by: string;
  created_at: string;
  applied_d1cv_at: string | null;
  applied_ai_at: string | null;
  applied_by: string | null;
  error_target: 'd1cv' | 'ai-agent' | null;
  error_message: string | null;
}

/**
 * Commit with changes included
 */
export interface CommitWithChanges extends Commit {
  changes: StagedChange[];
}

/**
 * Staged change (individual operation)
 */
export interface StagedChange {
  id: string;
  commit_id: string | null;
  target: Target;
  entity_type: EntityType;
  action: Action;
  entity_id: string | null;
  stable_id: string | null;
  payload: string | null;  // JSON string
  summary: string | null;
  created_by: string;
  created_at: string;
}

/**
 * Job for async push operations
 */
export interface Job {
  id: string;
  commit_id: string;
  target: 'd1cv' | 'ai-agent';
  status: JobStatus;
  started_at: string;
  completed_at: string | null;
  result: string | null;  // JSON string
  error_message: string | null;
  callback_url: string | null;
}

/**
 * Stage request (new git-like)
 */
export interface StageChangeRequest {
  action: Action;
  target: Target;
  entity_type: EntityType;
  entity_id?: string | null;
  stable_id?: string | null;
  payload?: Record<string, unknown>;
  summary?: string;
}

/**
 * Commit request
 */
export interface CreateCommitRequest {
  message: string;
  staged_ids: string[];
}

/**
 * Push request
 */
export interface PushRequest {
  commit_id: string;
}

/**
 * Job result (webhook payload)
 */
export interface JobResult {
  job_id: string;
  status: 'completed' | 'failed';
  result?: {
    inserted: number;
    updated: number;
    deleted: number;
    d1_count?: number;
    vector_count?: number;
    synced?: boolean;
  };
  error?: string;
}

// ==========================================
// D1CV RESPONSE TYPES
// ==========================================

/**
 * D1CV technology within a category response
 */
export interface D1CVTechItem {
  name: string;
  experience: string;
  experienceYears: number;
  proficiencyPercent: number;
  level: string;
}

/**
 * D1CV technology category response
 */
export interface D1CVTechCategory {
  name: string;
  icon: string;
  technologies: D1CVTechItem[];
}

/**
 * D1CV technologies endpoint response
 */
export interface D1CVTechnologiesResponse {
  heroSkills: Array<D1CVTechItem & { icon: string }>;
  technologyCategories: D1CVTechCategory[];
}

/**
 * Admin portal technology format (flat structure)
 */
export interface AdminTechnology {
  id: number;
  name: string;
  experience: string;
  experience_years: number;
  proficiency_percent: number;
  level: string;
  category: string;
  category_id: number;
  is_active: boolean;
}
