/**
 * Suggested next steps on this host: which finished turns get a suggester call, the sets that
 * come back, and the person's answer to them.
 *
 * Nothing here runs a suggestion. Accepting one queues its prompt through the prompt queue's
 * single enqueue authority, where it is delivered as the person's own message.
 */

import { randomUUID } from 'node:crypto'
import { conversationSourceRowKey, type ConversationSource } from '../../shared/conversation-source'
import type { NextStepSuggestion, NextStepSuggestionSet } from '../../shared/next-step-suggestions'
import type { NextStepSuggestionSettings } from '../../shared/next-step-suggestion-settings'
import type { NextStepDoneness } from '../../shared/next-step-doneness'
import type {
  NextStepSkip,
  NextStepsGenerateResult,
  NextStepsListResult
} from '../../shared/next-step-suggestions-rpc'
import type { PromptQueue, PromptQueueEnqueueInput } from '../../shared/prompt-queue-types'
import { NextStepGenerationScheduler } from './next-step-generation-scheduler'
import type { NextStepGenerateOutcome } from './next-step-generate-outcome'
import type { NextStepTurnContext } from './next-step-suggestion-generator'
import type { NextStepSuggestionStore } from './next-step-suggestion-store'
import type { NextStepStartServiceDeps } from './next-step-start-generator'
import type { FinishedTurn, TurnSignal } from './next-step-turn-signal'
import type { NextStepReplyPtyProof } from '../../shared/next-step-reply-proof'
import {
  NEXT_STEP_OLDER_TURN_REASON,
  NEXT_STEP_TURN_ANSWERED_REASON,
  nextStepTurnHasAnswer,
  observeNextStepTurn,
  type ObservedTurn
} from './next-step-turn-answers'
import { listNextStepSets, type NextStepListFilter } from './next-step-set-listing'
import { nextStepFallbackLane } from './next-step-workspace'
import {
  NEXT_STEP_SESSION_PROPOSED_REASON,
  runNextStepGeneration
} from './next-step-generation-run'

export { NEXT_STEP_SESSION_PROPOSED_REASON }

export const NEXT_STEP_DEBOUNCE_MS = 1_500
export const NEXT_STEP_MAX_CONCURRENT = 2
const MAX_SKIPS = 50

export type { NextStepGenerateOutcome } from './next-step-generate-outcome'

export type NextStepSuggestionServiceDeps = NextStepStartServiceDeps & {
  store: NextStepSuggestionStore
  settings: () => NextStepSuggestionSettings
  readPromptQueue: (source: ConversationSource) => PromptQueue | null
  isChainBound: (source: ConversationSource) => boolean
  /** The prompt queue's own enqueue authority; throws its refusal in plain words. */
  enqueue: (source: ConversationSource, input: PromptQueueEnqueueInput) => void
  generate: (
    turn: FinishedTurn,
    signal: AbortSignal,
    context?: Pick<NextStepTurnContext, 'proposedSteps'>
  ) => Promise<NextStepGenerateOutcome>
  /** The newest finished turn when this process saw none (after a restart, a chat session). */
  readLatestTurn?: (source: ConversationSource) => Promise<FinishedTurn | null>
  /** In-memory owner snapshots with a closing question, including inactive panes after restart. */
  listReplyDecisionSources?: () => ConversationSource[]
  /** Current owner hook identity and full reply; no renderer or cross-host clock comparison. */
  readReplyDecisionPtyProof?: (source: ConversationSource) => NextStepReplyPtyProof | null
  /** The runner's cancellation lane for a conversation's workspace (host + path). */
  laneOf?: (source: ConversationSource) => string | null
  /** JEV's doneness reading for a turn, when there is one. */
  readDoneness?: (turnKey: string) => NextStepDoneness | undefined
  scheduler?: NextStepGenerationScheduler
  now?: () => number
  newId?: () => string
}

const OPEN_STATUSES = new Set<NextStepSuggestionSet['status']>(['generating', 'pending'])

export class NextStepSuggestionService {
  readonly latestTurns = new Map<string, FinishedTurn>()
  /** The latest finished turn observed per conversation. */
  readonly currentTurns = new Map<string, ObservedTurn>()
  /** Finished turns that got no suggestions, oldest first. */
  skips: NextStepSkip[] = []
  private skipRevision = 0
  readonly scheduler: NextStepGenerationScheduler
  private readonly now: () => number
  private readonly newId: () => string

