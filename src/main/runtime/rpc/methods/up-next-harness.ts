/**
 * A host for the Up next tests: real persistence, real lowering, stubbed only where the
 * world is (the durable outcome write, the delivery door, the pane readiness reading).
 *
 * What stays REAL matters: the prompt queue and the draft store are the production classes,
 * so restart survival is a genuine round-trip, and every commit goes through the actual
 * `commitWorkPlan` lowering — the assertions are about what the engine really compiled.
 */

import { vi } from 'vitest'
import { PromptQueuePersistence } from '../../../persistence/loading-store/prompt-queue-persistence'
import { UpNextDraftPersistence } from '../../../persistence/loading-store/up-next-draft-persistence'
import type { PersistedState } from '../../../../shared/persisted-state-types'
import type { WriteSchedulingOperations } from '../../../persistence/loading-store/write-scheduling'
import { conversationSourceRowKey } from '../../../../shared/conversation-source'
import type { SessionChain } from '../../../../shared/session-chain-types'
import type { SessionFollowUpTranscriptSource } from '../../../../shared/session-follow-up-transcript'
import type {
  SessionOutcomeCommit,
  SessionOutcomeSet
} from '../../../../shared/session-outcome-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { UpNextView } from '../../../../shared/up-next-types'
import type { RpcContext, RpcMethod } from '../core'
import { resumeUpNextContinuations } from '../../up-next-continuation'
import { UP_NEXT_METHODS } from './up-next'

export const conversationId = { worktreeId: 'wt', paneKey: 'tab-1:leaf-1', kind: 'pty' as const }
export const rowKey = conversationSourceRowKey(conversationId)

/** What the finish intent is after one commit: carried, replaced, or explicitly cleared. */
function finishAfter(
  input: SessionOutcomeCommit,
  previous?: SessionChain
): SessionOutcomeSet['sessionFinish'] | null {
  return input.clearSessionFinish
    ? null
    : (input.sessionFinish ?? previous?.outcomeSet?.sessionFinish ?? null)
}

/** The outcome set a real commit would have written, so the projection has facts to read. */
function applied(base: SessionChain, input: SessionOutcomeCommit, previous?: SessionChain) {
  const finish = finishAfter(input, previous)
  const set: SessionOutcomeSet = {
    schemaVersion: 1,
    revision: (previous?.outcomeSet?.revision ?? 0) + 1,
    outcomes: input.outcomes.map((outcome) => ({
      ...outcome,
      revision: 1,
      status: 'pending' as const,
      evidence: []
    })),
    removals: [],
    attempts: previous?.outcomeSet?.attempts ?? [],
    // What the chain already finished survives a commit, as the real one preserves it.
    completedSteps: previous?.outcomeSet?.completedSteps ?? [],
    continuation: {
      owner: 'execution-host' as const,
      hostId: 'local',
      epoch: 'epoch-1',
      state: 'owned' as const,
      sourceReady: true
    },
    // The reviser carries a previous finish forward unless the commit clears it explicitly,
    // and the withdraw path depends on exactly that: modelled here so it is really tested.
    ...(finish ? { sessionFinish: finish } : {}),
    updatedAt: 20
  }
  return { ...base, outcomeSet: set, updatedAt: 21 }
}

export type UpNextHarness = ReturnType<typeof harness>

