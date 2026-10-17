// OmniConsole: carrying saved hub task publications across an epoch boundary.
//
// Upstream #18652 replaced the JSONL snapshot with SQLite replay of the LIVE
// epoch's rows, and both epoch rollover and history replacement delete every
// superseded row. A publication that only existed in the old epoch would be
// silently lost — and the hub would then be asked to create a second card for
// work it already has. So the saved set is re-emitted as rows in the new epoch,
// in the same transaction that publishes it.

import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import type { JournalRow } from './journal-row-schema'
import type { JournalTaskPublication } from './journal-task-publication-schema'

export function carriedTaskPublicationRows(
  publications: readonly JournalTaskPublication[],
  epoch: string,
  fence: number,
  ts: number
): JournalRow[] {
  return publications.map((publication, index) => ({
    kind: 'task-publication',
    publication: { ...publication },
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch,
    // The epoch row is always sequence 1; carried rows follow it directly.
    seq: index + 2,
    fence,
    ts
  }))
}
