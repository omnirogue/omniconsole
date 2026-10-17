import { BOARD_TASK_ID_PATTERN } from '../../../../shared/board-task-id'
import { sessionFinishChoiceSchema } from '../../../../shared/session-finish-intent'
import { captureSessionHandoff } from '../../session-handoff-capture'
import { normalizeSessionFollowUpRule } from '../../../../shared/session-follow-up-rule'
import { assertSessionOutcomeRuntime } from '../../session-outcome-host-boundary'
import { sessionOutcomeSource } from '../../session-outcome-source-authority'
import {
  assertSessionOutcomeUser,
  sessionOutcomeMutationAuthority
} from '../../session-outcome-authority'
import type { SessionChain } from '../../../../shared/session-chain-types'
import {
  sessionOutcomeDefinitionSchema,
  sessionOutcomeTaskRefSchema
} from '../../../../shared/session-outcome-types'
import { nextOutcomeTeamPlanSchema } from '../../../../shared/next-outcome-team-plan-schema'
import { nextOutcomeReviewPlanSchema } from '../../../../shared/next-outcome-review-plan'
import { readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { SESSION_CHAIN_OUTPUT_ROOT } from '../../../../shared/session-chain-types'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'
import { SESSION_CHAIN_CAPABILITIES_METHOD } from './session-chain-capabilities'
import { SESSION_CHAIN_RUN_METHODS } from './session-chain-run-methods'
import { SESSION_HANDOFF_NOW_METHOD } from './session-handoff-now'
import { SESSION_CHAIN_WAIT_METHODS } from './session-chain-wait-methods'

const SessionChainId = z.object({ id: requiredString('Missing chain id') })

const SessionChainUpsert = z.object({ chain: z.unknown() })

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/

const SessionChainOutputFiles = z.object({
  workspacePath: requiredString('Missing workspace path'),
  chainId: requiredString('Missing chain id').pipe(z.string().regex(SAFE_ID, 'Invalid chain id')),
  stepId: requiredString('Missing step id').pipe(z.string().regex(SAFE_ID, 'Invalid step id'))
})

const MAX_OUTPUT_FILES = 500

/** Files a step produced, listed mechanically so the next step can be handed exact paths. */
export function listSessionChainOutputFiles(args: {
  workspacePath: string
  chainId: string
  stepId: string
}): { outputDir: string; files: string[]; truncated: boolean } {
  const workspaceRoot = resolve(args.workspacePath)
  const outputDir = resolve(
    workspaceRoot,
    ...SESSION_CHAIN_OUTPUT_ROOT.split('/'),
    args.chainId,
    args.stepId
  )
  // Why: the ids are validated, but the workspace path is caller-supplied; refuse
  // anything that resolved outside the workspace before touching the disk.
  const rel = relative(workspaceRoot, outputDir)
  if (rel.startsWith('..') || rel.split(sep).includes('..')) {
    throw new Error('Output folder resolved outside the workspace.')
  }
  const files: string[] = []
  let truncated = false
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries.sort()) {
      if (files.length >= MAX_OUTPUT_FILES) {
        truncated = true
        return
      }
      const full = join(dir, entry)
      let info
      try {
        info = statSync(full)
      } catch {
        continue
      }
      if (info.isDirectory()) {
        walk(full)
      } else if (info.isFile()) {
        files.push(full)
      }
    }
  }
  walk(outputDir)
  return { outputDir, files, truncated }
}

const ExecutionRuntimeId = z.string().min(1).optional()
const OutcomeId = SessionChainId.extend({ expectedExecutionRuntimeId: ExecutionRuntimeId })
const OutcomeCommit = z
  .object({
    chain: z.unknown(),
    taskRef: sessionOutcomeTaskRefSchema
      .extend({ taskId: z.string().regex(BOARD_TASK_ID_PATTERN) })
      .optional(),
    supersede: z
      .object({ reason: requiredString('Supersede reason required') })
      .strict()
      .optional(),
    /** What this plan still draws, so a supersede retires only the steps it dropped. */
    drawsSteps: z.array(requiredString('Missing step id')).max(512).optional(),
    planVersion: z.number().int().positive().optional(),
    sessionFinish: sessionFinishChoiceSchema.optional(),
    /**
     * Take the finish intent off this set. The schema is `.strict()`, so without the field the
     * withdrawal could only be made in process: the RPC and the CLI refused the one commit that
     * says "the person removed Done before it ran", and every caller outside the host had to
     * leave a queued finish standing.
     */
    clearSessionFinish: z.literal(true).optional(),
    expectedRevision: z.number().int().nonnegative(),
    outcomes: z.array(sessionOutcomeDefinitionSchema).min(1).max(64),
    reviewPlans: z.array(nextOutcomeReviewPlanSchema).min(1).max(32).optional(),
    removals: z
      .array(
        z
          .object({
            outcomeId: requiredString('Missing outcome id'),
            reason: requiredString('Scope change reason required')
          })
          .strict()
      )
      .optional(),
    expectedAttachedTask: z
      .object({
        taskId: requiredString('Missing attached task'),
        sessionId: requiredString('Missing attached session')
      })
      .strict()
      .optional(),
    expectedExecutionRuntimeId: ExecutionRuntimeId,
    expectedSourcePrompt: z.string().min(1).max(256_000).optional(),
    source: z.enum(['user', 'ai']),
    team: nextOutcomeTeamPlanSchema.optional()
  })
  .strict()
