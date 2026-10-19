import { z } from 'zod'
import { evolveDraftSchema } from './evolve-workflow-draft'
import { localWorkflowLaunchSchema } from './local-workflow-launch'
import { normalizeWorkflowSpec } from './workflow-graph-normalize'
import { localWorkflowAuditDraftSchema } from './workflow-audit-draft'

const workflowSeatSchema = z.object({
  id: z.string(),
  agent: z.enum(['claude', 'codex', 'grok', 'gemini', 'openrouter', 'ollama']),
  accountId: z.string(),
  model: z.string().optional(),
  effort: z.string().optional()
})

const localWorkflowDraftSchema = z.object({
  prompt: z.string(),
  audit: localWorkflowAuditDraftSchema.extend({ sourceFile: z.string().max(32_768) }).optional(),
  // The spec is re-normalized and re-validated before use; older builds strip the field.
  graph: z
    .object({
      spec: z.unknown().transform((spec) => normalizeWorkflowSpec(spec)),
      team: z.array(workflowSeatSchema)
    })
    .optional(),
  capability: z.enum(['frozen-analysis', 'working-agent']).optional(),
  outputFileName: z.string().optional(),
  seats: z.array(workflowSeatSchema),
  synthesizerId: z.string(),
  scopeIds: z.array(z.string()),
  // auto and sources are editor choices; older builds saved workspace-read or frozen.
  access: z.enum(['auto', 'sources', 'workspace-read', 'frozen']).optional(),
  contextSources: z
    .array(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('path'), path: z.string() }),
        z.object({ kind: z.literal('github'), repo: z.string(), ref: z.string().optional() })
      ])
    )
    .optional(),
  includeWorkspace: z.boolean().optional(),
  // Absent on anchors saved before placement was a choice; the host reads that as fleet.
  runsOn: z.enum(['fleet', 'local']).optional(),
  runsOnHost: z.string().optional(),
  runsOnHostId: z.string().optional(),
  forceHost: z.string().optional(),
  requestedBy: z.string().optional(),
  requestedById: z.string().optional(),
  request: z.string().optional(),
  skipEarlierRuns: z.literal(true).optional(),
  focusFinding: z.string().optional(),
  budgetRootId: z.string().optional(),
  council: z.object({ memberIds: z.array(z.string()) }).optional(),
  concurrency: z.number(),
  callLimit: z.number(),
  attemptLimit: z.number(),
  maxHostAttempts: z.number(),
  discover: z.object({
    dimensions: z.array(z.string()),
    lenses: z.array(z.string()),
    minimumSeverity: z.enum(['low', 'medium', 'high', 'critical']),
    maxCandidates: z.number(),
    finderIds: z.array(z.string()).optional(),
    lensIds: z
      .array(
        z.enum([
          'correctness',
          'reliability',
          'security',
          'performance',
          'user-path',
          'data-integrity'
        ])
      )
      .optional(),
    depth: z.enum(['quick', 'thorough', 'exhaustive']).optional(),
    focus: z.array(z.string()).optional(),
    maxAgents: z.number().optional()
  })
})

const buildReviewAgentChoiceSchema = z.object({
  agent: z.string(),
  model: z.string().optional(),
  effort: z.string().optional()
})

const buildReviewDraftSchema = z.object({
  worktree: z.string(),
  objective: z.string(),
  reviewFocus: z.string(),
  hubTaskId: z.string(),
  builder: buildReviewAgentChoiceSchema,
  reviewers: z.array(
    z.object({
      id: z.number(),
      choice: buildReviewAgentChoiceSchema,
      chosen: z.boolean().optional()
    })
  ),
  maxReviewRounds: z.number(),
  /** Absent on drafts saved before placement was a choice; the form then shows the default. */
  runsOn: z.enum(['fleet', 'local']).optional(),
  runsOnHost: z.string().optional(),
  runsOnHostId: z.string().optional()
})

export const localWorkflowAnchorSchema = z.object({
  preset: z.enum(['council', 'discover', 'build-review', 'evolve']),
  prompt: z.string(),
  launch: localWorkflowLaunchSchema.optional(),
  buildReviewDraft: buildReviewDraftSchema.optional(),
  buildReviewPipelineId: z.string().optional(),
  evolveDraft: evolveDraftSchema.optional(),
  draft: localWorkflowDraftSchema.optional(),
  executionId: z.string().optional(),
  startRequest: z.object({ requestId: z.string(), draft: localWorkflowDraftSchema }).optional()
})
