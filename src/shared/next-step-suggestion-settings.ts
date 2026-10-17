/**
 * The person's switch for AI-suggested next steps. On by default (Sal, 2026-09-23): after a
 * finished turn one read-only model call proposes what to do next; nothing runs without a click.
 */

import {
  NEXT_STEP_KEEP_GOING_DEFAULT_PUSH_PROMPT,
  NEXT_STEP_KEEP_GOING_DEFAULT_ROUNDS,
  normalizeKeepGoingMode,
  normalizeKeepGoingPushPrompt,
  normalizeKeepGoingRounds,
  type NextStepKeepGoingMode
} from './next-step-keep-going'
import { normalizeAdPauses, type NextStepAdPauses } from './next-step-ad-pauses'
import type { TuiAgent } from './tui-agent'
import { isTuiAgent } from './tui-agent-config'

export type NextStepSuggestionSettings = {
  enabled: boolean
  /** One-shot CLI that writes the suggestions; absent = the conversation's own agent. */
  agent?: TuiAgent
  /** Model for that CLI; absent = the CLI's default one-shot model. */
  model?: string
  /** Rounds "Keep going" offers by default; absent = 10. */
  keepGoingMaxRounds?: number
  /** The mode the tray's "Keep going" offers first; absent = `next-step`. */
  keepGoingDefaultMode?: NextStepKeepGoingMode
  /** "Push for better"'s prompt for a conversation that has none yet; absent = the built-in one. */
  keepGoingPushPrompt?: string
  /** What JEV adds to suggestions; absent = all on. */
  jev?: NextStepJevSettings
  /** Whether a step that only pauses ads may run without the person; absent = allowed. */
  adPauses?: NextStepAdPauses
}

/** JEV's advisory jobs: rank the steps, raise a risk it clearly sees, read how done the work is. */
export type NextStepJevSettings = { rank: boolean; risk: boolean; doneness: boolean }

export function nextStepJevSettings(settings: NextStepSuggestionSettings): NextStepJevSettings {
  return settings.jev ?? { rank: true, risk: true, doneness: true }
}

/** Each switch is on unless explicitly `false`; null when there is nothing to read. */
function normalizeNextStepJevSettings(raw: unknown): NextStepJevSettings | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }
  const value = raw as Record<string, unknown>
  return {
    rank: value.rank !== false,
    risk: value.risk !== false,
    doneness: value.doneness !== false
  }
}

export const NEXT_STEP_SUGGESTION_MODEL_MAX_LENGTH = 200

export function getDefaultNextStepSuggestionSettings(): NextStepSuggestionSettings {
  return { enabled: true }
}

/** Persisted or hand-edited input; anything unreadable falls back to the default. */
export function normalizeNextStepSuggestionSettings(raw: unknown): NextStepSuggestionSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return getDefaultNextStepSuggestionSettings()
  }
  const value = raw as Record<string, unknown>
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  const keepGoingMaxRounds = normalizeKeepGoingRounds(value.keepGoingMaxRounds)
  const keepGoingDefaultMode = normalizeKeepGoingMode(value.keepGoingDefaultMode)
  const keepGoingPushPrompt = normalizeKeepGoingPushPrompt(value.keepGoingPushPrompt)
  const jev = normalizeNextStepJevSettings(value.jev)
  const adPauses = normalizeAdPauses(value.adPauses)
  return {
    enabled: value.enabled !== false,
    ...(isTuiAgent(value.agent) ? { agent: value.agent } : {}),
    ...(model && model.length <= NEXT_STEP_SUGGESTION_MODEL_MAX_LENGTH ? { model } : {}),
    ...(keepGoingMaxRounds !== null ? { keepGoingMaxRounds } : {}),
    ...(keepGoingDefaultMode ? { keepGoingDefaultMode } : {}),
    ...(keepGoingPushPrompt ? { keepGoingPushPrompt } : {}),
    ...(jev ? { jev } : {}),
    ...(adPauses ? { adPauses } : {})
  }
}

export function keepGoingDefaultRounds(settings: NextStepSuggestionSettings): number {
  return settings.keepGoingMaxRounds ?? NEXT_STEP_KEEP_GOING_DEFAULT_ROUNDS
}

export function keepGoingDefaultPushPrompt(settings: NextStepSuggestionSettings): string {
  return settings.keepGoingPushPrompt ?? NEXT_STEP_KEEP_GOING_DEFAULT_PUSH_PROMPT
}
