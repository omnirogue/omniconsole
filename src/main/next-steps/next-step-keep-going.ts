/**
 * "Keep going": for a conversation the person opted in, runs the first step of the current turn's
 * lead set (the reply's own proposal, else the AI's), unless it hits a hard stop, through the same
 * `decide` path a click uses, for at most `maxRounds` turns. It is the one path that sends without
 * a click, so its delivery fails CLOSED: anything it did not cause, or cannot read, stops it. This
 * is its public surface.
 */

import { conversationSourceRowKey, type ConversationSource } from '../../shared/conversation-source'
import type { NextStepAdPauses } from '../../shared/next-step-ad-pauses'
import {
  normalizeKeepGoingPushPrompt,
  normalizeKeepGoingRounds,
  type NextStepKeepGoingMode,
  type NextStepKeepGoingState
} from '../../shared/next-step-keep-going'
import {
  keepGoingDefaultPushPrompt,
  keepGoingDefaultRounds
} from '../../shared/next-step-suggestion-settings'
import type { NextStepSuggestionSet } from '../../shared/next-step-suggestions'
import type { PromptQueueEntry } from '../../shared/prompt-queue-types'
import { KeepGoingCore } from './next-step-keep-going-core'
import type { NextStepKeepGoingAttention } from './next-step-keep-going-guards'
import {
  deliveryRefusal,
  STALE_ENTRY_REASON,
  strayKeepGoingEntries
} from './next-step-keep-going-queue'
import { rememberReply } from './next-step-keep-going-judge'
import { evaluateRound, finishRoundTurn } from './next-step-keep-going-round-runner'
import { turnRelation, type RoundTrack } from './next-step-keep-going-rounds'
import type { TurnSignal } from './next-step-turn-signal'

export type { NextStepKeepGoingAttention } from './next-step-keep-going-guards'

export type { NextStepKeepGoingDeps } from './next-step-keep-going-core'

/** How a run goes; absent = `next-step`, and the prompt this conversation last pushed with. */
export type NextStepKeepGoingRun = { mode?: NextStepKeepGoingMode; pushPrompt?: string }

export class NextStepKeepGoingController extends KeepGoingCore {
  private evaluateQueued = false

  get revision(): number {
    return this.deps.store.revision
  }

  list(filter: { worktreeId?: string; conversation?: ConversationSource } = {}) {
    const key = filter.conversation ? conversationSourceRowKey(filter.conversation) : null
    return this.deps.store
      .list()
      .filter(
        (state) =>
          (!key || conversationSourceRowKey(state.conversation) === key) &&
          (!filter.worktreeId || state.conversation.worktreeId === filter.worktreeId)
      )
  }

  /**
   * The person's switch. Turning it on starts at round 0 unless it is already on; turning a
   * running one on again only changes its mode or push prompt.
   */
  setKeepGoing(
    conversation: ConversationSource,
    enabled: boolean,
    maxRounds?: number,
    reason: 'person-stopped' | 'person-acted' | 'person-typing' = 'person-stopped',
    run: NextStepKeepGoingRun = {}
  ): NextStepKeepGoingState {
    const key = conversationSourceRowKey(conversation)
    const current = this.deps.store.get(key)
    if (!enabled) {
      // Idempotent and cheap: stopping what is not running changes and stores nothing.
      return current?.enabled ? this.stop(key, reason) : (current ?? this.idle(conversation))
    }
    const settings = this.deps.service.deps.settings()
    const mode = run.mode ?? (current?.enabled ? current.mode : undefined) ?? 'next-step'
    const pushPrompt =
      normalizeKeepGoingPushPrompt(run.pushPrompt) ??
      current?.pushPrompt ??
      keepGoingDefaultPushPrompt(settings)
    if (current?.enabled && this.tracks.has(key)) {
      if (mode === (current.mode ?? 'next-step') && pushPrompt === current.pushPrompt) {
        return current
      }
      const changed = this.deps.store.set({ ...current, mode, pushPrompt })
      this.onSetsChanged()
      return changed
    }
    const state = this.deps.store.set({
      conversation,
      enabled: true,
      maxRounds: normalizeKeepGoingRounds(maxRounds) ?? keepGoingDefaultRounds(settings),
      roundsUsed: 0,
      startedAt: this.now(),
      mode,
      pushPrompt,
      // The person's ad-pause choice outlives any one run.
      ...(current?.adPauses ? { adPauses: current.adPauses } : {})
    })
    // Settled sets are history; a pending one on the current turn is what the person is looking at.
    const history = this.roundSetsOf(key)
      .filter((set) => set.status !== 'pending' && set.status !== 'generating')
      .map((set) => set.id)
    const track: RoundTrack = {
      runToken: this.newToken(),
      seenTurnKey: this.currentTurnKey(key) ?? undefined,
      ranTurnKeys: new Set(),
      seenSetIds: new Set(history),
      running: false
    }
    // The reply "Push for better" starts from, for JEV's round-over-round comparison.
    rememberReply(track, this.deps.service.currentTurns.get(key)?.turn?.lastAssistantMessage)
    this.tracks.set(key, track)
    this.onSetsChanged()
    return state
  }

