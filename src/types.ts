/**
 * Cloudflare Worker environment bindings
 */
export interface Env {
  // D1 Staging Database
  DB: D1Database;
  
  // API URLs for target systems
  D1CV_API_URL: string;
  AI_AGENT_API_URL: string;
  
  // Auth
  ALLOWED_EMAILS: string;
}

/**
 * Staging operation types
 */
export type Operation = 'INSERT' | 'UPDATE' | 'DELETE';

/**
 * Staging status types
 */
export type StagingStatus = 'pending' | 'applied' | 'failed' | 'skipped';

/**
 * Entity types that can be staged
 */
export type EntityType = 'technology' | 'experience' | 'education' | 'profile' | 'contact';

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
