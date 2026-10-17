import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SESSION_FOLDERS_NO_WINDOW_ERROR,
  type SessionFolderOp,
  type SessionFolderRelayRequest
} from '../../shared/session-folder-cli'
import type {
  OrganizationChange,
  OrganizationExecutor,
  OrganizationRelayedOutcome
} from '../../shared/session-organization-change'
import { SESSION_ACTIONS_FILE, SessionActionsLog } from '../session-manage/session-actions-log'
import { OrganizationChangeLedger } from './organization-change-ledger'
import { OrganizationHistoryStore } from './organization-history-store'
import {
  ORGANIZATION_MOVE_NEEDS_REASON,
  ORGANIZATION_WINDOW_TOO_OLD,
  organizationChangeReasonRefusal,
  organizationReasonRefusal,
  recordedFolderRelay,
  relayOrganizationChange,
  relayOrganizationMutation
} from './organization-relayed-mutation'

let dir: string
let seconds = 0
const now = () => new Date(Date.UTC(2026, 8, 25, 10, 0, (seconds += 1)))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'organization-relay-'))
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

function trail(): Record<string, unknown>[] {
  return readFileSync(join(dir, SESSION_ACTIONS_FILE), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

const PANE: OrganizationExecutor = { kind: 'pane', paneKey: 'tab-9:leaf-9', title: 'Ads review' }
const MOVE: SessionFolderOp = {
  kind: 'moveSession',
  paneKey: 'tab-1:leaf-1',
  destination: 'folder',
  folder: 'Clients / Acme'
}

describe('organizationReasonRefusal', () => {
  it('requires a reason for an agent or CLI move, except a dry run or launch filing', () => {
    const moveFolder: SessionFolderOp = { kind: 'moveFolder', folder: 'Sales', into: 'Clients' }
    for (const executor of [PANE, { kind: 'cli' } as const]) {
      expect(organizationReasonRefusal(MOVE, executor, undefined, false)).toBe(
        ORGANIZATION_MOVE_NEEDS_REASON
      )
      expect(organizationReasonRefusal(moveFolder, executor, '  ', false)).toBe(
        ORGANIZATION_MOVE_NEEDS_REASON
      )
      expect(organizationReasonRefusal(MOVE, executor, 'the person asked', false)).toBeNull()
      expect(organizationReasonRefusal(MOVE, executor, undefined, true)).toBeNull()
    }
    expect(
      organizationReasonRefusal(
        MOVE,
        { kind: 'launch', source: 'terminal-create' },
        undefined,
        false
      )
    ).toBeNull()
    const archive: SessionFolderOp = { kind: 'archiveSession', paneKey: 'p', archived: true }
    expect(organizationReasonRefusal(archive, PANE, undefined, false)).toBeNull()
  })
})

describe('relayOrganizationMutation', () => {
  it('records prepared, relays the change, and records applied from the window’s outcome', async () => {
    const relay = vi.fn(async (request: SessionFolderRelayRequest) => {
      const opId = request.kind === 'mutate' ? request.change!.opId : ''
      return {
        summary: 'Moved “Ads” into “Clients / Acme”',
        sessionKey: 'k1',
        before: 'unfiled',
        after: 'Clients / Acme',
        organization: {
          opId,
          targets: [{ sessionKey: 'k1', paneKey: 'tab-1:leaf-1' }],
          value: 'folder-acme',
          before: [null],
          after: ['folder-acme']
        }
      }
    })
    const ledger = openLedger()
    const result = await relayOrganizationMutation(ledger, relay, {
      op: MOVE,
      executor: PANE,
      opId: 'op-agent',
      reason: 'client work',
      request: 'file the Acme session',
      actor: { actor: { paneKey: PANE.paneKey, title: PANE.title } }
    })
    expect(result).toEqual({
      summary: 'Moved “Ads” into “Clients / Acme”',
      sessionKey: 'k1',
      before: 'unfiled',
      after: 'Clients / Acme',
      opId: 'op-agent'
    })
    expect(relay).toHaveBeenCalledWith({
      kind: 'mutate',
      op: MOVE,
      change: {
        opId: 'op-agent',
        executor: PANE,
        reason: 'client work',
        request: 'file the Acme session'
      }
    })
    expect(trail()).toEqual([
      expect.objectContaining({
        phase: 'prepared',
        opId: 'op-agent',
        reason: 'client work',
        actor: { paneKey: 'tab-9:leaf-9', title: 'Ads review' },
        target: { paneKey: 'tab-1:leaf-1', tabId: null },
        organization: expect.objectContaining({
          value: 'Clients / Acme',
          targets: [{ paneKey: 'tab-1:leaf-1' }]
        })
      }),
      expect.objectContaining({
        phase: 'applied',
        opId: 'op-agent',
        reason: 'client work',
        revision: 'op-agent',
        before: 'unfiled',
        after: 'Clients / Acme',
        organization: expect.objectContaining({
          value: 'folder-acme',
          before: [null],
          after: ['folder-acme']
        })
      })
    ])
    const history = await ledger.history('k1')
    expect(history.entries.map((entry) => entry.opId)).toEqual(['op-agent'])
    expect(history.ownership.placement).toMatchObject({ value: 'folder-acme', by: 'pane' })
  })

  it('still records a move an older window applied without the change field, with no ownership', async () => {
    const ledger = openLedger()
    const relay = vi.fn(async () => ({ summary: 'Moved', sessionKey: 'k1' }))
    const result = await relayOrganizationMutation(ledger, relay, {
      op: MOVE,
      executor: PANE,
      opId: 'op-old',
      reason: 'client work'
    })
    expect(result.opId).toBe('op-old')
    const history = await ledger.history('k1')
    expect(history.entries[0]).toMatchObject({
      opId: 'op-old',
      phase: 'applied',
      revisionUnchecked: true,
      targets: [{ paneKey: 'tab-1:leaf-1', sessionKey: 'k1' }]
    })
    expect(history.ownership).toEqual({})
  })

  it('records a change no window could apply as failed: no-window, and passes the error on', async () => {
    const ledger = openLedger()
    const relay = vi.fn(async () => {
      throw new Error(SESSION_FOLDERS_NO_WINDOW_ERROR)
    })
    await expect(
      relayOrganizationMutation(ledger, relay, {
        op: MOVE,
        executor: PANE,
        opId: 'op-closed',
        reason: 'why'
      })
    ).rejects.toThrow(SESSION_FOLDERS_NO_WINDOW_ERROR)
    expect(
      trail().map((line) => [line.phase, (line.organization as { error?: string }).error])
    ).toEqual([
      ['prepared', undefined],
      ['failed', 'no-window']
    ])
    expect((await ledger.history('pane:tab-1:leaf-1')).entries).toEqual([])
  })

  it('files launch changes with launch’s own reason, and passes reads through untouched', async () => {
    const ledger = openLedger()
    const relay = vi.fn(async (request: SessionFolderRelayRequest) =>
      request.kind === 'list' ? { folders: [] } : { summary: 'Moved', sessionKey: 'k7' }
    )
    const filing = recordedFolderRelay(ledger, relay, {
      executor: { kind: 'launch', source: 'session-prep' },
      reason: 'filed at launch from request "build checkout"',
      request: 'build checkout'
    })
    await expect(filing({ kind: 'list' })).resolves.toEqual({ folders: [] })
    await filing({ kind: 'mutate', op: { ...MOVE, folder: 'folder-acme' } })
    expect(relay.mock.calls[1]![0]).toMatchObject({
      kind: 'mutate',
      change: {
        executor: { kind: 'launch', source: 'session-prep' },
        reason: 'filed at launch from request "build checkout"',
        request: 'build checkout'
      }
    })
    expect(trail().map((line) => [line.phase, line.actor, line.reason])).toEqual([
      ['prepared', 'launch', 'filed at launch from request "build checkout"'],
      ['applied', 'launch', 'filed at launch from request "build checkout"']
    ])
  })
})

describe('relayOrganizationChange (one change, many targets)', () => {
  const panes = Array.from({ length: 100 }, (_, index) => `tab-${index}:leaf-1`)
  const batch = (extra: Partial<OrganizationChange> = {}): OrganizationChange => ({
    opId: 'bulk-1',
    kind: 'move',
    targets: panes.map((paneKey) => ({ paneKey })),
    value: 'Checkout',
    executor: PANE,
    reason: 'the person asked to file the checkout work',
    request: 'put all the checkout sessions in Checkout',
    ...extra
  })
  /** A current window: resolves every pane to its row and the folder path to its id. */
  const windowApplying = () =>
    vi.fn(async (request: SessionFolderRelayRequest): Promise<OrganizationRelayedOutcome> => {
      if (request.kind !== 'applyOrganizationChange') {
        throw new Error(`unexpected ${request.kind}`)
      }
      const { change } = request
      return {
        opId: change.opId,
        targets: change.targets.map((target, index) => ({ ...target, sessionKey: `k${index}` })),
        value: 'folder-checkout',
        before: change.targets.map((_, index) => (index % 2 === 0 ? 'folder-sales' : null)),
        after: change.targets.map(() => 'folder-checkout')
      }
    })

  it('asks for the reason once per change, not per target', () => {
    const change = batch({ reason: undefined })
    expect(organizationChangeReasonRefusal(change, false)).toBe(ORGANIZATION_MOVE_NEEDS_REASON)
    expect(organizationChangeReasonRefusal(batch(), false)).toBeNull()
    expect(
      organizationChangeReasonRefusal(
        batch({ reason: undefined, kind: 'archive', value: true }),
        false
      )
    ).toBeNull()
  })

  it('refuses 100 agent moves without a reason before recording or relaying anything', async () => {
    const relay = windowApplying()
    await expect(
      relayOrganizationChange(openLedger(), relay, batch({ reason: undefined }))
    ).rejects.toThrow(ORGANIZATION_MOVE_NEEDS_REASON)
    expect(relay).not.toHaveBeenCalled()
  })

  it('records 100 moves as one prepared and one applied record, and Undo reports a partial', async () => {
    const relay = windowApplying()
    const ledger = openLedger()
    const result = await relayOrganizationChange(ledger, relay, batch(), {
      actor: { actor: { paneKey: PANE.paneKey, title: PANE.title } }
    })
    expect(result).toMatchObject({ opId: 'bulk-1', revision: 'bulk-1' })
    // The whole change, with every target, travels in one relay request.
    expect(relay).toHaveBeenCalledTimes(1)
    expect(relay.mock.calls[0]![0]).toEqual({ kind: 'applyOrganizationChange', change: batch() })
    const lines = trail()
    expect(lines.map((line) => [line.phase, line.opId, line.reason])).toEqual([
      ['prepared', 'bulk-1', 'the person asked to file the checkout work'],
      ['applied', 'bulk-1', 'the person asked to file the checkout work']
    ])
    const applied = lines[1]!.organization as {
      targets: unknown[]
      before: unknown[]
      after: unknown[]
    }
    expect([applied.targets.length, applied.before.length, applied.after.length]).toEqual([
      100, 100, 100
    ])
    expect(applied.before.slice(0, 2)).toEqual(['folder-sales', null])

    // The person later moves 30 of them; Undo of the bulk move leaves those alone.
    await ledger.settle({
      phase: 'applied',
      change: {
        opId: 'mine',
        kind: 'move',
        targets: Array.from({ length: 30 }, (_, index) => ({ sessionKey: `k${index}` })),
        value: 'folder-ops',
        executor: { kind: 'person', via: 'sidebar' }
      }
    })
    await ledger.flush()
    const plan = await openLedger().undoPlan('bulk-1')
    expect(plan.partial).toBe(true)
    expect(plan.targets.filter((entry) => entry.status === 'changed-since')).toHaveLength(30)
    expect(plan.targets[0]).toMatchObject({ status: 'changed-since', laterOpId: 'mine' })
    expect(plan.inverse?.targets).toHaveLength(70)
    expect(plan.inverse?.targets[0]).toEqual({ paneKey: 'tab-30:leaf-1', sessionKey: 'k30' })
    expect(plan.inverse?.values?.slice(0, 2)).toEqual(['folder-sales', null])
  })

  it('records a window that cannot apply batches as failed, changing nothing', async () => {
    const ledger = openLedger()
    const relay = vi.fn(async () => undefined)
    await expect(relayOrganizationChange(ledger, relay, batch())).rejects.toThrow(
      ORGANIZATION_WINDOW_TOO_OLD
    )
    expect(trail().map((line) => line.phase)).toEqual(['prepared', 'failed'])
  })
})