  /** This conversation's ad-pause choice; null follows the global setting. Running or not. */
  setAdPauses(
    conversation: ConversationSource,
    adPauses: NextStepAdPauses | null
  ): NextStepKeepGoingState {
    const current = this.deps.store.get(conversationSourceRowKey(conversation))
    if (current && (current.adPauses ?? null) === adPauses) {
      return current
    }
    const { adPauses: _previous, ...rest } = current ?? this.idle(conversation)
    return this.deps.store.set(adPauses ? { ...rest, adPauses } : rest)
  }

  /** Every change to the suggestion sets; evaluated once the store's own write has returned. */
  onSetsChanged(): void {
    if (this.evaluateQueued) {
      return
    }
    this.evaluateQueued = true
    queueMicrotask(() => {
      this.evaluateQueued = false
      for (const key of this.enabledKeys()) {
        evaluateRound(this, key)
      }
    })
  }

  /** The live check, on the host's 2 s pre-tick before the prompt queues drain. */
  sweep(): void {
    this.withdrawStaleEntries()
    for (const key of this.enabledKeys()) {
      const state = this.deps.store.get(key)!
      const refusal = !this.deps.isConversationOpen(state.conversation)
        ? 'pane-closed'
        : this.currentTurnKey(key) === null
          ? 'turn-unknown'
          : this.guard(state.conversation, this.tracks.get(key)?.outstanding?.entryId)
      if (refusal) {
        this.stop(key, refusal)
      } else {
        evaluateRound(this, key)
      }
    }
  }

  /** The sweep itself failed: nothing automatic may go out on an unchecked tick. */
  stopAll(detail: string): void {
    for (const key of this.enabledKeys()) {
      try {
        this.stop(key, 'round-refused', detail)
      } catch (error) {
        console.error('[next-steps] keep going could not stop', error)
      }
    }
  }

  /** Withdraws every still-queued Keep going entry no running enablement owns. At startup and each tick. */
  withdrawStaleEntries(): void {
    const trackOf = (source: ConversationSource) => {
      const key = conversationSourceRowKey(source)
      return this.deps.store.get(key)?.enabled ? this.tracks.get(key) : undefined
    }
    for (const { source, entry } of strayKeepGoingEntries(this.deps.listPromptQueues(), trackOf)) {
      if (this.deps.withdrawQueued(source, entry.id, STALE_ENTRY_REASON)) {
        this.logEntry(source, entry, 'restarted', STALE_ENTRY_REASON)
      }
    }
  }

