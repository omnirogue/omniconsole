import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  OrganizationChange,
  OrganizationExecutor,
  OrganizationRecord
} from '../../shared/session-organization-change'
import { SESSION_ACTIONS_FILE, SessionActionsLog } from '../session-manage/session-actions-log'
import { OrganizationChangeLedger } from './organization-change-ledger'
import { ORGANIZATION_HISTORY_FILE, OrganizationHistoryStore } from './organization-history-store'
import { organizationTrailLine } from './organization-trail'

let dir: string
let seconds = 0

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'organization-ledger-'))
  seconds = 0
})

const opened: OrganizationChangeLedger[] = []

afterEach(async () => {
  // Why flush first: history.json is written asynchronously and would race the removal.
  await Promise.all(opened.splice(0).map((ledger) => ledger.flush()))
  rmSync(dir, { recursive: true, force: true })
})

const now = () => new Date(Date.UTC(2026, 8, 25, 10, 0, (seconds += 1)))

/** A fresh process on the same profile directory: history reloaded, trail re-read. */
function openLedger(): OrganizationChangeLedger {
  const store = new OrganizationHistoryStore({ directory: join(dir, 'session-organization') })
  store.load()
  const ledger = new OrganizationChangeLedger({
    trail: new SessionActionsLog(dir, now),
    store,
    now
  })
  opened.push(ledger)
  return ledger
}

