import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  SessionFolderEntry,
  SessionFolderOp,
  SessionFolderRelayRequest
} from '../../shared/session-folder-cli'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { SessionManageState } from '../../shared/session-manage-types'
import {
  organizationValueAt,
  type OrganizationChange,
  type OrganizationExecutor
} from '../../shared/session-organization-change'
import type { SessionOrganizePlan, SessionOrganizeRelayReply } from '../../shared/session-organize'
import { SESSION_ACTIONS_FILE, SessionActionsLog } from '../session-manage/session-actions-log'
import { OrganizationChangeLedger } from './organization-change-ledger'
import { OrganizationHistoryStore } from './organization-history-store'
import {
  ORGANIZE_NEEDS_REASON,
  ORGANIZE_WINDOW_TOO_OLD,
  organizeSessions,
  type OrganizeDeps
} from './organization-organize'
import { ORGANIZE_ASKING_REFUSAL, type OrganizeRow } from './organization-organize-plan'
import {
  ORGANIZATION_CHANGE_NEEDS_REASON,
  relayOrganizationChange
} from './organization-relayed-mutation'

let dir: string
let seconds = 0
const now = () => new Date(Date.UTC(2026, 8, 25, 10, 0, (seconds += 1)))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'organization-organize-'))
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

const PANE: OrganizationExecutor = { kind: 'pane', paneKey: 'tab-0:leaf-0', title: 'Steward' }
const ACTOR = { kind: 'pane' as const, paneKey: 'tab-0:leaf-0', title: 'Steward' }
const FOLDERS: SessionFolderEntry[] = [
  {
    id: 'f-acme',
    name: 'Acme',
    path: 'Clients / Acme',
    section: 'active',
    parentId: 'f-clients',
    color: null,
    sessionCount: 0
  },
  {
    id: 'f-clients',
    name: 'Clients',
    path: 'Clients',
    section: 'active',
    parentId: null,
    color: null,
    sessionCount: 0
  }
]

function row(index: number, patch: Partial<SessionManageSidebarRow> = {}): SessionManageSidebarRow {
  return {
    rowKey: `row-${index}`,
    viewKey: `view-${index}`,
    paneKey: `tab-${index}:leaf-1`,
    tabId: `tab-${index}`,
    kind: 'terminal',
    structuredSessionId: null,
    worktreeId: 'wt',
    hostId: null,
    hostUnavailable: false,
    title: `Session ${index}`,
    agent: 'claude',
    workspace: 'ws',
    worktreePath: null,
    repoId: null,
    repoLabel: null,
    branch: null,
    workspaceKind: 'git',
    folderId: null,
    folder: null,
    saved: false,
    archived: false,
    archivedByHand: false,
    pinned: false,
    launchPending: false,
    resumable: false,
    shellForeground: false,
    folded: false,
    hidden: false,
    waitingUntil: null,
    ...patch
  }
}

/** A window that applies every change to an in-memory sidebar and answers like the real one. */
function fakeWindow(rows: SessionManageSidebarRow[]) {
  const values = new Map<string, unknown>()
  const requests: SessionFolderRelayRequest[] = []
  const field = (change: OrganizationChange, key: string, index: number): string =>
    change.kind === 'tag' || change.kind === 'untag'
      ? `tag:${key}:${String(organizationValueAt(change, index))}`
      : `${change.kind === 'unhide' ? 'hide' : change.kind === 'unarchive' ? 'archive' : change.kind}:${key}`
  const initial = (change: OrganizationChange, key: string): unknown => {
    const source = rows.find((entry) => entry.viewKey === key)
    return change.kind === 'move'
      ? (source?.folderId ?? null)
      : change.kind === 'snooze'
        ? null
        : false
  }
  const relay = vi.fn(async (request: SessionFolderRelayRequest): Promise<unknown> => {
    requests.push(request)
    if (request.kind !== 'applyOrganizationChanges') {
      return undefined
    }
    const outcomes = request.changes.map((change) => {
      const before: unknown[] = []
      const after: unknown[] = []
      change.targets.forEach((target, index) => {
        const id = field(change, target.sessionKey!, index)
        before.push(values.has(id) ? values.get(id) : initial(change, target.sessionKey!))
        const value = organizationValueAt(change, index)
        const next =
          change.kind === 'tag'
            ? true
            : change.kind === 'untag'
              ? false
              : change.kind === 'move'
                ? `id:${String(value)}`
                : value
        values.set(id, next)
        after.push(next)
      })
      return {
        ok: true as const,
        opId: change.opId,
        targets: change.targets,
        value: change.value,
        ...(change.values ? { values: change.values } : {}),
        before,
        after
      }
    })
    return { outcomes } satisfies SessionOrganizeRelayReply
  })
  return { relay, requests, values }
}

