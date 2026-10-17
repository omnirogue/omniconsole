import { z } from 'zod'
import { workflowLaunchChoiceFields } from './workflow-agent-launch'
import type { WorkflowPlacement } from './local-workflow-placement'
import type { EvolveHostedProgress } from './evolve-hosted-progress'

/**
 * Evolve: jev-lab's OpenEvolve CLI run on a fleet host (docs/reference/evolve-workflow.md).
 * This computer keeps the record; the host submits the spec to the central ledger, runs one
 * detached worker and answers `status --json` until the ledger run is done or failed.
 */
export const EVOLVE_RPC = {
  start: 'evolve.start',
  show: 'evolve.show',
  list: 'evolve.list',
  stop: 'evolve.stop',
  refresh: 'evolve.refresh'
} as const

export const EVOLVE_RUN_ID_PREFIX = 'evo_'
export const EVOLVE_RUN_ID_PATTERN = /^evo_[0-9a-f-]{36}$/
/** A checkout only Evolve workers use, so submit and worker always run the same evaluator code. */
export const EVOLVE_DEFAULT_CHECKOUT = '~/Repos/jev-lab-evolve'
export const EVOLVE_MAX_ITERATIONS = 500
export const EVOLVE_MAX_USD_CAP = 1_000

export const EVOLVE_TARGETS = {
  'email-smoke': 'jevlab/evolve/email/smoke.yaml',
  email: 'jevlab/evolve/email/evolve.yaml',
  ads: 'jevlab/evolve/ads/evolve.yaml'
} as const
export type EvolveTarget = keyof typeof EVOLVE_TARGETS | 'spec'
export const EVOLVE_TARGET_IDS = ['email-smoke', 'email', 'ads', 'spec'] as const

export const EVOLVE_EXECUTION_TIERS = ['local', 'hosted_pro', 'hosted_super_intelligence'] as const
export type EvolveExecutionTier = (typeof EVOLVE_EXECUTION_TIERS)[number]
export const HOSTED_EVOLVE_TIERS = ['hosted_pro', 'hosted_super_intelligence'] as const
export type HostedEvolveExecutionTier = (typeof HOSTED_EVOLVE_TIERS)[number]

/** A spec path inside the checkout: relative, no `..`, YAML. Quoted for the shell regardless. */
const SPEC_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+\.ya?ml$/
/** `~/…` or an absolute path; no quotes, `$`, backticks, backslashes or newlines. */
const CHECKOUT_PATH = /^(?:~\/|\/)[^\0\n\r'"`$\\]*$/

export const evolveStartRequestSchema = z
  .object({
    target: z.enum(EVOLVE_TARGET_IDS),
    /** With target `spec`: a spec path relative to the checkout on the host. */
    specPath: z.string().trim().max(512).regex(SPEC_PATH, 'a relative .yaml path').optional(),
    checkout: z.string().trim().min(2).max(512).regex(CHECKOUT_PATH).optional(),
    iterations: z.number().int().min(1).max(EVOLVE_MAX_ITERATIONS).optional(),
    /** `--patience`: stop after N consecutive mutations without improving best_score. */
    patience: z.number().int().min(1).max(EVOLVE_MAX_ITERATIONS).optional(),
    /** `--seed-from`: the target whose earlier archive and promoted candidates seed this run. */
    seedFrom: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._-]{1,128}$/)
      .optional(),
    /** `--rubric-from`: an exact earlier rubric by its sha256. */
    rubricFrom: z
      .string()
      .trim()
      .regex(/^[0-9a-f]{64}$/, 'a sha256')
      .optional(),
    /** `--usd-cap`: lowers this run's cap; jev-lab refuses one above the spec's group cap. */
    usdCap: z.number().positive().max(EVOLVE_MAX_USD_CAP).optional(),
    submittedBy: z.string().trim().min(1).max(200).optional(),
    runsOn: z.enum(['fleet', 'local', 'hosted']).optional(),
    executionTier: z.enum(EVOLVE_EXECUTION_TIERS).optional(),
    estimatedCredits: z.number().int().nonnegative().optional(),
    seedFromRunId: z.string().trim().min(1).max(128).optional(),
    worktreeId: z.string().trim().min(1).max(2_048).optional(),
    /** The workflow tab that shows this run, when a window started it. */
    conversationId: z.string().trim().min(1).max(512).optional(),
    ...workflowLaunchChoiceFields
  })
  .strict()
  .refine((value) => (value.target === 'spec') === !!value.specPath, {
    message: 'Give a spec path exactly when the target is a spec path.',
    path: ['specPath']
  })

export type EvolveStartRequest = z.infer<typeof evolveStartRequestSchema>

/** The spec the host submits: a built-in target's or the given path. */
export function evolveSpecPath(request: Pick<EvolveStartRequest, 'target' | 'specPath'>): string {
  return request.target === 'spec' ? request.specPath! : EVOLVE_TARGETS[request.target]
}

const numberOrNull = z.number().nullable().optional()

