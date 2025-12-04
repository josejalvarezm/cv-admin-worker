/**
 * Schema Validation Tests for cv-admin-worker
 * Tests Zod schemas used for API request validation
 */

import { describe, it, expect } from 'vitest';
import {
    OperationSchema,
    EntityTypeSchema,
    RecencySchema,
    ActionSchema,
    TargetSchema,
    StageChangeRequestSchema,
    CreateCommitRequestSchema,
    PushRequestSchema,
    D1CVTechnologyPayloadSchema,
    AIAgentTechnologyPayloadSchema,
    StageRequestSchema,
} from '../../src/schemas';

describe('Schema Validation', () => {
    describe('OperationSchema', () => {
        it('should accept valid operations', () => {
            expect(OperationSchema.safeParse('INSERT').success).toBe(true);
            expect(OperationSchema.safeParse('UPDATE').success).toBe(true);
            expect(OperationSchema.safeParse('DELETE').success).toBe(true);
        });

        it('should reject invalid operations', () => {
            expect(OperationSchema.safeParse('UPSERT').success).toBe(false);
            expect(OperationSchema.safeParse('').success).toBe(false);
            expect(OperationSchema.safeParse(null).success).toBe(false);
        });
    });

    describe('EntityTypeSchema', () => {
        it('should accept valid entity types', () => {
            expect(EntityTypeSchema.safeParse('technology').success).toBe(true);
            expect(EntityTypeSchema.safeParse('experience').success).toBe(true);
            expect(EntityTypeSchema.safeParse('education').success).toBe(true);
            expect(EntityTypeSchema.safeParse('project').success).toBe(true);
            expect(EntityTypeSchema.safeParse('profile').success).toBe(true);
            expect(EntityTypeSchema.safeParse('contact').success).toBe(true);
        });

        it('should reject invalid entity types', () => {
            expect(EntityTypeSchema.safeParse('skills').success).toBe(false);
            expect(EntityTypeSchema.safeParse('TECHNOLOGY').success).toBe(false);
        });
    });

    describe('RecencySchema', () => {
        it('should accept valid recency values', () => {
            expect(RecencySchema.safeParse('current').success).toBe(true);
            expect(RecencySchema.safeParse('recent').success).toBe(true);
            expect(RecencySchema.safeParse('legacy').success).toBe(true);
        });

        it('should reject invalid recency values', () => {
            expect(RecencySchema.safeParse('old').success).toBe(false);
            expect(RecencySchema.safeParse('new').success).toBe(false);
        });
    });

    describe('ActionSchema', () => {
        it('should accept valid actions', () => {
            expect(ActionSchema.safeParse('CREATE').success).toBe(true);
            expect(ActionSchema.safeParse('UPDATE').success).toBe(true);
            expect(ActionSchema.safeParse('DELETE').success).toBe(true);
        });
    });

    describe('TargetSchema', () => {
        it('should accept valid targets', () => {
            expect(TargetSchema.safeParse('d1cv').success).toBe(true);
            expect(TargetSchema.safeParse('ai-agent').success).toBe(true);
            expect(TargetSchema.safeParse('both').success).toBe(true);
        });

        it('should reject invalid targets', () => {
            expect(TargetSchema.safeParse('all').success).toBe(false);
            expect(TargetSchema.safeParse('').success).toBe(false);
        });
    });

    describe('StageChangeRequestSchema', () => {
        it('should accept valid stage change request', () => {
            const validRequest = {
                action: 'CREATE',
                target: 'both',
                entity_type: 'technology',
                payload: { name: 'TypeScript' },
                summary: 'Add TypeScript',
            };

            const result = StageChangeRequestSchema.safeParse(validRequest);
            expect(result.success).toBe(true);
        });

        it('should accept minimal stage change request', () => {
            const minimalRequest = {
                action: 'DELETE',
                target: 'd1cv',
                entity_type: 'technology',
                entity_id: '123',
            };

            const result = StageChangeRequestSchema.safeParse(minimalRequest);
            expect(result.success).toBe(true);
        });

        it('should reject summary over 200 characters', () => {
            const longSummary = {
                action: 'CREATE',
                target: 'both',
                entity_type: 'technology',
                summary: 'a'.repeat(201),
            };

            const result = StageChangeRequestSchema.safeParse(longSummary);
            expect(result.success).toBe(false);
        });
    });

    describe('CreateCommitRequestSchema', () => {
        it('should accept valid commit request', () => {
            const validRequest = {
                message: 'Add new technology',
                staged_ids: ['stage-1', 'stage-2'],
            };

            const result = CreateCommitRequestSchema.safeParse(validRequest);
            expect(result.success).toBe(true);
        });

        it('should reject empty message', () => {
            const emptyMessage = {
                message: '',
                staged_ids: ['stage-1'],
            };

            const result = CreateCommitRequestSchema.safeParse(emptyMessage);
            expect(result.success).toBe(false);
        });

        it('should reject message over 500 characters', () => {
            const longMessage = {
                message: 'a'.repeat(501),
                staged_ids: ['stage-1'],
            };

            const result = CreateCommitRequestSchema.safeParse(longMessage);
            expect(result.success).toBe(false);
        });

        it('should reject empty staged_ids array', () => {
            const noStaged = {
                message: 'Valid message',
                staged_ids: [],
            };

            const result = CreateCommitRequestSchema.safeParse(noStaged);
            expect(result.success).toBe(false);
        });
    });

    describe('PushRequestSchema', () => {
        it('should accept valid UUID', () => {
            const validRequest = {
                commit_id: '550e8400-e29b-41d4-a716-446655440000',
            };

            const result = PushRequestSchema.safeParse(validRequest);
            expect(result.success).toBe(true);
        });

        it('should reject invalid UUID', () => {
            const invalidRequest = {
                commit_id: 'not-a-uuid',
            };

            const result = PushRequestSchema.safeParse(invalidRequest);
            expect(result.success).toBe(false);
        });
    });

    describe('D1CVTechnologyPayloadSchema', () => {
        it('should accept valid technology payload', () => {
            const validPayload = {
                category_id: 1,
                name: 'TypeScript',
                experience: '5+ years of TypeScript development',
                experience_years: 5,
                proficiency_percent: 90,
                level: 'Expert',
                display_order: 1,
                is_active: true,
            };

            const result = D1CVTechnologyPayloadSchema.safeParse(validPayload);
            expect(result.success).toBe(true);
        });

        it('should accept payload without optional display_order', () => {
            const payloadWithoutOrder = {
                category_id: 1,
                name: 'TypeScript',
                experience: '5+ years',
                experience_years: 5,
                proficiency_percent: 90,
                level: 'Expert',
                is_active: true,
            };

            const result = D1CVTechnologyPayloadSchema.safeParse(payloadWithoutOrder);
            expect(result.success).toBe(true);
        });

        it('should reject proficiency over 100', () => {
            const invalidProficiency = {
                category_id: 1,
                name: 'TypeScript',
                experience: '5+ years',
                experience_years: 5,
                proficiency_percent: 150,
                level: 'Expert',
                is_active: true,
            };

            const result = D1CVTechnologyPayloadSchema.safeParse(invalidProficiency);
            expect(result.success).toBe(false);
        });

        it('should reject negative experience years', () => {
            const negativeYears = {
                category_id: 1,
                name: 'TypeScript',
                experience: '5+ years',
                experience_years: -1,
                proficiency_percent: 90,
                level: 'Expert',
                is_active: true,
            };

            const result = D1CVTechnologyPayloadSchema.safeParse(negativeYears);
            expect(result.success).toBe(false);
        });

        it('should reject experience years over 50', () => {
            const tooManyYears = {
                category_id: 1,
                name: 'TypeScript',
                experience: 'Long time',
                experience_years: 51,
                proficiency_percent: 90,
                level: 'Expert',
                is_active: true,
            };

            const result = D1CVTechnologyPayloadSchema.safeParse(tooManyYears);
            expect(result.success).toBe(false);
        });

        it('should reject empty name', () => {
            const emptyName = {
                category_id: 1,
                name: '',
                experience: '5+ years',
                experience_years: 5,
                proficiency_percent: 90,
                level: 'Expert',
                is_active: true,
            };

            const result = D1CVTechnologyPayloadSchema.safeParse(emptyName);
            expect(result.success).toBe(false);
        });

        it('should reject name over 100 characters', () => {
            const longName = {
                category_id: 1,
                name: 'a'.repeat(101),
                experience: '5+ years',
                experience_years: 5,
                proficiency_percent: 90,
                level: 'Expert',
                is_active: true,
            };

            const result = D1CVTechnologyPayloadSchema.safeParse(longName);
            expect(result.success).toBe(false);
        });
    });

    describe('AIAgentTechnologyPayloadSchema', () => {
        it('should require summary field', () => {
            const withoutSummary = {
                name: 'TypeScript',
                experience: '5+ years',
                experience_years: 5,
            };

            const result = AIAgentTechnologyPayloadSchema.safeParse(withoutSummary);
            expect(result.success).toBe(false);
        });

        it('should accept valid AI payload with summary', () => {
            const validPayload = {
                name: 'TypeScript',
                summary: 'TypeScript is a typed superset of JavaScript',
                recency: 'current',
            };

            const result = AIAgentTechnologyPayloadSchema.safeParse(validPayload);
            expect(result.success).toBe(true);
        });

        it('should accept full AI payload', () => {
            const fullPayload = {
                stable_id: 'tech-typescript',
                name: 'TypeScript',
                experience: '5+ years of TypeScript development',
                experience_years: 5,
                proficiency_percent: 90,
                level: 'Expert',
                category: 'Frontend Development',
                summary: 'TypeScript is a typed superset of JavaScript',
                recency: 'current',
                action: 'Building type-safe applications',
                effect: 'Reduced runtime errors',
                outcome: 'More maintainable codebase',
                related_project: 'CV Portfolio',
                employer: 'Self',
            };

            const result = AIAgentTechnologyPayloadSchema.safeParse(fullPayload);
            expect(result.success).toBe(true);
        });
    });

    describe('StageRequestSchema (Legacy)', () => {
        it('should require name for INSERT operation', () => {
            const insertWithoutName = {
                operation: 'INSERT',
                entity_type: 'technology',
                d1cv_payload: {
                    category_id: 1,
                    experience_years: 5,
                },
            };

            const result = StageRequestSchema.safeParse(insertWithoutName);
            expect(result.success).toBe(false);
        });

        it('should accept INSERT with name', () => {
            const validInsert = {
                operation: 'INSERT',
                entity_type: 'technology',
                d1cv_payload: {
                    name: 'TypeScript',
                },
            };

            const result = StageRequestSchema.safeParse(validInsert);
            expect(result.success).toBe(true);
        });

        it('should accept DELETE with entity_id', () => {
            const validDelete = {
                operation: 'DELETE',
                entity_type: 'technology',
                entity_id: 123,
                d1cv_payload: {},
            };

            const result = StageRequestSchema.safeParse(validDelete);
            expect(result.success).toBe(true);
        });

        it('should accept DELETE with entity_name', () => {
            const validDelete = {
                operation: 'DELETE',
                entity_type: 'technology',
                entity_name: 'TypeScript',
                d1cv_payload: {},
            };

            const result = StageRequestSchema.safeParse(validDelete);
            expect(result.success).toBe(true);
        });
    });
});
