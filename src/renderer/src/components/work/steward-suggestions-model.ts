import type {
  StewardGuardNotice,
  StewardSuggestion,
  StewardSuggestionsResult
} from '../../../../shared/session-steward-suggestions'

/** What the Work card shows above the steward's activity. */
export type StewardSuggestionRows = {
  /** Features the accuracy guard paused, each with a one-click Resume. */
  paused: StewardGuardNotice[]
  /** Merge and project suggestions, each with Yes and Dismiss. */
  offers: StewardSuggestion[]
  /** The latest "couldn't place" list, shown as a count. */
  unplaced: { id: string; count: number } | null
}

const OFFER_LIMIT = 5

export function stewardSuggestionRows(
  result: StewardSuggestionsResult | null | undefined
): StewardSuggestionRows {
  const open = (result?.suggestions ?? []).filter((entry) => entry.state === 'open')
  const unplaced = open.find((entry) => entry.kind === 'unplaced')
  return {
    paused: result?.paused ?? [],
    offers: open.filter((entry) => entry.kind !== 'unplaced').slice(0, OFFER_LIMIT),
    unplaced:
      unplaced && unplaced.targets.length > 0
        ? { id: unplaced.id, count: unplaced.targets.length }
        : null
  }
}

export function hasStewardSuggestionRows(rows: StewardSuggestionRows): boolean {
  return rows.paused.length > 0 || rows.offers.length > 0 || rows.unplaced !== null
}