/** What `jevlab evolve status RUN_ID --json` prints; unknown keys are dropped, never stored. */
export const evolveLedgerStatusSchema = z.object({
  run_id: z.string(),
  found: z.literal(true),
  target: z.string(),
  status: z.enum(['queued', 'running', 'done', 'failed']),
  execution_host: z.string().nullable().optional(),
  submitted_by: z.string().nullable().optional(),
  spec_sha: z.string(),
  failure_class: z.string().nullable().optional(),
  budget: z
    .object({
      group: z.string().nullable().optional(),
      run_cap_usd: numberOrNull,
      group_cap_usd: numberOrNull,
      spend_usd: numberOrNull,
      reserved_usd: numberOrNull
    })
    .optional(),
  times: z
    .object({
      created_at: z.string().nullable().optional(),
      started_at: z.string().nullable().optional(),
      heartbeat_at: z.string().nullable().optional(),
      finished_at: z.string().nullable().optional(),
      heartbeat_age_s: numberOrNull
    })
    .optional(),
  iterations: z
    .object({ requested: numberOrNull, evaluated_mutations: z.number().optional() })
    .optional(),
  candidates: z
    .object({
      total: z.number(),
      by_role: z.record(z.string(), z.number()),
      by_status: z.record(z.string(), z.number())
    })
    .optional(),
  best_so_far: z
    .object({ candidate_id: z.string(), program_sha: z.string(), combined_score: numberOrNull })
    .nullable()
    .optional(),
  summary: z
    .object({
      best_candidate_id: z.string().optional(),
      best_combined_score: numberOrNull,
      stop_reason: z.string().optional(),
      evaluated_mutations: z.number().optional(),
      stale_mutations: z.number().optional(),
      patience: numberOrNull,
      requested_iterations: z.number().optional(),
      wall_s: numberOrNull,
      outcome_verdict: z.string().optional()
    })
    .optional(),
  seed_from: z.string().nullable().optional(),
  rubric_from: z.string().nullable().optional(),
  rubrics: z
    .array(
      z.object({
        stage: z.string().nullable(),
        type: z.string().nullable(),
        rubric_sha: z.string()
      })
    )
    .optional(),
  seeded: z
    .array(
      z.object({
        candidate_id: z.string(),
        source_run_id: z.string().nullable(),
        source_candidate_id: z.string().nullable(),
        program_sha: z.string(),
        prior_combined_score: numberOrNull,
        prior_promoted: z.boolean(),
        status: z.string(),
        combined_score: numberOrNull
      })
    )
    .optional(),
  promotions: z
    .array(
      z.object({
        candidate_id: z.string(),
        decision: z.string(),
        created_at: z.string().nullable().optional(),
        hard_pass: z.boolean().nullable().optional(),
        intervals_pass: z.boolean().nullable().optional(),
        availability: numberOrNull
      })
    )
    .optional()
})

export type EvolveLedgerStatus = z.infer<typeof evolveLedgerStatusSchema>

/**
 * starting: placed, submitting and launching; running: the ledger run is queued or running;
 * unverifiable: contact with the host was lost too long to keep following (the run may go on).
 */
export type EvolveRunState = 'starting' | 'running' | 'done' | 'failed' | 'stopped' | 'unverifiable'

/** The worker process as its host last reported it (docs/reference/ssh-execution-boundary.md). */
export type EvolveWorkerVerdict = 'live' | 'unverifiable' | 'exited'

export type EvolvePromotionSummary = {
  decision: 'promoted' | 'held' | 'rolled_back'
  candidateId?: string | null
  scoreDelta?: number | null
  auditSummary?: string | null
  promotedAt?: string | null
}

export type EvolveWinnerArtifact = {
  candidateId: string
  programSha: string
  combinedScore?: number | null
  artifactRef?: string | null
  family?: string | null
}

export type EvolveRunRecord = {
  id: string
  createdAt: string
  updatedAt: string
  state: EvolveRunState
  worktreeId?: string
  conversationId?: string
  /** The Start as admitted, who asked and their words included; frozen. */
  request: EvolveStartRequest
  spec: string
  checkout: string
  submittedBy: string
  placement: WorkflowPlacement
  /** The host's name, or "this computer". */
  host: string
  executionTier?: EvolveExecutionTier
  estimatedCredits?: number
  cloudRunId?: string
  promotionSummary?: EvolvePromotionSummary
  winnerArtifact?: EvolveWinnerArtifact
  /** Hosted runs: live candidate and knockout progress from the cloud's event stream. */
  hostedProgress?: EvolveHostedProgress
  ledgerRunId?: string
  submitted?: {
    specSha: string
    target: string
    iterations: number
    usdCap: number
    seedFrom?: string | null
    rubricFrom?: string | null
  }
  worker?: { pid: number; directory: string; startedAt: string }
  ledger?: EvolveLedgerStatus
  ledgerReadAt?: string
  contact?: { verdict: EvolveWorkerVerdict; at: string; detail?: string }
  stopRequestedAt?: string
  error?: string
  events: { at: string; text: string }[]
}

export type EvolveWorkflowRunRecord = EvolveRunRecord

export function isEvolveRunActive(state: EvolveRunState): boolean {
  return state === 'starting' || state === 'running'
}

/** Runs in Omnisi Cloud: no worker process or shell of ours to reach. */
export function isHostedEvolveRun(record: {
  cloudRunId?: string
  request?: Pick<EvolveStartRequest, 'runsOn'>
}): boolean {
  return Boolean(record.cloudRunId) || record.request?.runsOn === 'hosted'
}

/** The exact command that reads this run from the host's checkout. */
export function evolveStatusCommand(
  record: Pick<EvolveRunRecord, 'checkout' | 'ledgerRunId'> & {
    cloudRunId?: string
    request?: Pick<EvolveStartRequest, 'runsOn'>
  }
) {
  if (isHostedEvolveRun(record)) {
    return undefined
  }
  return record.ledgerRunId
    ? `cd ${record.checkout} && .venv/bin/python -m jevlab evolve status ${record.ledgerRunId} --json`
    : undefined
}
