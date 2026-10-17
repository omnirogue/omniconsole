// OmniConsole: the fold rule for hub task publications.
//
// Kept apart from journal-task-publication.ts so the reducer and the row
// builders can use it without importing the store-facing save path (which
// would be a module cycle through journal-store).
//
// The split between the two exports below is load-bearing. Before upstream
// #18652 this rule ran ONLY when a caller saved: the JSONL snapshot carried the
// folded map verbatim and was never re-folded. On SQLite the same rule is the
// reducer's fold, so it now also runs on replay and on the carry that re-emits
// saved publications into a new epoch — and the carry emits a publication in
// its FINAL form, with no pending row in front of it. A save-ordering rule
// applied there rejects durable state and takes the epoch roll down with it.

import { isDeepStrictEqual } from 'node:util'
import {
  isJournalTaskPublication,
  type JournalTaskPublication
} from './journal-task-publication-schema'

/** Apply one publication to the saved set. This is the FOLD: it runs on replay
 *  and on the epoch carry as well as on a save, so it asserts only what must be
 *  true of durable state — a publication's request and authority are immutable,
 *  and a receipt already saved cannot be reassigned to a different note. */
export function nextTaskPublications(
  current: ReadonlyMap<string, JournalTaskPublication>,
  input: JournalTaskPublication
): Map<string, JournalTaskPublication> {
  if (!isJournalTaskPublication(input)) {
    throw new Error('Invalid task publication journal record.')
  }
  const saved = current.get(input.sourceEventId)
  if (saved && !isDeepStrictEqual({ ...saved, noteId: null }, { ...input, noteId: null })) {
    throw new Error('A saved task publication cannot change its request or authority.')
  }
  if (saved?.noteId && input.noteId !== saved.noteId) {
    throw new Error('A task receipt requires its original pending request.')
  }
  const next = new Map(current)
  next.set(input.sourceEventId, { ...input })
  return next
}

/** The rule only a CLIENT save has to satisfy: a receipt must follow the pending
 *  request it acknowledges. Not part of the fold — an epoch carry re-emitting an
 *  already-acknowledged publication is durable state, not a caller claiming a
 *  receipt for work this journal never recorded asking for. */
export function assertTaskPublicationSave(
  current: ReadonlyMap<string, JournalTaskPublication>,
  input: JournalTaskPublication
): void {
  if (!isJournalTaskPublication(input)) {
    throw new Error('Invalid task publication journal record.')
  }
  if (!current.get(input.sourceEventId) && input.noteId !== null) {
    throw new Error('A task receipt requires its original pending request.')
  }
}