  /**
   * The drain's last check, immediately before a Keep going entry is written (after every await).
   * Throws, and stops Keep going with the reason, unless this is exactly the outstanding round and
   * every stop condition still passes.
   */
  assertDelivery(source: ConversationSource, entry: PromptQueueEntry): void {
    const key = conversationSourceRowKey(source)
    const state = this.deps.store.get(key)
    if (!state?.enabled) {
      throw new Error('Keep going is off, so its prompt was not sent.')
    }
    const refusal = deliveryRefusal({
      track: this.tracks.get(key),
      entry,
      open: this.deps.isConversationOpen(source),
      currentTurnKey: this.currentTurnKey(key),
      guard: this.guard(state.conversation, entry.id)
    })
    if (refusal) {
      this.stop(key, refusal.reason, refusal.detail)
      throw new Error(`Keep going stopped before this was sent (${refusal.reason}).`)
    }
  }

  onTurnSignal(signal: TurnSignal, attention: NextStepKeepGoingAttention | null = null): void {
    if (signal.kind === 'ignore') {
      return
    }
    const conversation = signal.kind === 'finished' ? signal.turn.conversation : signal.conversation
    const key = conversation ? conversationSourceRowKey(conversation) : null
    const track = key ? this.tracks.get(key) : undefined
    if (!key || !track || !this.deps.store.get(key)?.enabled) {
      return
    }
    if (signal.kind === 'busy') {
      if (attention) {
        this.stop(key, attention)
      }
      return
    }
    const turnKey = signal.kind === 'finished' ? signal.turn.turnKey : signal.turnKey
    const order = signal.kind === 'finished' ? signal.turn.order : signal.order
    const relation = turnRelation(this.deps.service.currentTurns.get(key), turnKey, order)
    // A re-report or a replayed older turn changes nothing; an unprovable one stops it.
    if (turnKey === track.seenTurnKey || relation === 'same' || relation === 'older') {
      return
    }
    if (relation === 'unknown') {
      this.stop(key, 'turn-unknown')
    } else if (signal.kind === 'skip') {
      const reason = attention ?? this.deps.readAttention(conversation!) ?? 'turn-skipped'
      this.stop(key, reason, signal.reason)
    } else if (attention) {
      this.stop(key, attention)
    } else {
      finishRoundTurn(this, key, track, turnKey, signal.turn)
    }
  }

  /** A question, permission prompt or failure surfaced outside a turn signal. */
  onAttention(conversation: ConversationSource, attention: NextStepKeepGoingAttention): void {
    this.stopIfEnabled(conversationSourceRowKey(conversation), attention)
  }

  /** The person answered a set of this conversation through `nextSteps.decide`. */
  onPersonDecided(set: Pick<NextStepSuggestionSet, 'conversation'>): void {
    if (set.conversation) {
      this.stopIfEnabled(conversationSourceRowKey(set.conversation), 'person-decided')
    }
  }

  /**
   * Another conversation is about to continue, ask or stop this one at the person's request: Keep
   * going stops FIRST, so its next round can never go out beside that prompt. The reasons are the
   * person's own (every client already reads them); the detail names the acting session.
   */
  onSessionManaged(
    conversation: ConversationSource,
    detail: string,
    reason: 'person-message' | 'person-stopped'
  ): boolean {
    const key = conversationSourceRowKey(conversation)
    if (!this.deps.store.get(key)?.enabled) {
      return false
    }
    this.stop(key, reason, detail)
    return true
  }

  /** A terminal pane went away; chat sessions are matched by `onConversationClosed` or the sweep. */
  onPaneClosed(paneKey: string): void {
    for (const key of this.enabledKeys()) {
      const { conversation } = this.deps.store.get(key)!
      if (conversation.kind === 'pty' && conversation.paneKey === paneKey) {
        this.stop(key, 'pane-closed')
      }
    }
  }

  onConversationClosed(conversation: ConversationSource): void {
    this.stopIfEnabled(conversationSourceRowKey(conversation), 'pane-closed')
  }

  /** The drain confirmed delivering an entry; our round counts now, whatever the log is doing. */
  onDelivered(source: ConversationSource, entryId: string): void {
    const key = conversationSourceRowKey(source)
    const track = this.tracks.get(key)
    if (track?.outstanding?.entryId === entryId) {
      this.countRound(key, track)
    }
  }
}
