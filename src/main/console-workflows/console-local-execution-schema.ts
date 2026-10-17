import { ompExecutionReceipt } from '../../shared/omp-execution-receipt'
import { openrouterCandidates, validOpenRouterRoute } from '../../shared/openrouter-route'
import { z } from 'zod'
import {
  consoleWorkflowJson,
  jobId,
  taskId,
  workflowId
} from '../../shared/console-workflow-schemas'
import type { ConsoleLocalJob, ConsoleLocalResult } from './console-local-execution-contract'

const text = z
  .string()
  .min(1)
  .max(64_000)
  .refine((value) => !value.includes('\0'))
const sha = z.string().regex(/^[a-f0-9]{40,64}$/)
export const consoleLocalStartRequest = z
  .object({
    jobId,
    workflowId,
    approvedDigest: z.string().regex(/^[a-f0-9]{64}$/),
    worktree: text.max(4096)
  })
  .strict()
export const consoleLocalJobSchema: z.ZodType<ConsoleLocalJob> = z
  .object({
    artifactResult: z
      .object({
        path: z.enum(['work-result.json', 'folder-snapshot.json', 'folder-review.json']),
        format: z.literal('json'),
        maxBytes: z.literal(65536)
      })
      .strict()
      .optional(),
    id: jobId,
    taskId,
    workflowId,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    state: text.max(64),
    placement: z.enum(['local', 'fleet']),
    provider: z.enum(['codex', 'claude', 'grok', 'omp']),
    model: text.max(512),
    openrouterCandidates: openrouterCandidates.optional(),
    effort: text.max(512).optional(),
    title: text.max(300),
    workspace: z
      .object({ kind: z.literal('folder'), path: text.max(4096) })
      .strict()
      .optional(),
    repo: text.max(2048).nullable(),
    baseSha: sha.nullable().optional(),
    baseBranch: text
      .max(1024)
      .refine((value) => !value.startsWith('-'))
      .nullable(),
    prompt: text,
    brief: text,
    acceptance: text,
    inputs: z.array(consoleWorkflowJson).max(100),
    ownedPaths: z.array(text.max(2048)).max(500).nullable(),
    readOnly: z.boolean(),
    action: z.enum(['execute', 'review', 'repair']).optional(),
    reviewProvider: z
      .enum(['github', 'gitlab', 'bitbucket', 'azure-devops', 'gitea', 'unsupported'])
      .optional(),
    acceptanceCommands: z
      .array(
        z
          .object({
            program: text.max(4096),
            args: z
              .array(
                z
                  .string()
                  .max(32_000)
                  .refine((value) => !value.includes('\0'))
              )
              .max(200),
            timeoutMs: z.number().int().min(1).max(3_600_000)
          })
          .strict()
      )
      .max(30),
    revision: z
      .object({
        confirmed: z.boolean(),
        branch: text.max(1024),
        reviewUrl: z.url().max(4096),
        reviewNumber: z.number().int().positive()
      })
      .strict()
      .optional()
  })
  .strict()
  .refine(
    (job) =>
      validOpenRouterRoute({
        agent: job.provider,
        model: job.model,
        openrouterCandidates: job.openrouterCandidates
      }),
    'The execution route must preserve the selected OMP model and candidates.'
  )
  .refine(
    (job) => !job.artifactResult || job.acceptanceCommands.length === 0,
    'An artifact result cannot replace or bypass executable acceptance commands.'
  )
  .refine(
    (job) =>
      job.workspace?.kind === 'folder'
        ? job.repo === null &&
          job.baseBranch === null &&
          job.baseSha === null &&
          !job.revision &&
          !job.reviewProvider &&
          job.acceptanceCommands.length === 0
        : job.repo !== null && job.baseBranch !== null && job.baseSha !== null,
    'The workspace must preserve its executable folder or Git contract.'
  )

export const consoleLocalAttemptSchema = z
  .object({
    job: consoleLocalJobSchema,
    attemptStartSha: sha.nullable(),
    worktreeId: text.max(4096),
    worktreePath: text.max(4096),
    branch: text.max(1024).nullable(),
    preparedInputPaths: z.array(text.max(4096)).max(100).optional()
  })
  .strict()
  .refine(
    (attempt) =>
      attempt.job.workspace?.kind === 'folder'
        ? attempt.attemptStartSha === null && attempt.branch === null
        : attempt.attemptStartSha !== null && attempt.branch !== null,
    'The attempt must preserve the workspace kind and its actual Git metadata.'
  )
export type ConsoleLocalAttempt = z.infer<typeof consoleLocalAttemptSchema>

export const consoleLocalResultSchema: z.ZodType<ConsoleLocalResult> = z
  .object({
    status: z.enum(['pr_open', 'failed', 'cancelled', 'done']),
    execution: ompExecutionReceipt.optional(),
    exit_code: z.number().int().nullable(),
    result_exit_code: z.number().int().optional(),
    output_tail: z.string().max(16_000),
    worker_report: z.string().max(32_000).optional(),
    review_text: z.string().max(32_000).optional(),
    file_id: z
      .string()
      .regex(/^tfl_[a-z0-9]{1,64}$/)
      .optional(),
    artifact_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    workflow_loop_verdict: z
      .object({
        verdict: z.enum(['agree', 'disagree']),
        blockers: z.array(text.max(256)).max(32),
        gaps: z.array(text.max(256)).max(32),
        notes: z.string().max(512)
      })
      .strict()
      .optional(),
    candidate_sha: sha.nullable(),
    branch: text.max(1024).nullable(),
    pr_url: z.url().nullable(),
    pr_number: z.number().int().positive().nullable(),
    changed_files: z.array(text.max(4096)),
    owned_paths_violations: z.array(text.max(4096)),
    terminal_proof: z.union([
      z.object({ kind: text.max(128), exit_code: z.number().int().nullable() }),
      z.object({
        kind: z.enum(['exited', 'not_started']),
        process_identity: z.object({
          pid: z.number().int().positive(),
          started_at: text.max(128),
          runner_instance: text.max(512)
        }),
        process_exited: z.literal(true),
        process_exit_code: z.number().int().nullable(),
        exit_cause: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('exited'), exit_code: z.number().int() }),
          z.object({ kind: z.literal('signaled'), signal: z.number().int().positive() }),
          z.object({ kind: z.literal('operator_close') })
        ]),
        observed_at: z.string().datetime({ offset: true }),
        launch_gate_closed: z.literal(true).optional()
      })
    ]),
    output_digest: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .refine(
    (result) => (result.file_id === undefined) === (result.artifact_sha256 === undefined),
    'A retained artifact requires both its file identity and exact content digest.'
  )
