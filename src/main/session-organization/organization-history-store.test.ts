import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  OrganizationExecutor,
  OrganizationRecord
} from '../../shared/session-organization-change'
import { ORGANIZATION_HISTORY_FILE, OrganizationHistoryStore } from './organization-history-store'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'organization-history-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const PERSON: OrganizationExecutor = { kind: 'person', via: 'sidebar' }
const PANE: OrganizationExecutor = { kind: 'pane', paneKey: 'tab-1:leaf-1', title: 'Ads review' }

let clock = 0
function applied(
  opId: string,
  sessionKeys: string[],
  extra: Partial<OrganizationRecord> = {}
): OrganizationRecord {
  clock += 1
  return {
    opId,
    kind: 'move',
    targets: sessionKeys.map((sessionKey) => ({ sessionKey })),
    value: 'folder-x',
    executor: PERSON,
    phase: 'applied',
    ts: new Date(Date.UTC(2026, 8, 25, 10, 0, clock)).toISOString(),
    revision: opId,
    before: sessionKeys.map(() => null),
    after: sessionKeys.map(() => 'folder-x'),
    ...extra
  }
}

function store(options: { maxBytes?: number; perKey?: number } = {}) {
  const created = new OrganizationHistoryStore({ directory: dir, ...options })
  created.load()
  return created
}

describe('OrganizationHistoryStore', () => {
  it('keeps applied changes per key, newest first, across a restart', async () => {
    const first = store()
    first.add(applied('op-1', ['s1', 's2']))
    first.add(applied('op-2', ['s1']))
    first.add({ ...applied('op-3', ['s1']), phase: 'prepared' })
    await first.flush()

    const reloaded = store()
    expect(reloaded.entriesFor('s1').map((entry) => entry.opId)).toEqual(['op-2', 'op-1'])
    expect(reloaded.entriesFor('s2').map((entry) => entry.opId)).toEqual(['op-1'])
    expect(reloaded.get('op-1')).toMatchObject({ executor: PERSON, before: [null, null] })
    expect(reloaded.has('op-3')).toBe(false)
    expect(reloaded.appliedThrough).toBe(reloaded.get('op-2')!.ts)
  })

  it('rolls each key to its last entries, dropping a record once no key lists it', async () => {
    const history = store({ perKey: 2 })
    history.add(applied('shared', ['s1', 's2']))
    history.add(applied('a', ['s1']))
    history.add(applied('b', ['s1']))
    // Still listed under s2, so the record stays.
    expect(history.entriesFor('s1').map((entry) => entry.opId)).toEqual(['b', 'a'])
    expect(history.has('shared')).toBe(true)
    history.add(applied('c', ['s2']))
    history.add(applied('d', ['s2']))
    expect(history.has('shared')).toBe(false)
  })

  it('records a person’s change as a permanent revocation and a steward’s as ownership', () => {
    const history = store()
    history.add(
      applied('steward', ['s1'], { executor: PANE, after: ['folder-y'], value: 'folder-y' })
    )
    expect(history.stateFor('s1').ownership.placement).toEqual({
      value: 'folder-y',
      revision: 'steward',
      by: 'pane',
      opId: 'steward',
      at: history.get('steward')!.ts
    })
    history.add(applied('mine', ['s1']))
    expect(history.stateFor('s1')).toEqual({
      ownership: {},
      revocations: {
        placement: { at: history.get('mine')!.ts, opId: 'mine', why: 'person/sidebar' }
      }
    })
    // A change a window applied without the revision check claims nothing.
    history.add(applied('old-window', ['s2'], { executor: PANE, revisionUnchecked: true }))
    expect(history.stateFor('s2')).toEqual({ ownership: {}, revocations: {} })
  })

  it('prunes the oldest rolling entries past the size cap, never revocations', async () => {
    const reason = 'x'.repeat(400)
    const history = store({ maxBytes: 3000 })
    history.add(applied('first-mine', ['s1'], { reason }))
    for (let index = 0; index < 20; index += 1) {
      history.add(applied(`op-${index}`, [`k${index}`], { executor: PANE, reason }))
    }
    expect(history.has('first-mine')).toBe(false)
    expect(history.has('op-19')).toBe(true)
    expect(history.entriesFor('s1')).toEqual([])
    expect(history.stateFor('s1').revocations.placement?.opId).toBe('first-mine')
    await history.flush()
    const saved = JSON.parse(readFileSync(join(dir, ORGANIZATION_HISTORY_FILE), 'utf8'))
    expect(JSON.stringify(saved.records).length).toBeLessThanOrEqual(3000)
    expect(saved.records.length).toBeLessThan(21)
    expect(store().stateFor('s1').revocations.placement?.opId).toBe('first-mine')
  })

  it('writes through a temp file and rename, so an interrupted write never replaces history', async () => {
    const history = store()
    history.add(applied('op-1', ['s1']))
    await history.flush()
    expect(readdirSync(dir)).toEqual([ORGANIZATION_HISTORY_FILE])
    // A crash after the temp write but before the rename leaves the previous file whole.
    writeFileSync(join(dir, `${ORGANIZATION_HISTORY_FILE}.999.1.abc.tmp`), '{"version":1,"rec')
    expect(
      store()
        .entriesFor('s1')
        .map((entry) => entry.opId)
    ).toEqual(['op-1'])
  })

  it('starts empty from an unreadable file (the trail refills it) and drops malformed records', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(join(dir, ORGANIZATION_HISTORY_FILE), '{"version":1,"records":[')
    expect(store().entriesFor('s1')).toEqual([])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
    writeFileSync(
      join(dir, ORGANIZATION_HISTORY_FILE),
      JSON.stringify({
        version: 1,
        appliedThrough: null,
        records: [
          { ...applied('good', ['s1']), before: ['only-one', 'extra'] },
          { opId: 'bad', phase: 'applied' }
        ],
        index: { s1: ['good', 'bad'] },
        keys: {}
      })
    )
    const history = store()
    expect(history.entriesFor('s1').map((entry) => entry.opId)).toEqual(['good'])
    // A misaligned per-target array is dropped, never read as a partial one.
    expect(history.get('good')?.before).toBeUndefined()
  })

  it('finds the current revision of one field and filters recent changes', () => {
    const history = store()
    history.add(applied('move-1', ['s1']))
    history.add(applied('archive-1', ['s1'], { kind: 'archive', value: true }))
    expect(history.latestFor('s1', 'placement')?.opId).toBe('move-1')
    expect(history.latestFor('s1', 'archived')?.opId).toBe('archive-1')
    history.add(applied('agent', ['s2'], { executor: PANE }))
    expect(
      history.recent({ since: 0, executors: ['pane'], limit: 10 }).map((entry) => entry.opId)
    ).toEqual(['agent'])
    expect(history.recent({ since: 0, kinds: ['archive'], limit: 10 }).map((e) => e.opId)).toEqual([
      'archive-1'
    ])
    expect(history.recent({ since: 0, limit: 2 }).map((entry) => entry.opId)).toEqual([
      'agent',
      'archive-1'
    ])
  })

  it('creates its directory on first save', async () => {
    const nested = join(dir, 'session-organization')
    const history = new OrganizationHistoryStore({ directory: nested })
    history.load()
    history.add(applied('op-1', ['s1']))
    await history.flush()
    expect(existsSync(join(nested, ORGANIZATION_HISTORY_FILE))).toBe(true)
  })
})
