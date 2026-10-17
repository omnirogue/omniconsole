import { z } from 'zod'
import {
  DISCOVER_LENS_IDS,
  DISCOVER_MAX_AGENTS_CEILING
} from '../../../../shared/local-workflow-draft'
import {
  WORKFLOW_MAX_CALLS,
  WORKFLOW_ROUTES,
  type WorkflowSpec
} from '../../../../shared/workflow-graph'
import {
  WORKFLOW_CONTEXT_MAX_PATH_CHARS,
  WORKFLOW_CONTEXT_MAX_SOURCES,
  workflowGitHubRepoValid,
  workflowGitRefValid
} from '../../../../shared/workflow-context-sources'
import { workflowLaunchChoiceFields } from '../../../../shared/workflow-agent-launch'
import { localWorkflowAuditDraftSchema } from '../../../../shared/workflow-audit-draft'

const SeatId = z.string().min(1).max(128)
// Shape only: admission refuses a home folder, a credential location or a missing path.
const ContextSource = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('path'),
      path: z.string().min(1).max(WORKFLOW_CONTEXT_MAX_PATH_CHARS)
    })
    .strict(),
  z
    .object({
      kind: z.literal('github'),
      repo: z.string().refine(workflowGitHubRepoValid, 'Not a GitHub owner/name.'),
      ref: z.string().refine(workflowGitRefValid, 'Not a branch, tag or commit.').optional()
    })
    .strict()
])
const Seat = z
  .object({
    id: SeatId,
    agent: z.enum(['claude', 'codex', 'grok', 'gemini', 'openrouter', 'ollama']),
    accountId: z.string().min(1).max(256),
    model: z.string().min(1).max(512).optional(),
    effort: z.string().min(1).max(64).optional()
  })
  .strict()
// One seat per route the setup offers (local-workflow-host-setup.ts localWorkflowGraphTeam). Five
// refused every headless run on a computer with all six routes set up (15 Oct 2026).
export const LocalWorkflowGraphTeamSchema = z.array(Seat).min(1).max(WORKFLOW_ROUTES.length)
// Shape only: the host re-derives limits and applies each preset's role rules at admission.
export const LocalWorkflowStartDraftSchema = z
  .object({
    prompt: z.string().max(32_000),
    audit: localWorkflowAuditDraftSchema.optional(),
    capability: z.enum(['frozen-analysis', 'working-agent']).optional(),
    outputFileName: z.string().max(128).optional(),
    // A workflow graph names its team instead; every other draft needs its seats.
    seats: z.array(Seat).max(8),
    graph: z
      .object({
        // Re-normalized and validated by the host at admission (local-workflow-graph-admission.ts).
        spec: z.custom<WorkflowSpec>(
          (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
        ),
        team: LocalWorkflowGraphTeamSchema,
        maxAgents: z.number().int().min(1).max(WORKFLOW_MAX_CALLS).optional()
      })
      .strict()
      .optional(),
    synthesizerId: SeatId,
    scopeIds: z.array(z.string().min(1).max(1024)).max(64),
    access: z.enum(['workspace-read', 'frozen']).optional(),
    contextSources: z.array(ContextSource).max(WORKFLOW_CONTEXT_MAX_SOURCES).optional(),
    includeWorkspace: z.boolean().optional(),
    runsOn: z.enum(['fleet', 'local']).optional(),
    ...workflowLaunchChoiceFields,
    skipEarlierRuns: z.literal(true).optional(),
    focusFinding: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,128}:[1-9][0-9]{0,3}$/)
      .optional(),
    council: z
      .object({ memberIds: z.array(SeatId).max(8) })
      .strict()
      .optional(),
    concurrency: z.number().int().min(1).max(16),
    callLimit: z.number().int().min(1).max(DISCOVER_MAX_AGENTS_CEILING),
    attemptLimit: z.number().int().min(1).max(3),
    maxHostAttempts: z
      .number()
      .int()
      .min(1)
      .max(DISCOVER_MAX_AGENTS_CEILING * 3),
    discover: z
      .object({
        dimensions: z.array(z.string().min(1).max(200)).length(3),
        lenses: z.array(z.string().min(1).max(200)).length(2),
        minimumSeverity: z.enum(['low', 'medium', 'high', 'critical']),
        maxCandidates: z.number().int().min(1).max(12),
        finderIds: z.array(SeatId).max(8).optional(),
        lensIds: z.array(z.enum(DISCOVER_LENS_IDS)).max(DISCOVER_LENS_IDS.length).optional(),
        depth: z.enum(['quick', 'thorough', 'exhaustive']).optional(),
        focus: z.array(z.string().min(1).max(1024)).max(64).optional(),
        maxAgents: z.number().int().min(1).max(DISCOVER_MAX_AGENTS_CEILING).optional()
      })
      .strict()
  })
  .strict()
  .refine((draft) => !!draft.graph || draft.seats.length > 0, {
    message: 'Choose at least one workflow seat.',
    path: ['seats']
  })
