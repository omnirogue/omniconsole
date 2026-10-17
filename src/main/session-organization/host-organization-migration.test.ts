import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  FOLDER_ONE,
  FOLDER_TWO,
  HOST_AGENT,
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
  dir = mkdtempSync(join(tmpdir(), 'host-organization-migrate-'))
  clock = hostTestClock()
  opened = openTestHost(dir, clock)
})

afterEach(async () => {
  await opened.host.flush()
  rmSync(dir, { recursive: true, force: true })
})

const move = (key: string, folder: string | null) => ({
  kind: 'move' as const,
  targets: [{ sessionKey: key }],
  value: folder,
  executor: HOST_AGENT,
  reason: 'file the review'
})

const stateOf = (key: string) => opened.host.read([key]).sessions[0]!.ownership

describe('migrating existing values and provenance before automation', () => {
  it("marks every placement and title of unknown provenance as the person's, and nothing else", async () => {
    opened.ledger.store.updateOwnership((states) =>
      states.seed(
        [
          { key: 'launched', value: FOLDER_TWO, batchId: 'batch-1', at: '2026-09-20T09:00:00.000Z' }
        ],
        () => false
      )
    )
    const result = await opened.host.migrate({
      entries: [
        { key: 'filed', values: { placement: FOLDER_ONE, title: 'Q3 plan', titleOrigin: 'yours' } },
        {
          key: 'named',
          values: { placement: null, title: 'Refund triage', titleOrigin: 'generated' }
        },
        { key: 'unfiled', values: { placement: null, archived: true, tags: ['omnirogue'] } },
        { key: 'launched', values: { placement: FOLDER_TWO } }
      ],
      complete: true
    })
    expect(result.migratedAt).not.toBeNull()
    expect(result.personOwned).toEqual([
      { key: 'filed', field: 'placement' },
      { key: 'filed', field: 'title' }
    ])
    expect(stateOf('filed')).toEqual({
      ownership: {},
      revocations: {
        placement: expect.objectContaining({ why: 'migration/unknown' }),
        title: expect.objectContaining({ why: 'migration/unknown' })
      }
    })
    // A generated title and an empty placement are not the person's; nor is a known launch filing.
    expect(stateOf('named')).toEqual({ ownership: {}, revocations: {} })
    expect(stateOf('unfiled')).toEqual({ ownership: {}, revocations: {} })
    expect(stateOf('launched').ownership.placement).toMatchObject({
      by: 'launch',
      value: FOLDER_TWO
    })
    expect(opened.host.read(['unfiled']).sessions[0]!.values).toMatchObject({
      placement: null,
      archived: true,
      tags: ['omnirogue']
    })

    // Automation is admitted now, but never over a placement that is the person's.
    const steward = await opened.host.apply({ ...move('filed', FOLDER_TWO), expectedRevision: 'x' })
    expect(steward).toMatchObject({ status: 'refused', refusal: { code: 'ownership-conflict' } })
    expect((await opened.host.apply(move('unfiled', FOLDER_ONE))).status).toBe('applied')
  })

  it('takes a value the window holds but this host never recorded as a restore, revoking the agent', async () => {
    await opened.host.migrate({ entries: [], complete: true })
    const owned = await opened.host.apply(move('a', FOLDER_ONE))
    expect(stateOf('a').ownership.placement?.revision).toBe(owned.opId)

    const same = await opened.host.migrate({
      entries: [{ key: 'a', values: { placement: FOLDER_ONE } }]
    })
    expect(same.drifted).toEqual([])
    expect(stateOf('a').ownership.placement).toBeDefined()

    const drifted = await opened.host.migrate({
      entries: [{ key: 'a', values: { placement: FOLDER_TWO, snooze: null, tags: [] } }]
    })
    expect(drifted.drifted).toEqual([{ key: 'a', field: 'placement', opId: expect.any(String) }])
    expect(opened.host.read(['a']).sessions[0]!.values.placement).toBe(FOLDER_TWO)
    expect(stateOf('a')).toEqual({
      ownership: {},
      revocations: { placement: expect.objectContaining({ why: 'app/restore' }) }
    })
    const [restore] = (await opened.host.history('a')).entries
    expect(restore).toMatchObject({
      kind: 'move',
      executor: { kind: 'app', feature: 'restore' },
      before: [FOLDER_ONE],
      after: [FOLDER_TWO]
    })
  })
})

describe('what migration tells other computers', () => {
  it('nothing: a missing provenance is this computer’s inference, while a person’s edit is published', async () => {
    await opened.host.migrate({
      entries: [{ key: SYNCED_KEY, values: { placement: FOLDER_ONE } }],
      complete: true
    })
    expect(stateOf(SYNCED_KEY).revocations.placement?.why).toBe('migration/unknown')
    const published = () =>
      opened.outbox.pending().map((item) => item.entry as { k: string; why?: string })
    expect(published().filter((entry) => entry.k === 'rev')).toEqual([])

    await opened.host.apply({ ...move(SYNCED_KEY, FOLDER_TWO), executor: HOST_PERSON })
    expect(published().filter((entry) => entry.k === 'rev')).toEqual([
      expect.objectContaining({ why: 'person/sidebar' })
    ])
  })
})

describe('a window adopting headless changes', () => {
  it('hands out each headless change once; where the window differs, its value wins as a restore', async () => {
    await opened.host.migrate({ entries: [], complete: true })
    const kept = await opened.host.apply(move('a', FOLDER_ONE))
    const differs = await opened.host.apply({
      kind: 'hide',
      targets: [{ sessionKey: 'b' }],
      value: true,
      executor: HOST_AGENT,
      reason: 'parked'
    })
    expect((await opened.host.pendingAdoption()).map((record) => record.opId)).toEqual([
      kept.opId,
      differs.opId
    ])
    const { restored } = await opened.host.settleAdoption({
      adopted: [kept.opId],
      conflicts: [{ opId: differs.opId, key: 'b', value: false }]
    })
    expect(restored).toHaveLength(1)
    expect(await opened.host.pendingAdoption()).toEqual([])
    expect(opened.host.read(['b']).sessions[0]!.values.hidden).toBe(false)
    expect((await opened.host.history('b')).entries[0]).toMatchObject({
      kind: 'unhide',
      executor: { kind: 'app', feature: 'restore' },
      before: [true],
      after: [false]
    })
  })
})
