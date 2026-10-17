/**
 * Keep going's state and the moves every part of it shares: its enablements (tracks), stopping
 * with a recorded reason, the guard, the current turn, and counting a round. Internal to Keep
 * going; the controller is the public surface.
 */

import { randomBytes } from 'node:crypto'
import { conversationSourceRowKey, type ConversationSource } from '../../shared/conversation-source'
import type {
  NextStepKeepGoingState,
  NextStepKeepGoingStopReason
} from '../../shared/next-step-keep-going'
import { keepGoingDefaultRounds } from '../../shared/next-step-suggestion-settings'
import type { NextStepSuggestionSet } from '../../shared/next-step-suggestions'
import type { PromptQueueEntry, PromptQueues } from '../../shared/prompt-queue-types'
import { decideNextSteps } from './next-step-decisions'
import {
  keepGoingGuardRefusal,
  type NextStepKeepGoingAttention
} from './next-step-keep-going-guards'
import {
  STOPPED_ENTRY_REASON,
  withdrawQueuedEntry,
  type KeepGoingQueueAccess
} from './next-step-keep-going-queue'
import type { RoundTrack } from './next-step-keep-going-rounds'
import type { NextStepKeepGoingJudges } from './next-step-keep-going-judge'
import type { NextStepKeepGoingStore } from './next-step-keep-going-store'
import type { NextStepSuggestionService } from './next-step-suggestion-service'

/** `assessDoneness` / `judgeImprovement` are optional: without them nothing JEV-based stops a run. */
export type NextStepKeepGoingDeps = NextStepKeepGoingJudges & {
  service: NextStepSuggestionService
  store: NextStepKeepGoingStore
  /** A question or permission prompt is open, or the last turn failed; null when neither. */
  readAttention: (source: ConversationSource) => NextStepKeepGoingAttention | null
  /** False once the pane or chat session is gone. */
  isConversationOpen: (source: ConversationSource) => boolean
  /** Every queue on this host, for entries an earlier run left behind. */
  listPromptQueues: () => PromptQueues
  withdrawQueued: KeepGoingQueueAccess['withdrawQueued']
  decide?: typeof decideNextSteps
  newToken?: () => string
  now?: () => number
}

export type StopReason = NextStepKeepGoingStopReason

export class KeepGoingCore {
  readonly tracks = new Map<string, RoundTrack>()
  readonly now: () => number
  readonly decide: typeof decideNextSteps
  readonly newToken: () => string
  readonly queue: KeepGoingQueueAccess

  constructor(readonly deps: NextStepKeepGoingDeps) {
    this.now = deps.now ?? Date.now
    this.decide = deps.decide ?? decideNextSteps
    this.newToken = deps.newToken ?? (() => randomBytes(3).toString('hex'))
    this.queue = {
      readQueueEntry: (source, entryId) =>
        deps.service.deps
          .readPromptQueue(source)
          ?.entries.find((candidate) => candidate.id === entryId),
      withdrawQueued: deps.withdrawQueued
    }
    deps.store.onEvict = (state) => {
      if (state.enabled) {
        this.record(
          state,
          'evicted',
          this.retire(conversationSourceRowKey(state.conversation), state)
        )
      }
    }
  }

  /** Counts the outstanding round into `roundsUsed` exactly once. */
  countRound(key: string, track: RoundTrack): void {
    const state = this.deps.store.get(key)
    if (!track.outstanding || track.outstanding.counted || !state?.enabled) {
      return
    }
    track.outstanding.counted = true
    this.deps.store.set({ ...state, roundsUsed: state.roundsUsed + 1 })
  }

  guard(conversation: ConversationSource, ownEntryId: string | undefined): StopReason | null {
    return keepGoingGuardRefusal(
      this.deps.service,
      conversation,
      ownEntryId,
      this.deps.readAttention(conversation)
    )
  }

  /** The turn the host observed as current; null when it has not observed one (unknown). */
  currentTurnKey(key: string): string | null {
    return this.deps.service.currentTurns.get(key)?.turnKey ?? null
  }

