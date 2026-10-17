/**
 * The `nextSteps.*` runtime methods: what a client may ask about suggested next steps and the
 * shapes it gets back. Additive to the wire — an older host answers "method not found".
 */

import type { ConversationSource } from './conversation-source'
import type { NextStepDoneness } from './next-step-doneness'
import type { NextStepKeepGoingState } from './next-step-keep-going'
import type { NextStepSuggestion, NextStepSuggestionSet } from './next-step-suggestions'
import type { NextStepReplyPtyProof } from './next-step-reply-proof'

export const NEXT_STEPS_RPC = {
  list: 'nextSteps.list',
  generate: 'nextSteps.generate',
  decide: 'nextSteps.decide',
  offerParsed: 'nextSteps.offerParsed',
  current: 'nextSteps.current',
  keepGoing: 'nextSteps.keepGoing',
  adPauses: 'nextSteps.adPauses',
  suggestStart: 'nextSteps.suggestStart',
  linkTask: 'nextSteps.linkTask'
} as const

/** The host pushes nothing for these sets; clients re-list at the prompt queue's pace. */
export const NEXT_STEPS_POLL_MS = 2_000

/** A finished turn that got no suggestions, and why. Never silent. */
export type NextStepSkip = {
  at: number
  conversation?: ConversationSource
  turnKey?: string
  reason: string
}

export type NextStepsListResult = {
  sets: NextStepSuggestionSet[]
  skips: NextStepSkip[]
  /** Bumps on every change, so a poller can skip re-rendering an unchanged answer. */
  revision: number
  /** Present while the sets cannot be saved to disk. */
  storageError?: string
  /** "Keep going" per conversation, on or last stopped; absent from an older host. */
  keepGoing?: NextStepKeepGoingState[]
  /** Bumps on every keep-going change, even one that makes no new set. */
  keepGoingRevision?: number
  /** Explicit unanswered questions in the owner's current finished replies; absent on old hosts. */
  replyDecisions?: NextStepReplyDecision[]
  /** The process that observed these decisions; required when projecting a paired owner's reply. */
  executionRuntimeId?: string
}

export type NextStepReplyDecision = {
  conversation: ConversationSource
  turnKey: string
  completedAt: number
  question: string
  /** PTY owner evidence; optional for older hosts and structured conversations. */
  ptyProof?: NextStepReplyPtyProof
}

export type NextStepsGenerateResult =
  | { set: NextStepSuggestionSet; skipped?: undefined }
  | { set: null; skipped: string }

export type NextStepNotQueued = { id: string; reason: string }

export type NextStepsDecideResult = {
  set: NextStepSuggestionSet
  /** Suggestion ids now in the prompt queue, in the order they were queued. */
  queued: string[]
  notQueued: NextStepNotQueued[]
  /** Present when the decision could not be written to the decision log. */
  logError?: string
}

/**
 * The fallback offer for an agent that reports no turns. `refused` says why the host did not take
 * it: once any turn was observed for the conversation, the host reads replies itself.
 */
export type NextStepsOfferParsedResult =
  | { set: NextStepSuggestionSet; refused?: undefined }
  | { set: null; refused: string }

/**
 * A conversation's current turn as the host knows it: the latest finished turn it observed.
 * Older turns are never returned; a client never derives a turn key itself.
 */
export type NextStepsCurrentResult = {
  /** Null while the host knows no turn and holds no set for the conversation. */
  turnKey: string | null
  /** The newest AI-written set for this turn, in any status. */
  ai?: NextStepSuggestionSet
  /** The newest set read from this turn's reply (by the host, or offered by a client), any status. */
  parsed?: NextStepSuggestionSet
  /** No set for this turn is open and at least one was answered (or carried over as answered). */
  answered: boolean
  /**
   * Whether the host has ever seen this conversation finish a turn. A client may offer a reply's
   * steps only on `false`; `null` means the host could not tell, which is not "never".
   */
  turnObserved: boolean | null
  /** When the current turn completed, to tell a reply newer than it (the host is behind). */
  turnCompletedAt?: number
  revision: number
  storageError?: string
  /** This conversation's "Keep going", on or last stopped; absent from an older host. */
  keepGoing?: NextStepKeepGoingState
  keepGoingRevision?: number
  /** JEV's advisory reading of how done the work is after this turn; absent when JEV gave none. */
  doneness?: NextStepDoneness
}

/** The hub card a client knows this conversation serves; the host reads its goal from it. */
export type NextStepsLinkTaskResult = { ok: true }

export type NextStepsKeepGoingResult = { state: NextStepKeepGoingState }

/** `nextSteps.adPauses`: the conversation's Keep going state with its ad-pause choice. */
export type NextStepsAdPausesResult = { state: NextStepKeepGoingState }

export type NextStepOfferedSuggestion = Omit<NextStepSuggestion, 'risk' | 'id'> & {
  id?: string
  risk?: NextStepSuggestion['risk']
}

/**
 * One finished turn's identity, minted by the host only. `turnMark` is the turn's own completion
 * stamp — a hook row's `turnCompletedAt ?? stateStartedAt`, or a chat journal's last sequence.
 * Clients read turn keys from `nextSteps.current`; they never derive one.
 */
export function nextStepTurnKey(paneKey: string, turnMark: number | string): string {
  return `${paneKey}@${turnMark}`
}
