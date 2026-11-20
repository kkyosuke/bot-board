import { z } from "zod";

import {
  BOT_RECORD_RESULT_OUTCOMES,
  CARD_TYPES,
  ON_DECLINE_POLICIES,
  SELECTION_MODES,
  TASK_STATUSES,
} from "@/domain";

export const nonEmptyIdSchema = z.string().trim().min(1).max(128);
export const requestIdSchema = z.string().trim().min(1).max(128);
export const positiveVersionSchema = z.number().int().min(1);

export const decisionFactorSchema = z
  .object({
    label: z.string().trim().min(1).max(80),
    value: z.string().trim().min(1).max(200),
  })
  .strict();

export const decisionOptionSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    title: z.string().trim().min(1).max(120),
    badge: z.string().trim().min(1).max(40).optional(),
    summary: z.string().trim().min(1).max(300),
    meta: z.string().trim().min(1).max(120),
    recommended: z.boolean().optional(),
  })
  .strict();

export const artifactUpsertSchema = z
  .object({
    id: nonEmptyIdSchema.optional(),
    expected_version: positiveVersionSchema.optional(),
    title: z.string().trim().min(1).max(160),
    kind: z.string().trim().min(1).max(64),
    summary: z.string().trim().min(1).max(1000),
    content_or_url: z.string().trim().min(1).max(100_000),
  })
  .strict();

export const proposalItemInputSchema = z
  .object({
    card_type: z.enum(CARD_TYPES),
    selection_mode: z.enum(SELECTION_MODES).default("binary"),
    options: z.array(decisionOptionSchema).max(12).optional(),
    title: z.string().trim().min(1).max(160),
    summary: z.string().trim().min(1).max(1000),
    on_accept_effect: z.string().trim().min(1).max(300),
    on_decline_effect: z.string().trim().min(1).max(300),
    on_decline_policy: z.enum(ON_DECLINE_POLICIES).default("revise"),
    factors: z.array(decisionFactorSchema).max(8).default([]),
    target_artifact_id: nonEmptyIdSchema.optional(),
    expires_in_seconds: z.number().int().min(60).max(2_592_000).optional(),
  })
  .strict();

export const getWorkspaceContextInputSchema = z.object({}).strict();

export const listTasksInputSchema = z
  .object({
    status: z.enum(TASK_STATUSES).optional(),
    assigned_bot_id: nonEmptyIdSchema.optional(),
    parent_task_id: nonEmptyIdSchema.optional(),
    cursor: z.string().trim().min(1).max(256).optional(),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();

export const getTaskInputSchema = z
  .object({
    task_id: nonEmptyIdSchema,
  })
  .strict();

export const getArtifactInputSchema = z
  .object({
    artifact_id: nonEmptyIdSchema,
    expected_version: positiveVersionSchema.optional(),
  })
  .strict();

export const createTaskInputSchema = z
  .object({
    request_id: requestIdSchema,
    title: z.string().trim().min(1).max(200),
    description: z.string().max(4000).default(""),
    parent_task_id: nonEmptyIdSchema.optional(),
    requires_approval: z.boolean().default(true),
  })
  .strict();

export const claimTaskInputSchema = z
  .object({
    request_id: requestIdSchema,
    task_id: nonEmptyIdSchema,
    expected_version: positiveVersionSchema,
    lease_duration_seconds: z.number().int().min(15).max(3600).default(300),
  })
  .strict();

export const renewLeaseInputSchema = z
  .object({
    request_id: requestIdSchema,
    task_id: nonEmptyIdSchema,
    lease_token: nonEmptyIdSchema,
    lease_duration_seconds: z.number().int().min(15).max(3600).default(300),
  })
  .strict();

export const updateTaskInputSchema = z
  .object({
    request_id: requestIdSchema,
    task_id: nonEmptyIdSchema,
    expected_version: positiveVersionSchema,
    lease_token: nonEmptyIdSchema,
    description: z.string().max(4000).optional(),
    status: z.enum(["running", "blocked", "ready"]).optional(),
    status_reason: z.string().trim().max(500).nullable().optional(),
    artifact: artifactUpsertSchema.optional(),
  })
  .strict();

export const submitProposalInputSchema = z
  .object({
    request_id: requestIdSchema,
    task_id: nonEmptyIdSchema,
    expected_version: positiveVersionSchema,
    lease_token: nonEmptyIdSchema,
    selection_group_id: nonEmptyIdSchema.optional(),
    proposals: z.array(proposalItemInputSchema).min(1).max(10),
    artifact: artifactUpsertSchema.optional(),
  })
  .strict();

export const supersedeProposalInputSchema = z
  .object({
    request_id: requestIdSchema,
    task_id: nonEmptyIdSchema,
    expected_version: positiveVersionSchema,
    target_card_id: nonEmptyIdSchema,
    lease_token: nonEmptyIdSchema.optional(),
    replacement: proposalItemInputSchema,
    artifact: artifactUpsertSchema.optional(),
  })
  .strict();

export const listDecisionResultsInputSchema = z
  .object({
    task_id: nonEmptyIdSchema.optional(),
    only_unconsumed: z.boolean().default(false),
    cursor: z.string().trim().min(1).max(256).optional(),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();

export const recordResultInputSchema = z
  .object({
    request_id: requestIdSchema,
    task_id: nonEmptyIdSchema,
    expected_version: positiveVersionSchema,
    lease_token: nonEmptyIdSchema,
    outcome: z.enum(BOT_RECORD_RESULT_OUTCOMES),
    summary: z.string().trim().max(2000).optional(),
    status_reason: z.string().trim().max(500).optional(),
    decision_id: nonEmptyIdSchema.optional(),
    artifact: artifactUpsertSchema.optional(),
  })
  .strict();

export type ArtifactUpsertInput = z.infer<typeof artifactUpsertSchema>;
export type ProposalItemInput = z.infer<typeof proposalItemInputSchema>;
export type ListTasksInput = z.infer<typeof listTasksInputSchema>;
export type GetTaskInput = z.infer<typeof getTaskInputSchema>;
export type GetArtifactInput = z.infer<typeof getArtifactInputSchema>;
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;
export type ClaimTaskInput = z.infer<typeof claimTaskInputSchema>;
export type RenewLeaseInput = z.infer<typeof renewLeaseInputSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskInputSchema>;
export type SubmitProposalInput = z.infer<typeof submitProposalInputSchema>;
export type SupersedeProposalInput = z.infer<typeof supersedeProposalInputSchema>;
export type ListDecisionResultsInput = z.infer<typeof listDecisionResultsInputSchema>;
export type RecordResultInput = z.infer<typeof recordResultInputSchema>;
