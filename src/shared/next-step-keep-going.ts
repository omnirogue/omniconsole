/**
 * "Keep going": the one exception to "nothing runs without a click". The person turns it on for
 * one conversation, and the host then runs the AI's top suggestion for up to 25 rounds by
 * itself, unless it hits a hard stop. It never turns itself on, never survives a restart, and stops at the first sign that
 * the person should decide (MISSION.md: silence is not agreement).
 */

import type { ConversationSource } from './conversation-source'
import type { NextStepAdPauses } from './next-step-ad-pauses'

export const NEXT_STEP_KEEP_GOING_MIN_ROUNDS = 1
export const NEXT_STEP_KEEP_GOING_MAX_ROUNDS = 25
export const NEXT_STEP_KEEP_GOING_DEFAULT_ROUNDS = 10

/** `next-step` runs the AI's top suggestion; `push-for-better` sends the person's push prompt. */
export type NextStepKeepGoingMode = 'next-step' | 'push-for-better'
export const NEXT_STEP_KEEP_GOING_MODES = ['next-step', 'push-for-better'] as const

export const NEXT_STEP_KEEP_GOING_PUSH_PROMPT_MAX_LENGTH = 2000
export const NEXT_STEP_KEEP_GOING_DEFAULT_PUSH_PROMPT =
  'Is that the best you can do? Find the weakest part of what you just produced and make it clearly better. Say what you changed.'

export type NextStepKeepGoingStopReason =
  /** The person turned it off. */
  | 'person-stopped'
  /** OmniConsole restarted; it never resumes by itself. */
  | 'restarted'
  | 'cap-reached'
  | 'needs-you-risky'
  | 'no-safe-suggestion'
  /** The top suggestion asks the person something. */
  | 'needs-you-question'
  /** Hard stops (Sal, 2026-09-23): the first step deploys, touches a shared branch, deletes data,
   *  rewrites history, sends something to people, pays, or touches credentials or permissions;
   *  ad spend changes need Sal's yes. */
  | 'needs-you-ad-spend'
  /** The step pauses ads and the person chose to approve ad pauses (Sal, 2026-09-26). */
  | 'needs-you-ad-pause'
  /** The step pauses a whole campaign or account: "we dont pause campaigns, we pause adsets". */
  | 'needs-you-ad-campaign-pause'
  /** The step pauses OmniRogue Enterprise ads, which are flagged for Sal, never paused. */
  | 'needs-you-ad-enterprise'
  | 'needs-you-deploy'
  | 'needs-you-shared-branch'
  | 'needs-you-delete-data'
  | 'needs-you-history'
  | 'needs-you-send'
  | 'needs-you-payment'
  | 'needs-you-credentials'
  | 'set-failed'
  | 'person-decided'
  | 'person-message'
  | 'agent-waiting'
  | 'turn-failed'
  /** The turn finished without a reply suggestions can follow (interrupted, tool-only, …). */
  | 'turn-skipped'
  | 'capacity-recovery'
  | 'chain-bound'
  | 'pane-closed'
  | 'setting-off'
  /** The chosen suggestion could not be queued. */
  | 'not-queued'
  /** The host refused the round: an earlier turn, an answered turn, a refused decision. */
  | 'round-refused'
  /** Pushed out of the bounded state file by newer conversations. */
  | 'evicted'
  /** The host could not tell which turn is current. */
  | 'turn-unknown'
  /** The top step is a command, code or an address, or a kind that needs the person. */
  | 'needs-you-command'
  /** The person acted in the tray (run, save, dismiss, tick). */
  | 'person-acted'
  /** The person typed in the conversation, sent or not. */
  | 'person-typing'
  /** JEV read the work as clearly resolved, nothing required missing, and checked (Push for better: and spent). */
  | 'done'
  /** "Push for better": JEV read another round as no longer making it better. */
  | 'no-more-improvement'

export type NextStepKeepGoingState = {
  conversation: ConversationSource
  enabled: boolean
  maxRounds: number
  roundsUsed: number
  startedAt: number
  stoppedAt?: number
  stopReason?: NextStepKeepGoingStopReason
  /** Plain words from the host when the reason has more to say (a refusal, a failure). */
  stopDetail?: string
  /** Absent = `next-step` (a host or file from before the modes). */
  mode?: NextStepKeepGoingMode
  /** What "Push for better" sends each round; kept per conversation. */
  pushPrompt?: string
  /** `done`: how resolved JEV read the work, 0–100. */
  stopPercent?: number
  /** This conversation's ad-pause choice; absent = the global setting. */
  adPauses?: NextStepAdPauses
  /** The latest round that paused ads without asking, so the person can see it happened. */
  lastAdPause?: NextStepKeepGoingAdPause
}

export type NextStepKeepGoingAdPause = { at: number; round: number; title: string }

/** A line in the decisions log beside the decision records; one per stop. */
export type NextStepKeepGoingStopRecord = {
  type: 'keep-going-stop'
  at: number
  conversation: ConversationSource
  reason: NextStepKeepGoingStopReason
  roundsUsed: number
  maxRounds: number
  detail?: string
  /** An auto-queued prompt was taken back out of the queue before it was sent. */
  removedQueuedEntry?: boolean
}

/** An integer in 1–25, or null when the input is not one. */
export function normalizeKeepGoingRounds(raw: unknown): number | null {
  return typeof raw === 'number' &&
    Number.isInteger(raw) &&
    raw >= NEXT_STEP_KEEP_GOING_MIN_ROUNDS &&
    raw <= NEXT_STEP_KEEP_GOING_MAX_ROUNDS
    ? raw
    : null
}

export function normalizeKeepGoingMode(raw: unknown): NextStepKeepGoingMode | null {
  return raw === 'next-step' || raw === 'push-for-better' ? raw : null
}

/** Trimmed and capped; null when empty or not text. */
export function normalizeKeepGoingPushPrompt(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null
  }
  const trimmed = raw.trim().slice(0, NEXT_STEP_KEEP_GOING_PUSH_PROMPT_MAX_LENGTH).trim()
  return trimmed || null
}
