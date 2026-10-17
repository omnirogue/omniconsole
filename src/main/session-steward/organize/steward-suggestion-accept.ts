/**
 * The person's Yes to a steward suggestion in Work (D5). The action runs as
 * `{ kind: 'steward', feature: 'suggestion', suggestionId }` with request `accepted in Work`,
 * and that actor reads as person-approved only while this acceptance is held.
 */

import {
  STEWARD_SUGGESTION_REQUEST,
  type SessionManageActor
} from '../../../shared/session-manage-types'
import type {
  StewardSuggestion,
  StewardSuggestionAcceptResult,
  StewardSuggestionKind
} from '../../../shared/session-steward-suggestions'
import { beginSuggestionAcceptance } from '../../session-manage/session-manage-unattended'
import { stewardDisabledByEnv, stewardSettings } from '../steward-switches'
import type { StewardSuggestionsStore } from './steward-suggestions-store'

export type StewardSuggestionActor = Extract<SessionManageActor, { feature: 'suggestion' }>

export type StewardSuggestionAcceptContext = {
  actor: StewardSuggestionActor
  /** Record it on every change and audit line the action writes. */
  request: typeof STEWARD_SUGGESTION_REQUEST
}

/** Runs the accepted action (WP-O2 project, WP-O3 merge); throws when nothing changed. */
export type StewardSuggestionAcceptor = (
  suggestion: StewardSuggestion,
  context: StewardSuggestionAcceptContext
) => Promise<{ summary: string }>

const acceptors = new Map<StewardSuggestionKind, StewardSuggestionAcceptor>()
const inFlight = new Set<string>()

export function registerStewardSuggestionAcceptor(
  kind: StewardSuggestionKind,
  acceptor: StewardSuggestionAcceptor
): () => void {
  acceptors.set(kind, acceptor)
  return () => {
    if (acceptors.get(kind) === acceptor) {
      acceptors.delete(kind)
    }
  }
}

export function stewardSuggestionActor(suggestionId: string): StewardSuggestionActor {
  return { kind: 'steward', feature: 'suggestion', suggestionId }
}

function stopRefusal(): string | null {
  if (stewardDisabledByEnv()) {
    return 'The session steward is stopped on this computer, so its suggestions cannot run. Nothing changed.'
  }
  return stewardSettings().enabled
    ? null
    : 'The session steward is switched off in Settings, so its suggestions cannot run. Nothing changed.'
}

/** Runs an open suggestion's action on the person's Yes; it stays open when the action fails. */
export async function acceptStewardSuggestion(
  store: StewardSuggestionsStore,
  id: string
): Promise<StewardSuggestionAcceptResult> {
  const suggestion = await store.requireOpen(id)
  const stop = stopRefusal()
  if (stop) {
    throw new Error(stop)
  }
  const acceptor = acceptors.get(suggestion.kind)
  if (!acceptor) {
    throw new Error(
      suggestion.kind === 'unplaced'
        ? 'Sessions the steward could not place are filed from the sidebar. Nothing changed.'
        : 'This kind of suggestion cannot be accepted in this version. Nothing changed.'
    )
  }
  if (inFlight.has(id)) {
    throw new Error('That suggestion is already being carried out.')
  }
  inFlight.add(id)
  const release = beginSuggestionAcceptance(id)
  try {
    const { summary } = await acceptor(suggestion, {
      actor: stewardSuggestionActor(id),
      request: STEWARD_SUGGESTION_REQUEST
    })
    return { suggestion: await store.markAccepted(id, summary), summary }
  } finally {
    release()
    inFlight.delete(id)
  }
}
