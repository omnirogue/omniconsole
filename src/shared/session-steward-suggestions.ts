/**
 * Steward suggestions (Phase 3): what the steward proposes but never does by itself — merge two
 * sessions, make a batch a project, or the sessions it could not place. The person says Yes or
 * Dismiss in Work. docs/reference/session-steward.md.
 */

import { z } from 'zod'
import type { OrganizationTarget } from './session-organization-change'
import {
  STEWARD_GUARDED_FEATURES,
  type StewardGuardedFeature
} from './session-steward-organize-settings'

export const SESSION_STEWARD_RPC = {
  suggestions: 'sessionSteward.suggestions',
  acceptSuggestion: 'sessionSteward.acceptSuggestion',
  dismissSuggestion: 'sessionSteward.dismissSuggestion',
  resumeOrganize: 'sessionSteward.resumeOrganize'
} as const

/** The tag (`omni session tag --add independent`) that keeps a session out of merge suggestions. */
export const STEWARD_INDEPENDENT_TAG_ID = 'independent'

export const STEWARD_SUGGESTION_KINDS = ['merge', 'project', 'unplaced'] as const
export type StewardSuggestionKind = (typeof STEWARD_SUGGESTION_KINDS)[number]

export type StewardSuggestionState = 'open' | 'accepted' | 'dismissed' | 'expired'

export type StewardSuggestion = {
  id: string
  kind: StewardSuggestionKind
  /** Epoch ms. */
  createdAt: number
  expiresAt: number
  targets: OrganizationTarget[]
  /** Kind-specific: `{ into }` (merge), `{ folderPath, name }` (project), `{ keys }` (unplaced). */
  proposal: unknown
  /** The one-line question shown in Work, e.g. "Merge “A” into “B”?". */
  title: string
  /** Why, in plain words: "Same deliverable (0.92 both ways), 4 shared files". */
  evidence: string
  state: StewardSuggestionState
  /** Same pair, same suggestion: a dismissed one is not proposed again for 30 days. */
  pairKey: string
  /** When it was accepted, dismissed or expired. */
  decidedAt?: number
  /** What the accepted action reported. */
  outcome?: string
}

/** A feature the accuracy guard paused, with the evidence it paused on. */
export type StewardGuardNotice = {
  feature: StewardGuardedFeature
  corrected: number
  samples: number
  pausedAt: number
}

export type StewardSuggestionsResult = {
  /** Open suggestions, newest first. */
  suggestions: StewardSuggestion[]
  paused: StewardGuardNotice[]
}

export type StewardSuggestionAcceptResult = {
  suggestion: StewardSuggestion
  summary: string
}

const SuggestionIdSchema = z.string().trim().min(1).max(100)

export const StewardSuggestionsParamsSchema = z
  .object({ kinds: z.array(z.enum(STEWARD_SUGGESTION_KINDS)).max(3).optional() })
  .strict()

export const StewardSuggestionDecisionParamsSchema = z.object({ id: SuggestionIdSchema }).strict()

export const StewardResumeOrganizeParamsSchema = z
  .object({ feature: z.enum(STEWARD_GUARDED_FEATURES) })
  .strict()
