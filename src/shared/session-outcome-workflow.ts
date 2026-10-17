import { sessionOutcomeFolderArtifact } from './session-outcome-folder-snapshot'
import { sessionOutcomeCurrentInput } from './session-outcome-current-inputs'
import { z } from 'zod'
import {
  workflowGraph,
  workflowObjective,
  workflowId,
  taskId,
  jobId
} from './console-workflow-schemas'

const text = z.string().min(1).max(32_000)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const sessionOutcomeWorkflowPreview = z
  .object({
    ok: z.literal(true),
    graph: workflowGraph,
    digest,
    workflow_id: workflowId,
    admission: z
      .object({
        filing_root_task_id: taskId,
        filing_root_expected_revision: z.number().int().nonnegative(),
        objective: workflowObjective,
        org_unit_id: text,
        expected_authority_epoch: z.number().int().nonnegative()
      })
      .strict()
  })
  .strict()
  .refine(
    (value) => value.digest === value.graph.digest && value.workflow_id === value.graph.dispatch_id
  )
export const sessionOutcomeStageReceipt = z
  .object({
    jobId,
    taskId,
    key: text,
    provider: text,
    model: text,
    verificationReportId: text,
    eventId: z.number().int().positive(),
    fingerprint: digest,
    attempt: z.number().int().positive(),
    leaseGeneration: z.number().int().positive(),
    dispatchId: text,
    runId: text,
    journalCursor: text,
    idempotencyKey: digest,
    inputDigest: digest.optional(),
    folderArtifact: sessionOutcomeFolderArtifact.optional(),
    candidateSha: z
      .string()
      .regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/)
      .nullable(),
    branch: text.nullable(),
    prUrl: text.nullable(),
    verdict: z
      .object({
        verdict: z.enum(['agree', 'disagree']),
        blockers: z.array(text),
        gaps: z.array(text),
        notes: z.string().max(512)
      })
      .strict()
      .optional()
  })
  .strict()
export type SessionOutcomeStageReceipt = z.infer<typeof sessionOutcomeStageReceipt>
const reviewedBinding = z
  .object({
    artifactId: text,
    artifactVersion: text,
    reviewerId: text,
    verdict: z.literal('accepted'),
    producerGitSha: text,
    repo: text,
    prNumber: z.number().int().positive(),
    headRef: text,
    baseRef: text,
    headSha: text
  })
  .strict()
export const sessionOutcomePublicationSchema = z
  .object({
    id: text,
    outcomeId: text,
    conditionId: text,
    state: z.enum(['prepared', 'requested', 'blocked', 'merged']),
    admission: z
      .object({
        provider: z.literal('github'),
        producerGitSha: text,
        acceptedReviews: z.array(reviewedBinding).min(1),
        review: z
          .object({
            repo: text,
            prNumber: z.number().int().positive(),
            url: text,
            state: z.enum(['open', 'closed', 'merged']),
            headRef: text,
            baseRef: text,
            headSha: text,
            mergeCommitSha: text.nullable()
          })
          .strict()
      })
      .strict(),
    mergeCommitSha: text.optional(),
    error: text.optional()
  })
  .strict()
export const sessionOutcomeCanonicalSeal = z
  .object({
    workflow_id: workflowId,
    revision_id: text,
    graph_digest: digest
  })
  .strict()
export type SessionOutcomeCanonicalSeal = z.infer<typeof sessionOutcomeCanonicalSeal>
export const sessionOutcomeWorkflowSchema = z
  .object({
    retired: z.boolean().optional(),
    currentInputs: z.array(sessionOutcomeCurrentInput).max(32).optional(),
    predecessorReceipts: z
      .array(
        z
          .object({
            mode: z.enum(['base', 'review-source']).optional(),
            stage_key: text,
            job_id: jobId,
            receipt_event_id: z.number().int().positive(),
            fingerprint: digest
          })
          .strict()
      )
      .optional(),
    operationId: text,
    definitionSha256: digest,
    preview: sessionOutcomeWorkflowPreview,
    canonicalSeal: sessionOutcomeCanonicalSeal.optional(),
    prerequisiteOutcomeIds: z.array(text).optional(),
    phase: z.enum(['prepared', 'admitting', 'admitted']),
    stages: z
      .array(
        z
          .object({
            key: text,
            outcomeIds: z.array(text),
            stepIds: z.array(text),
            actionIds: z.array(text),
            reviewGroupId: text.optional()
          })
          .strict()
      )
      .min(1),
    activations: z.array(
      z
        .object({
          jobId,
          state: z.enum(['requested', 'started', 'unverifiable']),
          launchDisposition: z.enum(['not-started', 'unverifiable']).optional(),
          dispatchId: text.optional(),
          runId: text.optional(),
          error: text.optional()
        })
        .strict()
    ),
    error: text.optional(),
    receipts: z.array(sessionOutcomeStageReceipt).optional(),
    verifiedProducerReceipts: z.array(sessionOutcomeStageReceipt).max(64).optional(),
    closedStages: z
      .array(
        z
          .object({
            key: text,
            reviewJobIds: z.array(jobId),
            producerJobId: jobId.optional(),
            round: z.number().int().positive().optional(),
            verificationReportId: text,
            evidenceId: text.optional()
          })
          .strict()
      )
      .optional()
  })
  .strict()
export type SessionOutcomeWorkflow = z.infer<typeof sessionOutcomeWorkflowSchema>
export type SessionOutcomeWorkflowPreview = z.infer<typeof sessionOutcomeWorkflowPreview>
