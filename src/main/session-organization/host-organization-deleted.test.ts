import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrganizationChange } from '../../shared/session-organization-change'
import {
  ORGANIZATION_HISTORY_DIRECTORY,
  ORGANIZATION_HISTORY_FILE
} from './organization-history-store'
import { HOST_ORGANIZATION_VIEW_FILE } from './host-organization-view'
import {
  HOST_PERSON,
  hostTestClock,
  openTestHost,
  SYNCED_KEY,
  type OpenedHost
} from './host-organization-test-host'

let dir: string
let clock: ReturnType<typeof hostTestClock>
let opened: OpenedHost

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'host-organization-deleted-'))
  clock = hostTestClock()
  opened = openTestHost(dir, clock)
})

afterEach(async () => {
  await opened.host.flush()
  rmSync(dir, { recursive: true, force: true })
})

/** The window's Delete (or its Undo): applied there first, then recorded in main's ledger. */
async function windowDeletes(opId: string, key: string, deleted: boolean, undoOf?: string) {
  const change: OrganizationChange = {
    opId,
    kind: 'delete',
    targets: [{ sessionKey: key }],
    value: deleted,
    executor: undoOf ? { kind: 'person', via: 'notice' } : HOST_PERSON,
    ...(undoOf ? { undoOf } : {})
  }
  await opened.ledger.settle({ phase: 'applied', change, before: [!deleted], after: [deleted] })
}

async function reopen(): Promise<void> {
  await opened.host.flush()
  opened = openTestHost(dir, clock)
  await opened.host.ready
}

describe('the durable deleted value (session parity, F4/F5)', () => {
  it('keeps a person’s delete with its stamp beyond the history log, and its undo clears it', async () => {
    await opened.host.ready
    await windowDeletes('del-1', SYNCED_KEY, true)
    const deletedAt = opened.view.entry(SYNCED_KEY)?.stamps?.deleted
    expect(opened.view.entry(SYNCED_KEY)).toMatchObject({
      values: { deleted: true },
      revisions: { deleted: 'del-1' }
    })
    expect(deletedAt).toEqual(expect.any(String))

    // Why remove history and trail: the host values alone must carry the current state.
    await opened.host.flush()
    rmSync(join(dir, ORGANIZATION_HISTORY_DIRECTORY, ORGANIZATION_HISTORY_FILE), { force: true })
    rmSync(join(dir, 'session-actions.jsonl'), { force: true })
    await reopen()
    expect(opened.view.entry(SYNCED_KEY)).toMatchObject({
      values: { deleted: true },
      stamps: { deleted: deletedAt }
    })
    expect(opened.host.read([SYNCED_KEY]).sessions[0]!.values.deleted).toBe(true)

    await windowDeletes('undo-1', SYNCED_KEY, false, 'del-1')
    const entry = opened.view.entry(SYNCED_KEY)
    expect(entry?.values.deleted).toBe(false)
    expect(entry?.stamps?.deleted && deletedAt && entry.stamps.deleted > deletedAt).toBe(true)
  })

  it('seeds the window’s existing deletion marks, recording nothing for an unrecorded false', async () => {
    const result = await opened.host.migrate({
      entries: [
        { key: 'gone', values: { deleted: true } },
        { key: 'kept', values: { deleted: false } },
        { key: 'filed', values: { archived: true } }
      ]
    })
    expect(result.drifted).toEqual([])
    expect(opened.view.entry('gone')).toMatchObject({
      values: { deleted: true },
      revisions: { deleted: expect.stringMatching(/^migrated:/) },
      stamps: { deleted: expect.any(String) }
    })
    expect(opened.view.entry('kept')).toBeUndefined()
    expect(opened.view.entry('filed')?.values).toEqual({ archived: true })
  })

  it('puts the window’s mark back as a restore where this host recorded another value', async () => {
    await opened.host.ready
    await windowDeletes('del-1', SYNCED_KEY, true)
    const result = await opened.host.migrate({
      entries: [{ key: SYNCED_KEY, values: { deleted: false } }]
    })
    expect(result.drifted).toEqual([{ key: SYNCED_KEY, field: 'deleted', opId: 'op-1' }])
    expect(opened.view.entry(SYNCED_KEY)?.values.deleted).toBe(false)
    expect(opened.ledger.store.get('op-1')).toMatchObject({
      kind: 'delete',
      value: false,
      executor: { kind: 'app', feature: 'restore' },
      phase: 'applied'
    })
  })

  /** host-values.json as an older build leaves it: appliedThrough past every delete, no watermark. */
  async function rewriteAsOlderBuild(entries: Record<string, unknown>): Promise<string> {
    await opened.host.flush()
    const path = join(dir, ORGANIZATION_HISTORY_DIRECTORY, HOST_ORGANIZATION_VIEW_FILE)
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        appliedThrough: new Date(clock.peek() + 60_000).toISOString(),
        migratedAt: '2026-09-20T09:00:00.000Z',
        entries,
        unadopted: [],
        adopted: []
      })
    )
    await reopen()
    return path
  }

  it('folds the retained deletes an older build passed, starting from a file without the watermark', async () => {
    await opened.host.ready
    await windowDeletes('del-1', SYNCED_KEY, true)

    const path = await rewriteAsOlderBuild({})

    expect(opened.view.entry(SYNCED_KEY)?.values.deleted).toBe(true)
    await opened.host.flush()
    const file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    expect(file.deletedThrough).toEqual(expect.any(String))
    expect(file.deletedThrough).toBe(file.appliedThrough)
  })

  it('catches up a delete and its undo an older build recorded after a downgrade', async () => {
    await opened.host.ready
    await windowDeletes('del-1', SYNCED_KEY, true)
    const deletedAt = opened.view.entry(SYNCED_KEY)!.stamps!.deleted!
    await windowDeletes('undo-1', SYNCED_KEY, false, 'del-1')

    // The older build kept the value from before the downgrade and folded neither record.
    await rewriteAsOlderBuild({
      [SYNCED_KEY]: {
        values: { deleted: true },
        revisions: { deleted: 'del-1' },
        stamps: { deleted: deletedAt }
      }
    })

    expect(opened.view.entry(SYNCED_KEY)).toMatchObject({
      values: { deleted: false },
      revisions: { deleted: 'undo-1' }
    })
  })

  it('reads a host-values file written before the field existed as not deleted', async () => {
    const directory = join(dir, ORGANIZATION_HISTORY_DIRECTORY)
    mkdirSync(directory, { recursive: true })
    writeFileSync(
      join(directory, HOST_ORGANIZATION_VIEW_FILE),
      JSON.stringify({
        version: 1,
        appliedThrough: '2026-09-20T09:00:00.000Z',
        migratedAt: '2026-09-20T09:00:00.000Z',
        entries: {
          old: {
            values: { archived: true },
            revisions: { archived: 'a-1' },
            stamps: { archived: '2026-09-20T09:00:00.000Z' }
          }
        },
        unadopted: [],
        adopted: []
      })
    )
    await reopen()
    expect(opened.view.entry('old')?.values).toEqual({ archived: true })
    expect(opened.host.read(['old']).sessions[0]!.values).toMatchObject({
      archived: true,
      deleted: false
    })
  })
})