function trail(): Record<string, unknown>[] {
  return readFileSync(join(dir, SESSION_ACTIONS_FILE), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

const SIDEBAR: OrganizationExecutor = { kind: 'person', via: 'sidebar' }
const PANE: OrganizationExecutor = { kind: 'pane', paneKey: 'tab-9:leaf-9', title: 'Ads review' }

function move(
  opId: string,
  keys: string[],
  executor: OrganizationExecutor,
  value: unknown
): OrganizationChange {
  return {
    opId,
    kind: 'move',
    targets: keys.map((sessionKey) => ({ sessionKey })),
    value,
    executor
  }
}

describe('OrganizationChangeLedger', () => {
  it('records a sidebar drag as one applied entry by the person, with a revocation', async () => {
    const ledger = openLedger()
    const settled = await ledger.settle({
      phase: 'applied',
      change: move('drag-1', ['s1', 's2'], SIDEBAR, 'checkout'),
      before: [null, 'sales'],
      after: ['checkout', 'checkout']
    })
    expect(settled.revision).toBe('drag-1')
    const history = await ledger.history('s2')
    expect(history.entries).toEqual([
      expect.objectContaining({
        opId: 'drag-1',
        phase: 'applied',
        executor: SIDEBAR,
        before: [null, 'sales'],
        after: ['checkout', 'checkout'],
        revision: 'drag-1'
      })
    ])
    expect(history.revocations.placement).toMatchObject({ opId: 'drag-1', why: 'person/sidebar' })
    expect(history.ownership).toEqual({})
    // A person's change is one applied line: no prepared line, nothing to reconcile.
    expect(trail()).toEqual([
      expect.objectContaining({
        actor: 'person',
        action: 'session.move',
        opId: 'drag-1',
        phase: 'applied',
        executor: SIDEBAR,
        organization: expect.objectContaining({ kind: 'move', value: 'checkout' })
      })
    ])
  })

  it('records an agent change prepared, then applied with ownership', async () => {
    const ledger = openLedger()
    const change = { ...move('agent-1', ['s1'], PANE, 'checkout'), reason: 'matches the brief' }
    await ledger.prepare(change, { before: ['sales'] })
    expect(trail().map((line) => line.phase)).toEqual(['prepared'])
    await ledger.settle({ phase: 'applied', change, after: ['checkout'] })
    expect(trail().map((line) => [line.phase, line.opId, line.reason])).toEqual([
      ['prepared', 'agent-1', 'matches the brief'],
      ['applied', 'agent-1', 'matches the brief']
    ])
    const history = await ledger.history('s1')
    expect(history.entries[0]).toMatchObject({ before: ['sales'], after: ['checkout'] })
    expect(history.ownership.placement).toMatchObject({
      value: 'checkout',
      revision: 'agent-1',
      by: 'pane'
    })
  })

  it('refuses a change it could not record first, a person’s prepare, and a stranger’s settle', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    writeFileSync(join(dir, 'blocked'), '')
    const store = new OrganizationHistoryStore({ directory: join(dir, 'history') })
    const blocked = new OrganizationChangeLedger({
      trail: new SessionActionsLog(join(dir, 'blocked'), now),
      store
    })
    opened.push(blocked)
    await expect(blocked.prepare(move('op', ['s1'], PANE, 'x'))).rejects.toThrow(/^Nothing changed/)
    await expect(
      blocked.settle({ phase: 'applied', change: move('op', ['s1'], PANE, 'x') })
    ).rejects.toThrow('No prepared change op')
    error.mockRestore()
    const ledger = openLedger()
    await expect(ledger.prepare(move('p', ['s1'], SIDEBAR, 'x'))).rejects.toThrow('never prepared')
    await ledger.settle({ phase: 'applied', change: move('dup', ['s1'], SIDEBAR, 'x') })
    await expect(
      ledger.settle({ phase: 'applied', change: move('dup', ['s1'], SIDEBAR, 'x') })
    ).rejects.toThrow('already recorded')
  })

  it('rebuilds history from the trail when a crash hit between the trail line and history.json', async () => {
    const first = openLedger()
    await first.settle({
      phase: 'applied',
      change: move('kept', ['s1'], SIDEBAR, 'a'),
      before: [null],
      after: ['a']
    })
    await first.flush()
    const saved = readFileSync(join(dir, 'session-organization', ORGANIZATION_HISTORY_FILE), 'utf8')
    await first.settle({
      phase: 'applied',
      change: move('lost', ['s1'], SIDEBAR, 'b'),
      before: ['a'],
      after: ['b']
    })
    await first.flush()
    // The trail line of `lost` was written; history.json is put back as it was before its update.
    writeFileSync(join(dir, 'session-organization', ORGANIZATION_HISTORY_FILE), saved)
    const restarted = openLedger()
    expect((await restarted.history('s1')).entries.map((entry) => entry.opId)).toEqual([
      'lost',
      'kept'
    ])
  })

  it('does not resurrect entries history pruned, which the trail still holds', async () => {
    const old: OrganizationRecord = {
      ...move('pruned', ['s1'], SIDEBAR, 'a'),
      phase: 'applied',
      ts: '2026-09-01T00:00:00.000Z',
      revision: 'pruned'
    }
    appendFileSync(
      join(dir, SESSION_ACTIONS_FILE),
      `${JSON.stringify(organizationTrailLine(old))}\n`
    )
    const store = new OrganizationHistoryStore({ directory: join(dir, 'session-organization') })
    store.load()
    store.add({ ...old, opId: 'newer', ts: '2026-09-20T00:00:00.000Z', revision: 'newer' })
    await store.flush()
    expect((await openLedger().history('s1')).entries.map((entry) => entry.opId)).toEqual(['newer'])
  })

  it('holds a prepared change with no terminal line as pending: no Undo, no ownership, no new agent change', async () => {
    const crashed = openLedger()
    await crashed.prepare(move('crash-1', ['s1'], PANE, 'checkout'), { before: ['sales'] })
    await crashed.flush()
    const restarted = openLedger()
    await restarted.ready
    expect(restarted.pending().map((record) => record.opId)).toEqual(['crash-1'])
    const history = await restarted.history('s1')
    expect(history.pending.map((record) => record.opId)).toEqual(['crash-1'])
    expect(history.entries).toEqual([])
    expect(history.ownership).toEqual({})
    await expect(restarted.undoPlan('crash-1')).rejects.toThrow('not reconciled yet')
    await expect(restarted.prepare(move('next', ['s1'], PANE, 'other'))).rejects.toThrow(
      /crash-1\) was interrupted/
    )
  })

  it('plans Undo after a restart: unchanged targets go back, changed-since ones are reported', async () => {
    const first = openLedger()
    await first.settle({
      phase: 'applied',
      change: move('batch', ['s1', 's2', 's3'], SIDEBAR, 'checkout'),
      before: ['sales', null, 'sales'],
      after: ['checkout', 'checkout', 'checkout']
    })
    await first.settle({
      phase: 'applied',
      change: move('later', ['s2'], SIDEBAR, 'ops'),
      before: ['checkout'],
      after: ['ops']
    })
    // An archive touches another field: s3's placement is still the batch's.
    await first.settle({
      phase: 'applied',
      change: {
        opId: 'arch',
        kind: 'archive',
        targets: [{ sessionKey: 's3' }],
        value: true,
        executor: SIDEBAR
      },
      before: [false],
      after: [true]
    })
    await first.flush()
    const plan = await openLedger().undoPlan('batch')
    expect(plan.partial).toBe(true)
    expect(plan.targets).toEqual([
      { target: { sessionKey: 's1' }, status: 'undo', expected: 'checkout' },
      { target: { sessionKey: 's2' }, status: 'changed-since', laterOpId: 'later' },
      { target: { sessionKey: 's3' }, status: 'undo', expected: 'checkout' }
    ])
    expect(plan.inverse).toEqual({
      kind: 'move',
      targets: [{ sessionKey: 's1' }, { sessionKey: 's3' }],
      value: 'sales',
      undoOf: 'batch',
      expectedRevision: 'batch'
    })
  })

  it('gives an inverse per-target values when the targets came from different places', async () => {
    const ledger = openLedger()
    await ledger.settle({
      phase: 'applied',
      change: move('spread', ['s1', 's2'], SIDEBAR, 'checkout'),
      before: ['sales', null],
      after: ['checkout', 'checkout']
    })
    const plan = await ledger.undoPlan('spread')
    expect(plan.partial).toBe(false)
    expect(plan.inverse?.values).toEqual(['sales', null])
    await expect(ledger.undoPlan('missing')).rejects.toThrow('No applied change missing')
  })

  it('records, replays and plans Undo for tags, hides and snoozes', async () => {
    const first = openLedger()
    const tag = (opId: string, keys: string[]): OrganizationChange => ({
      opId,
      kind: 'tag',
      targets: keys.map((sessionKey) => ({ sessionKey })),
      value: 'urgent',
      executor: PANE,
      reason: 'the person flagged these'
    })
    await first.prepare(tag('tag-1', ['s1', 's2']))
    await first.settle({
      phase: 'applied',
      change: tag('tag-1', ['s1', 's2']),
      before: [false, true],
      after: [true, true]
    })
    await first.settle({
      phase: 'applied',
      change: {
        opId: 'nap',
        kind: 'snooze',
        targets: [{ sessionKey: 's1' }],
        value: 1_790_000_000_000,
        executor: SIDEBAR
      },
      before: [null],
      after: [1_790_000_000_000]
    })
    await first.settle({
      phase: 'applied',
      change: {
        opId: 'hid',
        kind: 'hide',
        targets: [{ sessionKey: 's3' }],
        value: true,
        executor: SIDEBAR
      },
      before: [false],
      after: [true]
    })
    expect(trail().map((line) => [line.action, line.phase])).toEqual([
      ['session.tag', 'prepared'],
      ['session.tag', 'applied'],
      ['session.snooze', 'applied'],
      ['session.hide', 'applied']
    ])
    await first.flush()
    // The history file is lost: the trail alone brings every kind back.
    rmSync(join(dir, 'session-organization'), { recursive: true, force: true })
    const restarted = openLedger()
    expect((await restarted.history('s1')).entries.map((entry) => entry.kind)).toEqual([
      'snooze',
      'tag'
    ])
    // s2 already had the tag, so Undo takes it only from s1, and a snooze does not count as "since".
    const plan = await restarted.undoPlan('tag-1')
    expect(plan.targets.map((entry) => entry.status)).toEqual(['undo', 'not-undoable'])
    expect(plan.inverse).toMatchObject({
      kind: 'untag',
      value: 'urgent',
      targets: [{ sessionKey: 's1' }]
    })
    expect((await restarted.undoPlan('hid')).inverse).toMatchObject({
      kind: 'unhide',
      value: false
    })
    expect((await restarted.undoPlan('nap')).inverse).toMatchObject({ kind: 'snooze', value: null })
  })
})

