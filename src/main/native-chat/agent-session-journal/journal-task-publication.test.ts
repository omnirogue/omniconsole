// OmniConsole: hub task publications must survive everything SQLite sheds.
//
// Before upstream #18652 a publication lived in the JSONL snapshot, which was
// rewritten whole on every compaction, so nothing could drop it. SQLite replay
// reads only the LIVE epoch's rows, and BOTH epoch paths (`publishNewEpoch`,
// `replaceJournalEpoch`) DELETE every superseded row. A publication is now an
// append-only `task-publication` row that the epoch controller RE-EMITS into
// each new epoch. That carry is the durability contract this file pins: a lost
// publication means the hub is asked to file a second card for work it already
// has, so every epoch-crossing case below reopens from disk rather than reading
// the live store's memory.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type Database from '../../sqlite/sync-database'
import { openJournalDatabase } from './journal-database'
import { journalDatabaseFile } from './journal-paths'
import * as rowTable from './journal-row-table'
import { parseJournalRow } from './journal-row-schema'
import { createTrackedJournalOpener } from './journal-store-test-open'
import type { JournalTaskPublication } from './journal-task-publication'

const identity: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'folder-1',
  hostId: 'remote-host',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

const sourceEventId = `ide-observation-v1:${'a'.repeat(64)}`
const pending: JournalTaskPublication = {
  sourceEventId,
  taskId: 'btk_12345678',
  principal: 'b'.repeat(64),
  baseUrl: 'https://console.example.com',
  request: JSON.stringify({
    source_event_id: sourceEventId,
    note_kind: 'progress',
    note: 'Checkpoint',
    payload: { summary: 'Checkpoint', done: [], evidence: [] }
  }),
  noteId: null
}

/** A second publication, so ordering and multiplicity of the carry are pinned. */
const secondSourceEventId = `ide-observation-v1:${'e'.repeat(64)}`
const second: JournalTaskPublication = {
  ...pending,
  sourceEventId: secondSourceEventId,
  taskId: 'btk_87654321',
  request: JSON.stringify({
    source_event_id: secondSourceEventId,
    note_kind: 'progress',
    note: 'Second checkpoint',
    payload: { summary: 'Second checkpoint', done: [], evidence: [] }
  })
}

let root: string
let clock = 1_000
const journals = createTrackedJournalOpener()

function tick(): number {
  clock += 1
  return clock
}

const open = () =>
  journals.open({ identity, journalDir: root, now: tick, mintEpoch: () => `epoch-${tick()}` })

async function withJournalDatabase<T>(run: (db: Database.Database) => T): Promise<T> {
  const opened = openJournalDatabase(journalDatabaseFile(root))
  try {
    return run(opened.db)
  } finally {
    opened.db.close()
  }
}

/** The publications on disk, in the order their rows are replayed. Read through
 *  a separate connection: this is the durable state, not the store's memory. */
function storedPublicationRows(): Promise<{ seq: number; publication: JournalTaskPublication }[]> {
  return withJournalDatabase((db) =>
    (
      db.prepare('SELECT seq, row_json FROM journal_rows ORDER BY seq').all() as {
        seq: number
        row_json: string
      }[]
    )
      .map((stored) => ({ seq: stored.seq, parsed: parseJournalRow(stored.row_json) }))
      .flatMap(({ seq, parsed }) =>
        parsed.ok && parsed.row.kind === 'task-publication'
          ? [{ seq, publication: parsed.row.publication }]
          : []
      )
  )
}

function storedPublications(): Promise<JournalTaskPublication[]> {
  return storedPublicationRows().then((rows) => rows.map((row) => row.publication))
}

/** Recover through a real reopen: replay from SQLite is the only thing that can
 *  vouch for the carry. */
async function recovered(): Promise<JournalTaskPublication[]> {
  const reopened = await open()
  return reopened.taskPublications()
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'omni-task-save-'))
  clock = 1_000
})

afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('native task publication in the session journal', () => {
  it('saves durably before returning and recovers the exact record on reopen', async () => {
    const journal = await open()
    await journal.saveTaskPublication(pending, 2)
    // Durable the instant the call resolves — a separate connection sees it.
    expect(await storedPublications()).toEqual([pending])
    expect(await recovered()).toEqual([pending])
  })

  it('keeps the authority and the request body out of the rendered snapshot', async () => {
    const journal = await open()
    await journal.saveTaskPublication(pending, 2)
    const rendered = JSON.stringify(journal.snapshot())
    expect(rendered).not.toContain(pending.principal)
    expect(rendered).not.toContain(pending.request)
    expect(rendered).not.toContain(pending.taskId)
  })

  it('serializes a publication with a concurrent epoch roll', async () => {
    const journal = await open()
    await Promise.all([
      journal.saveTaskPublication(pending, 2),
      journal.rollEpoch('handle_forked', 3)
    ])
    expect(await recovered()).toEqual([pending])
  })

  it('carries saved publications through history replacement and epoch rollover', async () => {
    const journal = await open()
    await journal.saveTaskPublication(pending, 2)
    await journal.replaceEpochItems('handle_forked', 3, [])
    expect(await recovered()).toEqual([pending])
    await journal.rollEpoch('unreconcilable_prefix', 4)
    expect(await recovered()).toEqual([pending])
  })

  it('re-emits the carry as rows of the NEW epoch, not as memory the reopen lacks', async () => {
    const journal = await open()
    await journal.saveTaskPublication(pending, 2)
    await journal.saveTaskPublication(second, 2)
    const before = await storedPublicationRows()
    expect(before.map((row) => row.publication)).toEqual([pending, second])

    await journal.rollEpoch('handle_forked', 3)

    // The roll deleted every superseded row, so these are new rows: they follow
    // the epoch row at sequence 1, in the order the publications were saved.
    const after = await storedPublicationRows()
    expect(after).toEqual([
      { seq: 2, publication: pending },
      { seq: 3, publication: second }
    ])
    expect(await recovered()).toEqual([pending, second])
  })

  it('carries publications across repeated rolls without duplicating them', async () => {
    const journal = await open()
    await journal.saveTaskPublication(pending, 2)
    await journal.rollEpoch('handle_forked', 3)
    await journal.rollEpoch('handle_forked', 4)
    await journal.rollEpoch('unreconcilable_prefix', 5)
    expect(await storedPublications()).toEqual([pending])
    expect(await recovered()).toEqual([pending])
  })

  it('persists acknowledgments and never returns them to pending', async () => {
    const journal = await open()
    await journal.saveTaskPublication(pending, 2)
    const acknowledged = { ...pending, noteId: 'tve_saved' }
    await journal.saveTaskPublication(acknowledged, 2)
    await expect(journal.saveTaskPublication(pending, 2)).rejects.toThrow()
    expect(await recovered()).toEqual([acknowledged])
  })

  it('carries the acknowledged form, not the pending one it superseded', async () => {
    const journal = await open()
    await journal.saveTaskPublication(pending, 2)
    const acknowledged = { ...pending, noteId: 'tve_saved' }
    await journal.saveTaskPublication(acknowledged, 2)
    // The carry emits the FINAL form alone. Applying the save-ordering rule to
    // it would reject durable state and take the roll down with it, which is
    // why that rule lives on the save path and not in the reducer's fold.
    await journal.rollEpoch('handle_forked', 3)
    expect(await storedPublications()).toEqual([acknowledged])
    expect(await recovered()).toEqual([acknowledged])
  })

  it('reopens a journal whose live epoch holds only a carried acknowledgment', async () => {
    const journal = await open()
    await journal.saveTaskPublication(pending, 2)
    await journal.saveTaskPublication({ ...pending, noteId: 'tve_saved' }, 2)
    await journal.rollEpoch('handle_forked', 3)
    await journal.close()
    // Replay folds the carried row with no pending row in front of it; a fold
    // that refused that shape would make the journal unopenable, not just lose
    // the card.
    const reopened = await open()
    expect(reopened.taskPublications()).toEqual([{ ...pending, noteId: 'tve_saved' }])
  })

  it.each([
    { taskId: 'btk_other123' },
    { principal: 'c'.repeat(64) },
    { baseUrl: 'https://different.example.com' },
    { request: pending.request.replace('Checkpoint', 'Changed checkpoint') }
  ])('refuses replacement of the original request or authority: %j', async (changed) => {
    const journal = await open()
    await journal.saveTaskPublication(pending, 2)
    await expect(journal.saveTaskPublication({ ...pending, ...changed }, 2)).rejects.toThrow()
    expect(await storedPublications()).toEqual([pending])
    expect(await recovered()).toEqual([pending])
  })

  it('rejects an acknowledgment without the original durable request', async () => {
    const journal = await open()
    await expect(
      journal.saveTaskPublication({ ...pending, noteId: 'tve_saved' }, 2)
    ).rejects.toThrow()
    expect(journal.taskPublications()).toEqual([])
    expect(await storedPublications()).toEqual([])
  })

  it('refuses a request past the publication bound and stays open for a valid one', async () => {
    // Upstream #18652 dropped the per-session snapshot byte budget along with
    // the snapshot itself; the publication schema's own 32 KiB request bound is
    // what now refuses an oversized record, before anything is journaled.
    const journal = await open()
    const large = { ...pending, request: pending.request.replace('Checkpoint', 'x'.repeat(40_000)) }
    await expect(journal.saveTaskPublication(large, 2)).rejects.toThrow()
    expect(await storedPublications()).toEqual([])
    await journal.saveTaskPublication(pending, 2)
    expect(await recovered()).toEqual([pending])
  })

  it('retains a saved profile binding across a roll and never invents one', async () => {
    const bound = { ...pending, profileKey: 'd'.repeat(64) }
    const journal = await open()
    await journal.saveTaskPublication(bound, 2)
    await journal.rollEpoch('handle_forked', 3)
    expect(await recovered()).toEqual([bound])
  })

  it('refuses a stored publication row this build cannot read, rather than adopting it', async () => {
    const journal = await open()
    await journal.saveTaskPublication(pending, 2)
    const epoch = journal.epoch
    await journal.close()
    await withJournalDatabase((db) => {
      db.prepare('UPDATE journal_rows SET row_json = ? WHERE seq = ?').run(
        JSON.stringify({
          kind: 'task-publication',
          publication: { ...pending, profileKey: 'not-a-digest' },
          v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
          epoch,
          seq: 2,
          fence: 2,
          ts: 1_002
        }),
        2
      )
    })
    const reopened = await open()
    expect(reopened.repair.malformedRows).toBe(1)
    expect(reopened.taskPublications()).toEqual([])
  })

  it('preserves the writer fence across reopen', async () => {
    const journal = await open()
    await journal.saveTaskPublication(pending, 4)
    await journal.close()
    const reopened = await open()
    await expect(
      reopened.saveTaskPublication({ ...pending, noteId: 'tve_saved' }, 3)
    ).rejects.toThrow()
    expect(reopened.taskPublications()).toEqual([pending])
  })

  it('does not half-save a publication whose durable write fails, and takes the retry', async () => {
    const journal = await open()
    const insert = vi.spyOn(rowTable, 'insertJournalRow').mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    await expect(journal.saveTaskPublication(pending, 2)).rejects.toThrow('disk full')
    expect(await storedPublications()).toEqual([])
    insert.mockRestore()
    await journal.saveTaskPublication(pending, 2)
    expect(await recovered()).toEqual([pending])
  })

  it('accepts a repeat of an unacknowledged publication and folds it to one record', async () => {
    // The hub retries a publish whose acknowledgment was lost. The retry is an
    // ordinary append; the fold is what keeps it one publication.
    const journal = await open()
    await journal.saveTaskPublication(pending, 2)
    await journal.saveTaskPublication({ ...pending }, 2)
    expect(await storedPublications()).toEqual([pending, pending])
    expect(await recovered()).toEqual([pending])
  })

  it('isolates caller mutations from what is saved and from what is read back', async () => {
    const journal = await open()
    const input = { ...pending }
    const save = journal.saveTaskPublication(input, 1)
    input.request = 'mutated'
    await Promise.all([save, journal.rollEpoch('handle_forked', 2)])
    const view = journal.taskPublications()
    view[0].request = 'also mutated'
    expect(await recovered()).toEqual([pending])
  })
})