function deps(
  rows: SessionManageSidebarRow[],
  ledger: OrganizationChangeLedger,
  relay: OrganizeDeps['relay'],
  states: Record<string, SessionManageState> = {}
): OrganizeDeps & { folderOps: SessionFolderOp[] } {
  const folderOps: SessionFolderOp[] = []
  let opIds = 0
  return {
    folderOps,
    readRows: async (): Promise<OrganizeRow[]> =>
      rows.map((entry) => ({ row: entry, state: states[entry.paneKey!] ?? 'idle' })),
    listFolders: async () => FOLDERS,
    mutateFolder: async (op) => {
      folderOps.push(op)
      return { summary: 'ok' }
    },
    ledger,
    relay,
    mintOpId: () => `op-${(opIds += 1)}`,
    now: () => Date.UTC(2026, 8, 25, 12)
  }
}

const hundred = Array.from({ length: 100 }, (_, index) => row(index + 1))

describe('organizeSessions', () => {
  it('re-files 100 sessions as one recorded change, and one Undo plan restores all 100', async () => {
    const ledger = openLedger()
    const window = fakeWindow(hundred)
    const plan: SessionOrganizePlan = {
      reason: 'file by client',
      request: 'tidy my sidebar',
      changes: hundred.map((entry) => ({ pane: entry.paneKey!, folder: 'Clients / Acme' }))
    }
    const result = await organizeSessions(
      { plan, apply: true, executor: PANE, actor: ACTOR },
      deps(hundred, ledger, window.relay)
    )
    expect(result.changes).toEqual([
      expect.objectContaining({ kind: 'move', status: 'applied', opId: 'op-1' })
    ])
    expect(result.changes[0]!.panes).toHaveLength(100)
    // One relay for the whole plan, one record pair in the trail.
    expect(
      window.requests.filter((request) => request.kind === 'applyOrganizationChanges')
    ).toHaveLength(1)
    const lines = trail()
    expect(lines.map((line) => line.phase)).toEqual(['prepared', 'applied'])
    expect(lines[1]).toMatchObject({
      opId: 'op-1',
      reason: 'file by client',
      request: 'tidy my sidebar'
    })
    const plan100 = await ledger.undoPlan('op-1')
    expect(plan100.partial).toBe(false)
    expect(plan100.inverse?.kind).toBe('move')
    expect(plan100.inverse?.targets).toHaveLength(100)
    expect(plan100.inverse?.value).toBeNull()
  })

  it('reports a partial Undo when one of the 100 changed since', async () => {
    const ledger = openLedger()
    const window = fakeWindow(hundred)
    await organizeSessions(
      {
        plan: {
          reason: 'file',
          changes: hundred.map((entry) => ({ pane: entry.paneKey!, folder: 'Clients' }))
        },
        apply: true,
        executor: PANE,
        actor: ACTOR
      },
      deps(hundred, ledger, window.relay)
    )
    await ledger.settle({
      phase: 'applied',
      change: {
        opId: 'drag-later',
        kind: 'move',
        targets: [{ sessionKey: 'view-7' }],
        value: 'f-acme',
        executor: { kind: 'person', via: 'sidebar' }
      },
      before: ['id:Clients'],
      after: ['f-acme']
    })
    const undo = await ledger.undoPlan('op-1')
    expect(undo.partial).toBe(true)
    expect(undo.inverse?.targets).toHaveLength(99)
    expect(undo.targets.filter((target) => target.status === 'changed-since')).toEqual([
      expect.objectContaining({
        laterOpId: 'drag-later',
        target: expect.objectContaining({ sessionKey: 'view-7' })
      })
    ])
  })

  it('refuses to apply without a reason and records nothing', async () => {
    const ledger = openLedger()
    const window = fakeWindow(hundred)
    await expect(
      organizeSessions(
        {
          plan: { changes: [{ pane: 'tab-1:leaf-1', hide: true }] },
          apply: true,
          executor: PANE,
          actor: ACTOR
        },
        deps(hundred, ledger, window.relay)
      )
    ).rejects.toThrow(ORGANIZE_NEEDS_REASON)
    expect(window.relay).not.toHaveBeenCalled()
    expect((await ledger.recent({ since: 0, limit: 10 })).length).toBe(0)
  })

  it('refuses a tag, hide or snooze change with no reason on the shared relay path too', async () => {
    const ledger = openLedger()
    const change: OrganizationChange = {
      opId: 'x',
      kind: 'hide',
      targets: [{ paneKey: 'tab-1:leaf-1' }],
      value: true,
      executor: { kind: 'cli' }
    }
    await expect(relayOrganizationChange(ledger, vi.fn(), change)).rejects.toThrow(
      ORGANIZATION_CHANGE_NEEDS_REASON
    )
  })

  it('records tag, hide and snooze with the reason, each undoable, and never hides a session asking', async () => {
    const ledger = openLedger()
    const rows = [row(1), row(2), row(3)]
    const window = fakeWindow(rows)
    const wake = Date.UTC(2026, 8, 26, 9)
    const result = await organizeSessions(
      {
        plan: {
          reason: 'keep the sidebar within five',
          changes: [
            { pane: 'tab-1:leaf-1', addTags: ['omnirogue', 'acme'], hide: true },
            { pane: 'tab-2:leaf-1', snooze: wake, hide: true },
            { pane: 'tab-3:leaf-1', addTags: ['betacorp'] }
          ]
        },
        apply: true,
        executor: PANE,
        actor: ACTOR
      },
      deps(rows, ledger, window.relay, { 'tab-2:leaf-1': 'awaiting-user' })
    )
    expect(result.changes.map((change) => [change.kind, change.status, change.panes])).toEqual([
      ['tag', 'applied', ['tab-1:leaf-1', 'tab-3:leaf-1']],
      ['hide', 'applied', ['tab-1:leaf-1']]
    ])
    expect(result.skipped).toEqual([
      { pane: 'tab-2:leaf-1', kind: 'hide', reason: ORGANIZE_ASKING_REFUSAL },
      { pane: 'tab-2:leaf-1', kind: 'snooze', reason: ORGANIZE_ASKING_REFUSAL }
    ])
    const tagOp = result.changes[0]!.opId!
    const tagRecord = (await ledger.history('view-1')).entries.find((entry) => entry.opId === tagOp)
    expect(tagRecord).toMatchObject({
      reason: 'keep the sidebar within five',
      values: ['omnirogue', 'acme', 'betacorp']
    })
    // One tag change adding different tags: the Undo removes exactly what each target gained.
    const undoTags = await ledger.undoPlan(tagOp)
    expect(undoTags.inverse).toMatchObject({
      kind: 'untag',
      values: ['omnirogue', 'acme', 'betacorp']
    })
    const undoHide = await ledger.undoPlan(result.changes[1]!.opId!)
    expect(undoHide.inverse).toMatchObject({ kind: 'unhide', value: false })
  })

  it('snoozes a waiting session until its wake time', async () => {
    const ledger = openLedger()
    const rows = [row(1)]
    const window = fakeWindow(rows)
    const wake = Date.UTC(2026, 8, 26, 9)
    const result = await organizeSessions(
      {
        plan: { reason: 'waiting on review', changes: [{ pane: 'tab-1:leaf-1', snooze: wake }] },
        apply: true,
        executor: PANE,
        actor: ACTOR
      },
      deps(rows, ledger, window.relay, { 'tab-1:leaf-1': 'idle' })
    )
    expect(result.changes).toEqual([expect.objectContaining({ kind: 'snooze', status: 'applied' })])
    const undo = await ledger.undoPlan(result.changes[0]!.opId!)
    expect(undo.inverse).toMatchObject({ kind: 'snooze', value: null })
  })

  it('dry run changes nothing and shows the resulting line count against the budget', async () => {
    const ledger = openLedger()
    const rows = [
      row(1, { folder: 'Ads', folderId: 'f-ads' }),
      row(2, { folder: 'Checkout', folderId: 'f-co' }),
      row(3, { folder: 'Refunds', folderId: 'f-re' }),
      row(4, { folder: 'Research', folderId: 'f-rs' }),
      row(5),
      row(6)
    ]
    const states: Record<string, SessionManageState> = Object.fromEntries(
      rows.map((entry) => [entry.paneKey!, 'working' as SessionManageState])
    )
    states['tab-6:leaf-1'] = 'awaiting-user'
    const window = fakeWindow(rows)
    const result = await organizeSessions(
      {
        plan: {
          folders: [{ create: 'OmniRogue / Checkout', color: 'green' }],
          changes: rows
            .slice(0, 5)
            .map((entry) => ({ pane: entry.paneKey!, folder: 'OmniRogue / Checkout' }))
        },
        apply: false,
        executor: PANE,
        actor: ACTOR
      },
      deps(rows, ledger, window.relay, states)
    )
    expect(window.relay).not.toHaveBeenCalled()
    expect(result.dryRun).toBe(true)
    expect(result.folders).toEqual([
      { path: 'OmniRogue / Checkout', status: 'create', color: 'green' }
    ])
    expect(result.changes).toEqual([expect.objectContaining({ kind: 'move', status: 'planned' })])
    // Before: Needs you + 3 of 5 busy folders + Everything else; two fold away.
    expect(result.focus.before).toMatchObject({ lines: 5, needsYou: 1, budget: 5 })
    expect(result.focus.before.folded).toHaveLength(2)
    // After: the busy work sits in one company folder; the question is on Needs you alone, and
    // the focus view still draws Everything else.
    expect(result.focus.after).toMatchObject({
      lines: 3,
      folders: ['OmniRogue'],
      folded: [],
      everythingElse: { sessions: 0, folders: 0 }
    })
    expect(result.plan?.changes[0]).toMatchObject({ expectedRevision: 'none' })
  })

  it('creates planned folders, parents first, before anything moves', async () => {
    const ledger = openLedger()
    const rows = [row(1)]
    const window = fakeWindow(rows)
    const setup = deps(rows, ledger, window.relay)
    await organizeSessions(
      {
        plan: {
          reason: 'nest by company',
          folders: [{ create: 'OmniRogue / Checkout', color: 'green' }],
          changes: [{ pane: 'tab-1:leaf-1', folder: 'OmniRogue / Checkout' }]
        },
        apply: true,
        executor: PANE,
        actor: ACTOR
      },
      setup
    )
    expect(setup.folderOps).toEqual([
      { kind: 'createFolder', name: 'OmniRogue' },
      { kind: 'createFolder', name: 'Checkout', parent: 'OmniRogue' },
      { kind: 'colorFolder', folder: 'OmniRogue / Checkout', color: 'green' }
    ])
  })

  it('skips a session organized since the dry run it was checked against', async () => {
    const ledger = openLedger()
    const rows = [row(1), row(2)]
    const window = fakeWindow(rows)
    const result = await organizeSessions(
      {
        plan: {
          reason: 'hide quiet ones',
          changes: [
            { pane: 'tab-1:leaf-1', hide: true, expectedRevision: 'some-older-op' },
            { pane: 'tab-2:leaf-1', hide: true, expectedRevision: 'none' }
          ]
        },
        apply: true,
        executor: PANE,
        actor: ACTOR
      },
      deps(rows, ledger, window.relay)
    )
    expect(result.skipped).toEqual([
      expect.objectContaining({ pane: 'tab-1:leaf-1', kind: 'entry' })
    ])
    expect(result.changes).toEqual([
      expect.objectContaining({ kind: 'hide', panes: ['tab-2:leaf-1'] })
    ])
  })

  it('records every change failed when the window predates organize', async () => {
    const ledger = openLedger()
    const rows = [row(1)]
    await expect(
      organizeSessions(
        {
          plan: { reason: 'hide', changes: [{ pane: 'tab-1:leaf-1', hide: true }] },
          apply: true,
          executor: PANE,
          actor: ACTOR
        },
        deps(
          rows,
          ledger,
          vi.fn(async () => undefined)
        )
      )
    ).rejects.toThrow(ORGANIZE_WINDOW_TOO_OLD)
    expect(trail().map((line) => line.phase)).toEqual(['prepared', 'failed'])
  })

  it('refuses a plan title without an origin', async () => {
    const ledger = openLedger()
    await expect(
      organizeSessions(
        {
          plan: { reason: 'r', changes: [{ pane: 'tab-1:leaf-1', title: 'Checkout fix' }] },
          apply: false,
          executor: PANE,
          actor: ACTOR
        },
        deps([row(1)], ledger, vi.fn())
      )
    ).rejects.toThrow(/needs origin/)
  })
})
