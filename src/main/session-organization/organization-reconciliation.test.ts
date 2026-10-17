import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  OrganizationChange,
  OrganizationRecord
} from '../../shared/session-organization-change'
import { SESSION_ACTIONS_FILE, SessionActionsLog } from '../session-manage/session-actions-log'
import { OrganizationChangeLedger } from './organization-change-ledger'
import { OrganizationHistoryStore } from './organization-history-store'
import { reconcileInterruptedChanges } from './organization-reconciliation'

let dir: string
let seconds = 0
const now = () => new Date(Date.UTC(2026, 8, 25, 10, 0, (seconds += 1)))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'organization-reconcile-'))
})

const opened: OrganizationChangeLedger[] = []

afterEach(async () => {
  // Why flush first: history.json is written asynchronously and would race the removal.
  await Promise.all(opened.splice(0).map((ledger) => ledger.flush()))
  rmSync(dir, { recursive: true, force: true })
})

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

function agentMove(opId: string, paneKey: string, value: unknown): OrganizationChange {
  return {
    opId,
    kind: 'move',
    targets: [{ paneKey }],
    value,
    executor: { kind: 'pane', paneKey: 'tab-9:leaf-9', title: 'Ads review' },
    reason: 'matches the brief'
  }
}

/** Two agent moves prepared, then the app died before either was settled. */
async function crashWithTwoPrepared(): Promise<OrganizationChangeLedger> {
  const crashed = openLedger()
  await crashed.prepare(agentMove('held', 'tab-1:leaf-1', 'Checkout'))
  await crashed.prepare(agentMove('lost', 'tab-2:leaf-1', 'Checkout'))
  await crashed.flush()
  const restarted = openLedger()
  await restarted.ready
  return restarted
}

describe('reconcileInterruptedChanges', () => {
  it('applies what the window confirms and fails the rest as interrupted', async () => {
    const ledger = await crashWithTwoPrepared()
    const probe = vi.fn(async (records: OrganizationRecord[]) => [
      {
        opId: 'held',
        holds: true,
        targets: [{ paneKey: 'tab-1:leaf-1', sessionKey: 'k1' }],
        value: 'folder-checkout',
        after: ['folder-checkout']
      },
      { opId: records[1]!.opId, holds: false }
    ])
    expect(await reconcileInterruptedChanges(ledger, probe)).toEqual({
      applied: ['held'],
      failed: ['lost'],
      pending: 0
    })
    expect(probe.mock.calls[0]![0].map((record) => record.opId)).toEqual(['held', 'lost'])
    const lines = readFileSync(join(dir, SESSION_ACTIONS_FILE), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(lines.slice(2)).toEqual([
      expect.objectContaining({
        opId: 'held',
        phase: 'applied',
        revision: 'held',
        reason: 'matches the brief',
        organization: expect.objectContaining({ reconciled: true, value: 'folder-checkout' })
      }),
      expect.objectContaining({
        opId: 'lost',
        phase: 'failed',
        organization: expect.objectContaining({ error: 'interrupted' })
      })
    ])
    // Reconciled: the agent's placement now carries ownership, and the failed one nothing.
    expect((await ledger.history('k1')).ownership.placement).toMatchObject({ opId: 'held' })
    expect((await ledger.history('pane:tab-2:leaf-1')).entries).toEqual([])
    // Nothing is left to reconcile at the next start either.
    await ledger.flush()
    const again = openLedger()
    await again.ready
    expect(again.pending()).toEqual([])
  })

  it('leaves everything pending when no window can answer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ledger = await crashWithTwoPrepared()
    const result = await reconcileInterruptedChanges(ledger, async () => {
      throw new Error('The OmniConsole window is not open')
    })
    expect(result).toEqual({ applied: [], failed: [], pending: 2 })
    expect(ledger.pending().map((record) => record.opId)).toEqual(['held', 'lost'])
    warn.mockRestore()
  })

  it('fails a change the window did not answer about, or could not tell', async () => {
    const ledger = await crashWithTwoPrepared()
    const result = await reconcileInterruptedChanges(ledger, async () => [
      { opId: 'held', holds: null }
    ])
    expect(result).toEqual({ applied: [], failed: ['held', 'lost'], pending: 0 })
  })

  it('does nothing without interrupted changes', async () => {
    const probe = vi.fn()
    expect(await reconcileInterruptedChanges(openLedger(), probe)).toEqual({
      applied: [],
      failed: [],
      pending: 0
    })
    expect(probe).not.toHaveBeenCalled()
  })
})