export function harness(
  over: Partial<RpcContext> = {},
  seed: {
    chains?: SessionChain[]
    state?: Partial<PersistedState>
    /** The agent this host can name for the conversation; `null` = it cannot. */
    agent?: TuiAgent | null
    /** Where people can read this conversation; `null` = this host cannot say. */
    transcriptSource?: SessionFollowUpTranscriptSource | null
  } = {}
) {
  const state = {
    promptQueues: {},
    upNextDrafts: {},
    ...seed.state
  } as unknown as PersistedState
  const prompts = new PromptQueuePersistence(
    { state, flushOrThrow: () => {}, writesFrozen: false },
    {} as WriteSchedulingOperations
  )
  let flushed = 0
  const drafts = new UpNextDraftPersistence(
    {
      state,
      flushOrThrow: () => {
        flushed += 1
      },
      writesFrozen: false
    },
    {} as WriteSchedulingOperations
  )
  const commits: SessionOutcomeCommit[] = []
  let chains = [...(seed.chains ?? [])]
  const service = {
    epoch: 'epoch-1',
    commit: vi.fn(async (raw: unknown, input: SessionOutcomeCommit) => {
      commits.push(input)
      const base = raw as SessionChain
      const previous = chains.find((chain) => chain.id === base.id)
      const next = applied(base, input, previous)
      chains = [...chains.filter((chain) => chain.id !== base.id), next]
      return next
    }),
    save: vi.fn((chain: SessionChain) => {
      chains = [...chains.filter((entry) => entry.id !== chain.id), chain]
      return chain
    })
  }
  const runtime: Record<string, unknown> = {
    hasSessionOutcomeContinuation: () => true,
    listUpNextDrafts: () => drafts.listUpNextDrafts(),
    listSessionChains: () => chains,
    readPromptQueue: (key: string) => prompts.readPromptQueue(key),
    enqueuePromptQueueEntry: (
      ...args: Parameters<PromptQueuePersistence['enqueuePromptQueueEntry']>
    ) => prompts.enqueuePromptQueueEntry(...args),
    removePromptQueueEntry: (
      ...args: Parameters<PromptQueuePersistence['removePromptQueueEntry']>
    ) => prompts.removePromptQueueEntry(...args),
    reorderPromptQueueEntry: (
      ...args: Parameters<PromptQueuePersistence['reorderPromptQueueEntry']>
    ) => prompts.reorderPromptQueueEntry(...args),
    requeuePromptQueueEntry: (
      ...args: Parameters<PromptQueuePersistence['requeuePromptQueueEntry']>
    ) => prompts.requeuePromptQueueEntry(...args),
    markPromptQueueEntrySendingAndFlush: (
      ...args: Parameters<PromptQueuePersistence['markPromptQueueEntrySendingAndFlush']>
    ) => prompts.markPromptQueueEntrySendingAndFlush(...args),
    settlePromptQueueEntry: (
      ...args: Parameters<PromptQueuePersistence['settlePromptQueueEntry']>
    ) => prompts.settlePromptQueueEntry(...args),
    readUpNextDrafts: (key: string) => drafts.readUpNextDrafts(key),
    replaceUpNextDrafts: (...args: Parameters<UpNextDraftPersistence['replaceUpNextDrafts']>) =>
      drafts.replaceUpNextDrafts(...args),
    replaceUpNextDraftsAndFlush: (
      ...args: Parameters<UpNextDraftPersistence['replaceUpNextDraftsAndFlush']>
    ) => drafts.replaceUpNextDraftsAndFlush(...args),
    // `agent: null` is a real host reading: a structured chat session whose agent this host
    // cannot name refuses an Agent block rather than guessing one.
    conversationAgent: () => (seed.agent === undefined ? ('claude' as const) : seed.agent),
    // Where the people a plan finishes at can read this conversation. Only the host can name
    // it, so a commit whose Person block asked for the transcript reaches for this — and a
    // harness without it threw `is not a function` instead of testing the rule.
    getSessionOutcomeTranscriptSource: () =>
      seed.transcriptSource === undefined
        ? {
            kind: 'provider' as const,
            hostId: 'local',
            agent: 'claude',
            sessionId: 'session-1'
          }
        : seed.transcriptSource,
    showManagedTerminalWorkspace: async () => ({ path: '/w' }),
    getSessionOutcomeService: () => service
  }
  const ctx = { clientId: 'desktop-renderer', runtime, ...over } as unknown as RpcContext
  const method = (name: string): RpcMethod => UP_NEXT_METHODS.find((entry) => entry.name === name)!
  return {
    ctx,
    state,
    commits,
    service,
    /** Durable draft writes this harness made: one per write that belongs to a commit. */
    flushed: (): number => flushed,
    chains: () => chains,
    queue: () => prompts.readPromptQueue(rowKey),
    drafts: () => drafts.readUpNextDrafts(rowKey),
    parse: (name: string, params: unknown): unknown => method(name).params!.parse(params),
    /** The stage finished, as the tick records it: its id enters `completedSteps`. */
    finishStage: (stepId: string): void => {
      chains = chains.map((chain) =>
        chain.outcomeSet
          ? {
              ...chain,
              outcomeSet: {
                ...chain.outcomeSet,
                completedSteps: [...(chain.outcomeSet.completedSteps ?? []), stepId]
              }
            }
          : chain
      )
    },
    /** One host pass over the continuations held behind a review. */
    resume: () => resumeUpNextContinuations(runtime as never),
    /**
     * A reviewer answers: the receipt on THEIR review condition, at the current revision,
     * which is the only thing the host counts as a reply. With a decision it is the hub's own
     * receipt shape, which is where "approve" and "needs changes" are told apart.
     */
    reply: (employeeId: string, decision?: 'approve' | 'request_changes'): void => {
      chains = chains.map((chain) => {
        const outcome = chain.outcomeSet?.outcomes[0]
        const condition = outcome?.conditions.find(
          (entry) => entry.kind === 'review' && entry.recipientId === employeeId
        )
        if (!outcome || !condition) {
          return chain
        }
        return {
          ...chain,
          outcomeSet: {
            ...chain.outcomeSet!,
            outcomes: [
              {
                ...outcome,
                evidence: [
                  ...outcome.evidence,
                  {
                    id: `ev_${employeeId}`,
                    outcomeId: outcome.id,
                    conditionId: condition.id,
                    outcomeRevision: outcome.revision,
                    conditionKey: 'k',
                    kind: 'review' as const,
                    target: employeeId,
                    receipt: decision
                      ? `handoff-review:hth_${employeeId}:hrv_${employeeId}:${decision}`
                      : `user-review:${employeeId}`,
                    verifiedAt: 30,
                    verifier: 'execution-host' as const
                  }
                ]
              }
            ]
          }
        }
      })
    },
    call: async (name: string, params: unknown): Promise<{ view: UpNextView }> => {
      const target = method(name)
      const parsed = target.params ? target.params.parse(params) : params
      return (await target.handler(parsed, ctx)) as { view: UpNextView }
    }
  }
}
