import { describe, expect, it } from 'vitest'
import type { OrganizationRecord, OrganizationUndoPlan } from './session-organization-change'
import {
  foldHostOrganizationRecord,
  hostOrganizationAfter,
  hostOrganizationRevision,
  HOST_ORGANIZATION_NO_REVISION,
  readHostOrganizationValue,
  type HostOrganizationEntry
} from './session-organization-host'
import { selectOrganizationUndo } from './session-organization-undo-plan'
import {
  hostHistoryEntries,
  hostOwnershipEntries,
  hostSyncOpId,
  pendingHostIntents
} from './session-organization-host-sync'

const FOLDER = '00000000-0000-4000-8000-000000000001'

function record(
  opId: string,
  ts: string,
  change: Pick<OrganizationRecord, 'kind' | 'targets' | 'value'> & Partial<OrganizationRecord>
): OrganizationRecord {
  return {
    opId,
    executor: { kind: 'pane', paneKey: 'tab-1:leaf-1', title: 'Steward' },
    phase: 'applied',
    ts,
    revision: opId,
    ...change
  }
}

function foldAll(records: OrganizationRecord[]): Map<string, HostOrganizationEntry> {
  const entries = new Map<string, HostOrganizationEntry>()
  for (const next of records) {
    for (const [key, entry] of foldHostOrganizationRecord(next, (k) => entries.get(k))) {
      entries.set(key, entry)
    }
  }
  return entries
}

describe('host organization values', () => {
  it('fold every session kind from applied records, with a revision per field and overall', () => {
    const entries = foldAll([
      record('m', '2026-09-26T09:00:01.000Z', {
        kind: 'move',
        targets: [{ sessionKey: 'a' }, { sessionKey: 'b' }],
        value: FOLDER,
        after: [FOLDER, FOLDER]
      }),
      record('t', '2026-09-26T09:00:02.000Z', {
        kind: 'tag',
        targets: [{ sessionKey: 'a' }],
        value: 'omnirogue',
        after: [true]
      }),
      record('h', '2026-09-26T09:00:03.000Z', {
        kind: 'hide',
        targets: [{ sessionKey: 'a' }],
        value: true
      }),
      record('n', '2026-09-26T09:00:04.000Z', {
        kind: 'title',
        targets: [{ sessionKey: 'a', tabId: 'tab-1' }],
        value: 'Plan',
        origin: 'generated'
      }),
      record('f', '2026-09-26T09:00:05.000Z', {
        kind: 'folder.rename',
        targets: [{ folderId: FOLDER }],
        value: 'Renamed'
      })
    ])
    expect(entries.get('a')).toMatchObject({
      values: {
        placement: FOLDER,
        tags: ['omnirogue'],
        hidden: true,
        title: 'Plan',
        titleOrigin: 'generated'
      },
      revisions: { placement: 'm', tags: 't', hidden: 'h', title: 'n' },
      revision: 'n'
    })
    expect(entries.get('b')!.revision).toBe('m')
    expect(entries.has(`folder:${FOLDER}`)).toBe(false)
    expect(hostOrganizationRevision(undefined)).toBe(HOST_ORGANIZATION_NO_REVISION)
  })

  it('is idempotent, and an older record replayed late never overwrites a newer value', () => {
    const newer = record('new', '2026-09-26T09:00:05.000Z', {
      kind: 'move',
      targets: [{ sessionKey: 'a' }],
      value: null,
      after: [null]
    })
    const older = record('old', '2026-09-26T09:00:01.000Z', {
      kind: 'move',
      targets: [{ sessionKey: 'a' }],
      value: FOLDER,
      after: [FOLDER]
    })
    const entries = foldAll([newer, older, newer])
    expect(entries.get('a')).toMatchObject({
      values: { placement: null },
      revisions: { placement: 'new' },
      revision: 'new'
    })
  })

  it('folds a window’s delete and its undo into a stamped deleted value (session parity, F4)', () => {
    const deleted = record('del', '2026-09-26T09:00:01.000Z', {
      kind: 'delete',
      targets: [{ sessionKey: 'a' }, { sessionKey: 'b' }],
      value: true,
      executor: { kind: 'person', via: 'sidebar' },
      after: [true, true]
    })
    const undone = record('undo', '2026-09-26T09:00:02.000Z', {
      kind: 'delete',
      targets: [{ sessionKey: 'b' }],
      value: false,
      executor: { kind: 'person', via: 'notice' },
      undoOf: 'del'
    })
    const entries = foldAll([deleted, undone, deleted])
    expect(entries.get('a')).toMatchObject({
      values: { deleted: true },
      revisions: { deleted: 'del' },
      stamps: { deleted: '2026-09-26T09:00:01.000Z' }
    })
    // The undo derives its value from the record when it carries no `after`; a late replay loses.
    expect(entries.get('b')).toMatchObject({
      values: { deleted: false },
      revisions: { deleted: 'undo' },
      stamps: { deleted: '2026-09-26T09:00:02.000Z' }
    })
  })

  it('reads and applies the way the window does', () => {
    const entry: HostOrganizationEntry = {
      values: { tags: ['x'], snooze: 1_000, archived: true },
      revisions: {}
    }
    expect(readHostOrganizationValue('tag', entry, 'x', 0)).toBe(true)
    expect(readHostOrganizationValue('untag', entry, 'y', 0)).toBe(false)
    expect(readHostOrganizationValue('snooze', entry, null, 500)).toBe(1_000)
    expect(readHostOrganizationValue('snooze', entry, null, 5_000)).toBeNull()
    expect(readHostOrganizationValue('unarchive', entry, false, 0)).toBe(true)
    expect(hostOrganizationAfter('archive', 'anything')).toEqual({ ok: true, after: true })
    expect(hostOrganizationAfter('title', '   ')).toEqual({ ok: true, after: null })
    expect(hostOrganizationAfter('move', 42)).toMatchObject({ ok: false })
    expect(hostOrganizationAfter('tag', '')).toMatchObject({ ok: false })
    expect(hostOrganizationAfter('snooze', Number.NaN)).toMatchObject({ ok: false })
  })

  it('undoes only targets that still hold what the change left', () => {
    const plan: OrganizationUndoPlan = {
      opId: 'm',
      inverse: {
        kind: 'move',
        targets: [{ sessionKey: 'a' }, { sessionKey: 'b' }],
        value: null,
        undoOf: 'm',
        expectedRevision: 'm'
      },
      targets: [
        { target: { sessionKey: 'a' }, status: 'undo', expected: FOLDER },
        { target: { sessionKey: 'b' }, status: 'undo', expected: FOLDER },
        { target: { sessionKey: 'c' }, status: 'changed-since', laterOpId: 'p' }
      ],
      partial: true
    }
    const held: Record<string, unknown> = { a: FOLDER, b: 'elsewhere' }
    const selection = selectOrganizationUndo(
      plan,
      (_kind, target) => ({ known: true, value: held[target.sessionKey!] }),
      'changed here'
    )
    expect(selection.change).toMatchObject({
      targets: [{ sessionKey: 'a' }],
      value: null,
      undoOf: 'm'
    })
    expect(selection).toMatchObject({ kept: 1, total: 3 })
    expect(
      selection.skipped.map((entry) => [entry.target.sessionKey, entry.detail ?? null])
    ).toEqual([
      ['c', null],
      ['b', 'changed here']
    ])
  })
})