  constructor(readonly deps: NextStepSuggestionServiceDeps) {
    this.scheduler =
      deps.scheduler ??
      new NextStepGenerationScheduler({
        delayMs: NEXT_STEP_DEBOUNCE_MS,
        maxConcurrent: NEXT_STEP_MAX_CONCURRENT
      })
    this.now = deps.now ?? Date.now
    this.newId = deps.newId ?? randomUUID
  }

  onTurnSignal(signal: TurnSignal): void {
    if (signal.kind === 'finished') {
      this.onFinishedTurn(signal.turn)
    } else if (signal.kind === 'skip') {
      if (signal.conversation) {
        observeNextStepTurn(this, signal.conversation, signal.turnKey, undefined, signal)
      }
      this.recordSkip(signal.reason, signal.conversation, signal.turnKey)
    } else if (signal.kind === 'busy') {
      this.noteBusy(signal.conversation)
    }
  }

  /**
   * A finished turn: schedules one suggester call after the debounce, or records why not. A reply
   * that proposes its own steps is the turn's set: the suggester runs for it only when the person
   * asks (`explicit`), and then offers steps beside the reply's, never in place of them.
   */
  onFinishedTurn(
    turn: FinishedTurn,
    options: {
      force?: boolean
      immediate?: boolean
      retryFailed?: boolean
      explicit?: boolean
    } = {}
  ): NextStepsGenerateResult {
    const key = conversationSourceRowKey(turn.conversation)
    if (observeNextStepTurn(this, turn.conversation, turn.turnKey, turn) === 'older') {
      this.recordSkip(NEXT_STEP_OLDER_TURN_REASON, turn.conversation, turn.turnKey)
      return { set: null, skipped: NEXT_STEP_OLDER_TURN_REASON }
    }
    this.latestTurns.set(key, turn)
    const parsed = this.findSet(key, turn.turnKey, 'parsed')
    if (parsed && !options.explicit) {
      return { set: parsed }
    }
    const existing = this.findSet(key, turn.turnKey, 'ai')
    // A hook re-reporting a failed turn must not loop the call; the person's click may retry it.
    const retry = existing?.status === 'failed' && options.retryFailed
    if (existing && !options.force && !retry) {
      return { set: existing }
    }
    const refusal = this.admissionRefusal(turn, options.force)
    if (refusal) {
      this.recordSkip(refusal, turn.conversation, turn.turnKey)
      return { set: null, skipped: refusal }
    }
    this.supersedeOpenSets(key, (set) => set.turnKey !== turn.turnKey || set.origin === 'ai')
    let admitted: NextStepSuggestionSet | null = null
    let refused: string | null = null
    this.scheduler.schedule(
      {
        key,
        lane: this.laneOf(turn.conversation),
        admit: () => {
          refused = this.admissionRefusal(turn, options.force)
          if (refused) {
            this.recordSkip(refused, turn.conversation, turn.turnKey)
            return false
          }
          if (!options.explicit && this.findSet(key, turn.turnKey, 'parsed')) {
            refused = NEXT_STEP_SESSION_PROPOSED_REASON
            return false
          }
          admitted = this.deps.store.upsert(this.newSet(turn, 'ai', 'generating', []))
          return true
        },
        run: (signal) =>
          runNextStepGeneration(this, admitted!.id, turn, signal, options.explicit === true),
        onDropped: () => {
          // Admitted but never run: an empty generating set would never settle.
          if (admitted && this.deps.store.get(admitted.id)?.status === 'generating') {
            this.deps.store.remove(admitted.id)
          }
        }
      },
      { immediate: options.immediate }
    )
    return admitted ? { set: admitted } : { set: null, skipped: refused ?? 'Scheduled.' }
  }

  /** The person's "Suggest next steps": no debounce; `force` overrides the skip rules. */
  async generate(
    conversation: ConversationSource,
    options: { force?: boolean } = {}
  ): Promise<NextStepsGenerateResult> {
    const key = conversationSourceRowKey(conversation)
    const turn =
      this.latestTurns.get(key) ?? (await this.deps.readLatestTurn?.(conversation)) ?? null
    if (!turn) {
      const reason = 'This conversation has no finished reply to suggest from yet.'
      this.recordSkip(reason, conversation)
      return { set: null, skipped: reason }
    }
    return this.onFinishedTurn(turn, {
      force: options.force,
      immediate: true,
      retryFailed: true,
      explicit: true
    })
  }