const OutcomeEvidence = z
  .object({
    id: requiredString('Missing chain id'),
    expectedRevision: z.number().int().positive(),
    outcomeId: requiredString('Missing outcome id'),
    conditionId: requiredString('Missing condition id'),
    expectedExecutionRuntimeId: ExecutionRuntimeId
  })
  .strict()

export const SESSION_CHAIN_METHODS: RpcMethod[] = [
  SESSION_HANDOFF_NOW_METHOD,
  defineMethod({
    name: 'sessionChain.attachOutcome',
    params: OutcomeId.extend({
      outcomeId: requiredString('Missing outcome id'),
      taskId: z.string().regex(BOARD_TASK_ID_PATTERN),
      expectedRevision: z.number().int().positive()
    }).strict(),
    handler: async (params, context) => {
      assertSessionOutcomeRuntime(context, params.expectedExecutionRuntimeId)
      assertSessionOutcomeUser(context)
      return {
        chain: await context.runtime
          .getSessionOutcomeService()
          .attach(params.id, params.outcomeId, params.taskId, params.expectedRevision)
      }
    }
  }),
  defineMethod({
    name: 'sessionChain.outcomeSource',
    params: z
      .object({ paneKey: requiredString('Missing source pane'), worktreeId: z.string().optional() })
      .strict(),
    handler: (params, context) => sessionOutcomeSource(context, params)
  }),
  SESSION_CHAIN_CAPABILITIES_METHOD,
  defineMethod({
    name: 'sessionChain.captureHandoff',
    params: z
      .object({
        paneKey: requiredString('Missing source pane'),
        worktreeId: requiredString('Missing workspace'),
        handoff: z.unknown(),
        summary: z.string().min(1).max(20_000),
        expectedExecutionRuntimeId: ExecutionRuntimeId
      })
      .strict(),
    handler: async (params, context) => {
      assertSessionOutcomeRuntime(context, params.expectedExecutionRuntimeId)
      assertSessionOutcomeUser(context)
      const source = context.runtime.resolveTerminalPane(params.paneKey, params.worktreeId)
      if (source.worktreeId !== params.worktreeId) {
        throw new Error('The source workspace changed.')
      }
      const workspace = await context.runtime.showManagedTerminalWorkspace(
        `id:${source.worktreeId}`
      )
      const handoff = normalizeSessionFollowUpRule(params.handoff)
      if (!handoff) {
        throw new Error('The handoff is incomplete.')
      }
      return { handoff: await captureSessionHandoff(handoff, workspace.path, params.summary) }
    }
  }),
  defineMethod({
    name: 'sessionChain.commitOutcomes',
    params: OutcomeCommit,
    handler: async (params, context) => {
      assertSessionOutcomeRuntime(context, params.expectedExecutionRuntimeId)
      const authority = sessionOutcomeMutationAuthority(
        context,
        params.chain as SessionChain,
        params.source
      )
      return {
        chain: await context.runtime
          .getSessionOutcomeService()
          .commit(
            params.chain,
            { ...params, source: authority.source },
            authority.instruction,
            () =>
              sessionOutcomeMutationAuthority(context, params.chain as SessionChain, params.source)
                .instruction
          )
      }
    }
  }),
  ...SESSION_CHAIN_RUN_METHODS,
  ...SESSION_CHAIN_WAIT_METHODS,
  defineMethod({
    name: 'sessionChain.verifyOutcome',
    params: OutcomeEvidence,
    handler: async (params, context) => {
      assertSessionOutcomeRuntime(context, params.expectedExecutionRuntimeId)
      return {
        chain: await context.runtime
          .getSessionOutcomeService()
          .verify(params.id, params.expectedRevision, params.outcomeId, params.conditionId)
      }
    }
  }),
  defineMethod({
    name: 'sessionChain.approveOutcomeReview',
    params: OutcomeEvidence.extend({ version: requiredString('Missing result version') }),
    handler: async (params, context) => {
      assertSessionOutcomeRuntime(context, params.expectedExecutionRuntimeId)
      assertSessionOutcomeUser(context)
      const { runtime } = context
      return {
        chain: await runtime
          .getSessionOutcomeService()
          .review(
            params.id,
            params.expectedRevision,
            params.outcomeId,
            params.conditionId,
            params.version
          )
      }
    }
  }),
  defineMethod({
    name: 'sessionChain.resumeOutcomes',
    params: z
      .object({
        id: requiredString('Missing chain id'),
        expectedRevision: z.number().int().positive(),
        expectedExecutionRuntimeId: ExecutionRuntimeId
      })
      .strict(),
    handler: async (params, context) => {
      assertSessionOutcomeRuntime(context, params.expectedExecutionRuntimeId)
      assertSessionOutcomeUser(context)
      return {
        chain: await context.runtime
          .getSessionOutcomeService()
          .resume(params.id, params.expectedRevision)
      }
    }
  }),
  defineMethod({
    name: 'sessionChain.list',
    params: null,
    handler: (_params, { runtime }) => ({ chains: runtime.listSessionChains() })
  }),
  defineMethod({
    name: 'sessionChain.upsert',
    params: SessionChainUpsert,
    handler: (params, { runtime }) => ({ chain: runtime.upsertSessionChain(params.chain) })
  }),
  defineMethod({
    name: 'sessionChain.remove',
    params: SessionChainId,
    handler: (params, { runtime }) => ({ removed: runtime.removeSessionChain(params.id) })
  }),
  defineMethod({
    name: 'sessionChain.outputFiles',
    params: SessionChainOutputFiles,
    handler: (params) => listSessionChainOutputFiles(params)
  })
]