describe('host organization as sync entries', () => {
  it('writes one history row per target it can name, and ownership with revocations', () => {
    const moved = record('m', '2026-09-26T09:00:01.000Z', {
      kind: 'move',
      targets: [{ sessionKey: 'a' }, { sessionKey: 'local-only' }, { sessionKey: 'b' }],
      value: FOLDER,
      after: [FOLDER, FOLDER, FOLDER],
      reason: 'file the review'
    })
    const digests: Record<string, string> = { a: 'a'.repeat(24), b: 'b'.repeat(24) }
    const rows = hostHistoryEntries(
      moved,
      (key) => digests[key],
      (index) => moved.targets[index]!.sessionKey!
    )
    expect(rows.map((row) => [row.s, row.op, row.v, row.sum])).toEqual([
      ['a'.repeat(24), hostSyncOpId('m', 0, 3), FOLDER, 'file the review'],
      ['b'.repeat(24), 'm#2', FOLDER, 'file the review']
    ])
    expect(hostSyncOpId('m', 0, 1)).toBe('m')
    const entries = hostOwnershipEntries('a'.repeat(24), {
      ownership: {
        placement: { value: FOLDER, revision: 'm', by: 'pane', opId: 'm', at: moved.ts }
      },
      revocations: { title: { at: moved.ts, opId: 'p', why: 'person/sidebar' } }
    })
    expect(entries.map((entry) => entry.k)).toEqual(['own', 'rev'])
  })

  it('lists another computer’s intents until this host answers them', () => {
    const s = 'c'.repeat(24)
    const intents = pendingHostIntents([
      { k: 'int', s, op: 'x', ch: 'move', at: 1 },
      { k: 'int', s, op: 'y', ch: 'move', at: 2 },
      { k: 'hist', s, op: 'y', ch: 'move', by: 'person/sidebar', at: 3 }
    ])
    expect(intents.map((intent) => intent.op)).toEqual(['x'])
  })
})