  noteBusy(conversation: ConversationSource): void {
    const key = conversationSourceRowKey(conversation)
    if (this.scheduler.cancelWaiting(key)) {
      this.recordSkip(
        'The agent started working again before suggestions were requested.',
        conversation,
        this.latestTurns.get(key)?.turnKey
      )
    }
  }

  /** The working agent's pane closed: its call is cancelled and its unfinished set dropped. */
  onPaneClosed(paneKey: string): void {
    const keys = new Set<string>()
    for (const set of this.deps.store.list()) {
      if (set.conversation?.paneKey === paneKey) {
        keys.add(conversationSourceRowKey(set.conversation))
        if (set.status === 'generating') {
          this.deps.store.remove(set.id)
        }
      }
    }
    for (const [key, turn] of this.latestTurns) {
      if (turn.conversation.paneKey === paneKey) {
        keys.add(key)
        this.latestTurns.delete(key)
      }
    }
    for (const key of keys) {
      this.currentTurns.delete(key)
    }
    for (const key of keys) {
      this.scheduler.abort(key, 'pane-closed')
    }
  }

  list(filter: NextStepListFilter = {}): NextStepsListResult {
    return listNextStepSets(this, filter)
  }

  newSet(
    turn: Pick<FinishedTurn, 'conversation' | 'turnKey'>,
    origin: NextStepSuggestionSet['origin'],
    status: NextStepSuggestionSet['status'],
    suggestions: NextStepSuggestion[]
  ): NextStepSuggestionSet {
    return {
      id: this.newId(),
      conversation: turn.conversation,
      worktreeId: turn.conversation.worktreeId,
      turnKey: turn.turnKey,
      origin,
      createdAt: this.now(),
      status,
      suggestions
    }
  }

  findSet(
    key: string,
    turnKey: string,
    origin: NextStepSuggestionSet['origin']
  ): NextStepSuggestionSet | undefined {
    return this.deps.store
      .list()
      .find(
        (set) =>
          set.origin === origin &&
          set.turnKey === turnKey &&
          set.conversation !== undefined &&
          conversationSourceRowKey(set.conversation) === key
      )
  }

  recordSkip(reason: string, conversation?: ConversationSource, turnKey?: string): void {
    if (turnKey && this.skips.some((skip) => skip.turnKey === turnKey && skip.reason === reason)) {
      return
    }
    this.skips = [
      ...this.skips,
      {
        at: this.now(),
        ...(conversation ? { conversation } : {}),
        ...(turnKey ? { turnKey } : {}),
        reason
      }
    ].slice(-MAX_SKIPS)
    this.skipRevision++
    console.info('[next-steps] no suggestions:', reason)
  }

  private skipReason(conversation: ConversationSource): string | null {
    if (!this.deps.settings().enabled) {
      return 'Suggested next steps are turned off in settings.'
    }
    if (this.deps.readPromptQueue(conversation)?.entries.some((e) => e.state === 'queued')) {
      return 'A prompt is already queued for this conversation, so the next step is decided.'
    }
    if (this.deps.isChainBound(conversation)) {
      return 'A running plan is driving this conversation.'
    }
    return null
  }

  supersedeOpenSets(
    key: string,
    applies: (set: NextStepSuggestionSet) => boolean,
    reason?: string
  ): void {
    for (const set of this.deps.store.list()) {
      if (
        OPEN_STATUSES.has(set.status) &&
        set.conversation &&
        conversationSourceRowKey(set.conversation) === key &&
        applies(set)
      ) {
        this.deps.store.update(set.id, (current) => ({
          ...current,
          status: 'superseded',
          ...(reason ? { error: reason } : {})
        }))
      }
    }
  }

  /** `force` overrides the skip rules, never an answered turn. */
  private admissionRefusal(turn: FinishedTurn, force?: boolean): string | null {
    if (nextStepTurnHasAnswer(this, turn)) {
      return NEXT_STEP_TURN_ANSWERED_REASON
    }
    return force ? null : this.skipReason(turn.conversation)
  }

  /** Bumps the listed revision for a change outside the store (a skip, a held reply). */
  noteChange(): void {
    this.skipRevision++
  }

  get revision(): number {
    return this.deps.store.revision + this.skipRevision
  }

  private laneOf(conversation: ConversationSource): string {
    return this.deps.laneOf?.(conversation) ?? nextStepFallbackLane(conversation.worktreeId)
  }
}