  enabledKeys(): string[] {
    return this.deps.store
      .list()
      .filter((state) => state.enabled)
      .map((state) => conversationSourceRowKey(state.conversation))
  }

  /**
   * A conversation's turn sets Keep going may run, the one it runs first: per turn, the reply's
   * own steps (the session's plan) before the AI's, each newest first. Start sets never.
   */
  roundSetsOf(key: string, turnKey?: string): NextStepSuggestionSet[] {
    const rank = (set: NextStepSuggestionSet) => (set.origin === 'parsed' ? 0 : 1)
    return this.deps.service.deps.store
      .list()
      .filter(
        (set) =>
          (set.origin === 'parsed' || set.origin === 'ai') &&
          (turnKey === undefined || set.turnKey === turnKey) &&
          set.conversation !== undefined &&
          conversationSourceRowKey(set.conversation) === key
      )
      .toSorted((left, right) => rank(left) - rank(right) || right.createdAt - left.createdAt)
  }

  /** Drops the enablement; takes a still-queued auto prompt back out. */
  retire(key: string, state: NextStepKeepGoingState): boolean {
    const track = this.tracks.get(key)
    this.tracks.delete(key)
    return track?.outstanding
      ? withdrawQueuedEntry(
          this.queue,
          state.conversation,
          track.outstanding.entryId,
          STOPPED_ENTRY_REASON
        )
      : false
  }

  idle(conversation: ConversationSource): NextStepKeepGoingState {
    return {
      conversation,
      enabled: false,
      maxRounds: keepGoingDefaultRounds(this.deps.service.deps.settings()),
      roundsUsed: 0,
      startedAt: this.now()
    }
  }

  logEntry(
    conversation: ConversationSource,
    entry: PromptQueueEntry,
    reason: StopReason,
    detail: string
  ): void {
    const round = entry.origin?.kind === 'keep-going' ? entry.origin.round : 1
    this.append({ conversation, reason, roundsUsed: round - 1, maxRounds: 0, detail }, true)
  }

  record(
    state: NextStepKeepGoingState,
    reason: StopReason,
    removedQueuedEntry: boolean,
    detail?: string
  ): void {
    const { conversation, roundsUsed, maxRounds } = state
    this.append(
      { conversation, reason, roundsUsed, maxRounds, ...(detail ? { detail } : {}) },
      removedQueuedEntry
    )
    console.info(`[next-steps] keep going stopped (${reason}) after ${roundsUsed} rounds`)
  }

  append(
    line: {
      conversation: ConversationSource
      reason: StopReason
      roundsUsed: number
      maxRounds: number
      detail?: string
    },
    removedQueuedEntry: boolean
  ): void {
    void this.deps.service.deps.store
      .appendKeepGoingStop({
        type: 'keep-going-stop',
        at: this.now(),
        ...line,
        ...(removedQueuedEntry ? { removedQueuedEntry } : {})
      })
      .catch(() => {})
  }

  stopIfEnabled(key: string, reason: StopReason): void {
    if (this.deps.store.get(key)?.enabled) {
      this.stop(key, reason)
    }
  }

  stop(key: string, reason: StopReason, detail?: string, percent?: number): NextStepKeepGoingState {
    const current = this.deps.store.get(key)!
    const removed = this.retire(key, current)
    const trimmed = detail?.trim().slice(0, 1000) || undefined
    const { stopDetail: _previous, stopPercent: _percent, ...rest } = current
    const stopped = this.deps.store.set({
      ...rest,
      enabled: false,
      stoppedAt: this.now(),
      stopReason: reason,
      ...(trimmed ? { stopDetail: trimmed } : {}),
      ...(percent !== undefined ? { stopPercent: percent } : {})
    })
    this.record(
      current,
      reason,
      removed,
      trimmed ?? (percent !== undefined ? `${percent}% resolved` : undefined)
    )
    return stopped
  }
}
