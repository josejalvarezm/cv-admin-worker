import { z } from 'zod';

/**
 * Validation schemas for API requests
 */

export const OperationSchema = z.enum(['INSERT', 'UPDATE', 'DELETE']);

export const EntityTypeSchema = z.enum(['technology', 'experience', 'education', 'profile', 'contact']);

export const RecencySchema = z.enum(['current', 'recent', 'legacy']);

export const D1CVTechnologyPayloadSchema = z.object({
  category_id: z.number().int().positive(),
  name: z.string().min(1).max(100),
  experience: z.string().max(200),
  experience_years: z.number().int().min(0).max(50),
  proficiency_percent: z.number().int().min(0).max(100),
  level: z.string().min(1).max(50),
  display_order: z.number().int().min(0),
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
  d1cv_payload: D1CVTechnologyPayloadSchema,
  ai_payload: AIAgentTechnologyPayloadSchema.optional(),
});

export type ValidatedStageRequest = z.infer<typeof StageRequestSchema>;
