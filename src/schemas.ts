import { z } from 'zod';

/**
 * Validation schemas for API requests
 */

export const OperationSchema = z.enum(['INSERT', 'UPDATE', 'DELETE']);

export const EntityTypeSchema = z.enum(['technology', 'experience', 'education', 'project', 'profile', 'contact']);

export const RecencySchema = z.enum(['current', 'recent', 'legacy']);

// ==========================================
// GIT-LIKE STAGING SCHEMAS
// ==========================================

export const ActionSchema = z.enum(['CREATE', 'UPDATE', 'DELETE']);

export const TargetSchema = z.enum(['d1cv', 'ai-agent', 'both']);

/**
 * Stage a single change (uncommitted)
 */
export const StageChangeRequestSchema = z.object({
  action: ActionSchema,
  target: TargetSchema,
  entity_type: EntityTypeSchema,
  entity_id: z.string().nullable().optional(),
  stable_id: z.string().nullable().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  summary: z.string().max(200).optional(),
});

/**
 * Create a commit from staged changes
 */
export const CreateCommitRequestSchema = z.object({
  message: z.string().min(1).max(500),
  staged_ids: z.array(z.string()).min(1),
});

/**
 * Push a commit to target
 */
export const PushRequestSchema = z.object({
  commit_id: z.string().uuid(),
});

// ==========================================
// LEGACY SCHEMAS (for backward compatibility)
// ==========================================

export const D1CVTechnologyPayloadSchema = z.object({
  category_id: z.number().int().positive(),
  name: z.string().min(1).max(100),
  experience: z.string().max(200),
  experience_years: z.number().int().min(0).max(50),
  proficiency_percent: z.number().int().min(0).max(100),
  level: z.string().min(1).max(50),
  display_order: z.number().int().min(0).optional(), // Optional - auto-assigned for new items
  is_active: z.boolean(),
});

export const AIAgentTechnologyPayloadSchema = z.object({
  stable_id: z.string().optional(), // Generated if not provided
  name: z.string().min(1).max(100),
  experience: z.string().max(200),
  experience_years: z.number().int().min(0).max(50),
  proficiency_percent: z.number().int().min(0).max(100),
  level: z.string().min(1).max(50),
  category: z.string().min(1).max(100),
  summary: z.string().min(1).max(1000),
  recency: RecencySchema,
  action: z.string().max(500),
  effect: z.string().max(500),
  outcome: z.string().max(500),
  related_project: z.string().max(200),
  employer: z.string().max(200),
}).partial().refine(
  (data) => data.summary !== undefined,
  { message: 'summary is required for AI payload' }
);

export const StageRequestSchema = z.object({
  operation: OperationSchema,
  entity_type: EntityTypeSchema,
  entity_id: z.number().int().positive().nullable().optional(),
  entity_name: z.string().max(100).nullable().optional(), // For D1CV technologies identified by name
  d1cv_payload: D1CVTechnologyPayloadSchema.partial(), // Partial for DELETE operations (only need identifier)
  ai_payload: AIAgentTechnologyPayloadSchema.optional(),
}).refine(
  (data) => {
    // For INSERT/UPDATE, require name at minimum
    if (data.operation !== 'DELETE') {
      return data.d1cv_payload?.name !== undefined;
    }
    // For DELETE, just need entity_id or entity_name
    return data.entity_id !== undefined || data.entity_name !== undefined;
  },
  { message: 'INSERT/UPDATE requires d1cv_payload.name, DELETE requires entity_id or entity_name' }
);

export type ValidatedStageRequest = z.infer<typeof StageRequestSchema>;
export type ValidatedStageChangeRequest = z.infer<typeof StageChangeRequestSchema>;
export type ValidatedCreateCommitRequest = z.infer<typeof CreateCommitRequestSchema>;
export type ValidatedPushRequest = z.infer<typeof PushRequestSchema>;