describe('OrganizationChangeLedger.note', () => {
  const sleep: OrganizationChange = {
    opId: 'sleep-1',
    kind: 'sleep',
    targets: [{ sessionKey: 's1', paneKey: 'tab-1:leaf-1', tabId: 'tab-1' }],
    value: true,
    executor: { kind: 'app', feature: 'archive-sleep' },
    reason: 'Archived while Done with nothing pending',
    evidence: 'Done since 2026-09-30T20:00:00.000Z'
  }

  it('writes one applied line and keeps it in history beside the archive, never undoable', async () => {
    const ledger = openLedger()
    await ledger.settle({
      phase: 'applied',
      change: {
        opId: 'filed',
        kind: 'archive',
        targets: [{ sessionKey: 's1' }],
        value: true,
        executor: SIDEBAR
      },
      before: [false],
      after: [true]
    })
    const heard = vi.fn()
    ledger.onApplied(heard)
    const noted = await ledger.note(sleep, { summary: 'Archive paused the agent' })
    expect(noted.record).toMatchObject({ opId: 'sleep-1', phase: 'applied' })
    // Why no hook: the host folds and syncs organized values; a stopped agent is neither.
    expect(heard).not.toHaveBeenCalled()
    expect(trail().at(-1)).toMatchObject({
      actor: 'app',
      action: 'session.sleep',
      phase: 'applied',
      summary: 'Archive paused the agent',
      reason: 'Archived while Done with nothing pending',
      organization: { kind: 'sleep', evidence: sleep.evidence }
    })
    expect((await ledger.history('s1')).entries.map((entry) => entry.kind)).toEqual([
      'sleep',
      'archive'
    ])
    expect((await ledger.undoPlan('sleep-1')).inverse).toBeNull()
    // A note is no later change to the archived field: the archive's Undo still applies.
    expect((await ledger.undoPlan('filed')).inverse).toMatchObject({ kind: 'unarchive' })
    await ledger.flush()
    rmSync(join(dir, 'session-organization'), { recursive: true, force: true })
    expect((await openLedger().history('s1')).entries.map((entry) => entry.opId)).toEqual([
      'sleep-1',
      'filed'
    ])
  })

  it('refuses an organization change and an opId already recorded', async () => {
    const ledger = openLedger()
    await expect(ledger.note(move('m', ['s1'], PANE, 'x'))).rejects.toThrow('not a note')
    await ledger.note(sleep)
    await expect(ledger.note(sleep)).rejects.toThrow('already recorded')
  })
})
