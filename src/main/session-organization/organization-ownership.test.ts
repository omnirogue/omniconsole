import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  OrganizationChange,
  OrganizationExecutor
} from '../../shared/session-organization-change'
import { SessionActionsLog } from '../session-manage/session-actions-log'
import { OrganizationChangeLedger } from './organization-change-ledger'
import { OrganizationHistoryStore } from './organization-history-store'

let dir: string
let seconds = 0

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'organization-ownership-'))
  seconds = 0
})

const opened: OrganizationChangeLedger[] = []

afterEach(async () => {
  // Why flush first: history.json is written asynchronously and would race the removal.
  await Promise.all(opened.splice(0).map((ledger) => ledger.flush()))
  rmSync(dir, { recursive: true, force: true })
})

const now = () => new Date(Date.UTC(2026, 8, 25, 10, 0, (seconds += 1)))

function openLedger(perKey?: number): OrganizationChangeLedger {
  const store = new OrganizationHistoryStore({
    directory: join(dir, 'session-organization'),
    ...(perKey ? { perKey } : {})
  })
  store.load()
  const ledger = new OrganizationChangeLedger({
    trail: new SessionActionsLog(dir, now),
    store,
    now
  })
  opened.push(ledger)
  return ledger
}

const PERSON: OrganizationExecutor = { kind: 'person', via: 'sidebar' }
const PANE: OrganizationExecutor = { kind: 'pane', paneKey: 'tab-9:leaf-9', title: 'Ads review' }

function move(
  opId: string,
  key: string,
  executor: OrganizationExecutor,
  extra: Partial<OrganizationChange> = {}
): OrganizationChange {
  return {
    opId,
    kind: 'move',
    targets: [{ sessionKey: key }],
    value: 'checkout',
    executor,
    reason: 'the person asked',
    ...extra
  }
}

/** An agent's move, prepared and applied as the window would. */
async function agentMove(ledger: OrganizationChangeLedger, change: OrganizationChange) {
  await ledger.prepare(change)
  return ledger.settle({ phase: 'applied', change, before: ['sales'], after: ['checkout'] })
}

describe('ownership in the session history', () => {
  it('keeps a person’s revocation apart from the rolling history, and no later agent change owns it', async () => {
    const ledger = openLedger(3)
    await agentMove(ledger, move('agent', 's1', PANE))
    await ledger.settle({
      phase: 'applied',
      change: move('mine', 's1', PERSON, { value: 'sales' }),
      before: ['checkout'],
      after: ['sales']
    })
    for (let index = 0; index < 5; index += 1) {
      await agentMove(ledger, move(`later-${index}`, 's1', PANE))
    }
    expect((await ledger.history('s1')).ownership).toEqual({})
    await ledger.flush()
    const history = await openLedger(3).history('s1')
    expect(history.entries.map((entry) => entry.opId)).toEqual(['later-4', 'later-3', 'later-2'])
    expect(history.revocations.placement).toMatchObject({ opId: 'mine', why: 'person/sidebar' })
    expect(history.ownership).toEqual({})
  })

  it('refuses an agent change whose expected revision is stale, before recording anything', async () => {
    const ledger = openLedger()
    await agentMove(ledger, move('agent', 's1', PANE))
    await expect(
      ledger.prepare(move('stale', 's1', PANE, { expectedRevision: 'older' }))
    ).rejects.toThrow("This session's folder changed since revision older (it is at agent)")
    await expect(
      ledger.prepare(move('fresh', 's1', PANE, { expectedRevision: 'agent' }))
    ).resolves.toMatchObject({ opId: 'fresh', phase: 'prepared' })
    await ledger.settle({ phase: 'failed', change: move('fresh', 's1', PANE), error: 'test' })
    await ledger.settle({
      phase: 'applied',
      change: move('mine', 's1', PERSON),
      before: ['checkout'],
      after: ['sales']
    })
    await expect(
      ledger.prepare(move('late', 's1', PANE, { expectedRevision: 'agent' }))
    ).rejects.toThrow("is the person's now (person/sidebar)")
    // Fields without ownership are checked against their newest change.
    await expect(
      ledger.prepare({
        ...move('hide', 's1', PANE, { expectedRevision: 'nothing-yet' }),
        kind: 'archive',
        value: true
      })
    ).rejects.toThrow('This session changed since revision nothing-yet.')
    await ledger.flush()
  })

  it('records another device’s change after it happened and takes ownership back, unless it echoes', async () => {
    const ledger = openLedger()
    await agentMove(ledger, move('agent', 's1', PANE))
    ledger.store.updateOwnership((states) =>
      states.attachSyncStamps([{ key: 's1', field: 'placement', opId: 'agent', stamp: 500 }])
    )
    const synced = (opId: string, stamp: number) =>
      ledger.settle({
        phase: 'applied',
        change: move(opId, 's1', { kind: 'sync', stamp }, { reason: undefined }),
        before: [null],
        after: ['checkout']
      })
    // Our own stamp back (after lost storage): recorded, still ours.
    await expect(synced('echo', 500)).resolves.toMatchObject({ revision: 'sync:500' })
    expect((await ledger.history('s1')).ownership.placement).toMatchObject({ syncStamp: 500 })
    // The same folder under another device's stamp (X → Y → X there): no longer ours.
    await synced('elsewhere', 900)
    const history = await ledger.history('s1')
    expect(history.ownership).toEqual({})
    expect(history.revocations.placement).toMatchObject({ opId: 'elsewhere', why: 'sync/900' })
    await ledger.flush()
  })

  it('folds a pane’s history and ownership onto its provider key, so Undo and history follow it', async () => {
    const ledger = openLedger(3)
    await agentMove(ledger, move('filed', 'pane', { kind: 'launch', source: 'session-prep' }))
    await ledger.settle({
      phase: 'applied',
      change: { ...move('hid', 'pane', PERSON), kind: 'archive', value: true },
      before: [false],
      after: [true]
    })
    await ledger.settle({
      phase: 'applied',
      change: move('old', 'provider', PERSON, { value: 'sales' }),
      before: [null],
      after: ['sales']
    })
    expect(ledger.store.migrateKey('pane', 'provider', true)).toBe(true)
    await ledger.flush()
    const reopened = openLedger(3)
    const history = await reopened.history('provider')
    expect(history.entries.map((entry) => entry.opId)).toEqual(['old', 'hid', 'filed'])
    expect(history.entries[0]!.targets).toEqual([{ sessionKey: 'provider' }])
    // The provider key's own earlier placement was the person's, so it stays theirs.
    expect(history.ownership).toEqual({})
    expect(history.revocations.placement).toMatchObject({ opId: 'old' })
    expect((await reopened.history('pane')).entries).toEqual([])
    const plan = await reopened.undoPlan('hid')
    expect(plan.inverse).toMatchObject({ kind: 'unarchive', targets: [{ sessionKey: 'provider' }] })
    // Idempotent: nothing is left under the pane key.
    expect(reopened.store.migrateKey('pane', 'provider', true)).toBe(false)
  })

  it('carries a launch filing’s ownership to a provider key that held nothing', async () => {
    const ledger = openLedger()
    await agentMove(ledger, move('filed', 'pane', { kind: 'launch', source: 'session-prep' }))
    ledger.store.migrateKey('pane', 'provider', true)
    expect((await ledger.history('provider')).ownership.placement).toMatchObject({
      opId: 'filed',
      value: 'checkout'
    })
    await ledger.flush()
  })
})
