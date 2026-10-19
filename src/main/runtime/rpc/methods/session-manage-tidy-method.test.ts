import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionManageSidebarRow } from '../../../../shared/session-manage-relay'
import type { SessionManageEntry, SessionTidyResult } from '../../../../shared/session-manage-types'
import { manageEntry, sidebarRow } from '../../../session-manage/session-manage-test-fixtures'
import type { RpcContext } from '../core'

const state = vi.hoisted(() => ({
  rows: [] as SessionManageSidebarRow[],
  entries: new Map<string, SessionManageEntry>(),
  /** What the re-check just before archiving reads; the plan reads `entries`. */
  recheck: new Map<string, SessionManageEntry>(),
  mutate: vi.fn(async (_context: unknown, _params: unknown) => ({ summary: 'Archived' })),
  record: vi.fn(async (_input: unknown): Promise<string | undefined> => undefined),
  actor: { kind: 'cli' } as Record<string, unknown>,
  /** Panes a decision or Question still waits on, by the keeper's reason. */
  waiting: new Map<string, string>()
}))

vi.mock('../../../session-manage/session-manage-runtime-actions', () => ({
  readSidebarRows: async () => state.rows
}))
vi.mock('../../../session-manage/session-manage-runtime-sources', () => ({
  createRuntimeObserveSources: () => ({})
}))
vi.mock('../../../session-manage/session-manage-observe', () => ({
  observeSession: async (row: SessionManageSidebarRow) => row
}))
vi.mock('../../../session-manage/session-manage-inventory', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  toSessionManageEntry: (row: SessionManageSidebarRow) =>
    state.recheck.get(row.paneKey!) ?? state.entries.get(row.paneKey!)!,
  observeSessionManageRows: async (rows: SessionManageSidebarRow[]) =>
    rows.map((row) => ({ row, entry: state.entries.get(row.paneKey!)! }))
}))
vi.mock('./session-folders', () => ({ mutateSessionFolders: state.mutate }))
vi.mock('../../../answer-delivery/answer-wait', () => ({
  answerWaitKeeper: () => (session: { paneKey?: string | null }) =>
    state.waiting.get(session.paneKey ?? '') ?? null
}))
vi.mock('./session-manage-support', () => ({
  actorFor: () => state.actor,
  recordSessionAction: state.record
}))

const {
  SESSION_MANAGE_TIDY_METHOD,
  SESSION_TIDY_APPLY_NEEDS_REQUEST,
  SESSION_TIDY_UNVERIFIED_NEEDS_DELETE
} = await import('./session-manage-tidy-method')

const background = vi.hoisted(() => {
  const holder = { terminals: null as unknown[] | null }
  return {
    holder,
    list: vi.fn((): unknown[] | null => holder.terminals),
    closeTerminal: vi.fn(async (handle: string) => ({
      handle,
      tabId: 'tab-orphan',
      ptyKilled: true
    }))
  }
})
const context = {
  runtime: {
    getRuntimeId: () => 'runtime-1',
    getArtifactApiOrigin: () => 'https://omni.example',
    listSessionChains: () => [],
    listBackgroundRuntimeOwnedTerminals: background.list,
    closeTerminal: background.closeTerminal
  }
} as unknown as RpcContext

function run(params: Record<string, unknown>): Promise<SessionTidyResult> {
  return SESSION_MANAGE_TIDY_METHOD.handler(params, context) as Promise<SessionTidyResult>
}

function add(paneKey: string, entry: Partial<SessionManageEntry>): void {
  const tabId = paneKey.split(':')[0]!
  state.rows.push(sidebarRow({ paneKey, tabId, rowKey: `row-${paneKey}`, agentSession: true }))
  state.entries.set(paneKey, manageEntry({ paneKey, tabId, title: paneKey, ...entry }))
}

beforeEach(() => {
  state.actor = { kind: 'cli' }
  background.holder.terminals = null
  background.list.mockReset().mockImplementation(() => background.holder.terminals)
  background.closeTerminal.mockClear()
  state.record.mockClear()
  state.rows = []
  state.entries.clear()
  state.recheck.clear()
  state.waiting.clear()
  state.mutate.mockClear()
  add('tab-1:leaf-1', { state: 'exited', verdict: 'exited' })
  add('tab-2:leaf-1', { state: 'working' })
})

describe('sessionManage.tidy', () => {
  it('refuses --apply without the person’s words, before reading anything', async () => {
    await expect(run({ apply: true })).rejects.toThrow(SESSION_TIDY_APPLY_NEEDS_REQUEST)
    expect(state.mutate).not.toHaveBeenCalled()
  })

  it('plans without changing anything by default', async () => {
    const result = await run({})
    expect(result.dryRun).toBe(true)
    expect(result.rows.map((row) => [row.paneKey, row.action])).toEqual([
      ['tab-1:leaf-1', 'archive'],
      ['tab-2:leaf-1', 'skip']
    ])
    expect(state.mutate).not.toHaveBeenCalled()
  })

  it('archives through the existing archive path with reason and request', async () => {
    const result = await run({ apply: true, request: 'clean up the sessions', reason: 'tidy' })
    expect(state.mutate).toHaveBeenCalledTimes(1)
    expect(state.mutate.mock.calls[0]![1]).toEqual({
      op: { kind: 'archiveSession', paneKey: 'tab-1:leaf-1', tabId: 'tab-1', archived: true },
      reason: 'tidy — session tidy: Exited.',
      request: 'clean up the sessions'
    })
    expect(result.applied).toEqual({ archived: 1, skipped: 0, failed: 0 })
    expect(result.rows[0]).toMatchObject({ outcome: 'archived' })
  })

  it('skips a target whose state changed between plan and apply', async () => {
    state.recheck.set('tab-1:leaf-1', {
      ...state.entries.get('tab-1:leaf-1')!,
      state: 'working',
      verdict: 'live'
    })
    const result = await run({ apply: true, request: 'clean up' })
    expect(state.mutate).not.toHaveBeenCalled()
    expect(result.rows[0]).toMatchObject({
      outcome: 'skipped',
      outcomeReason: 'Changed since the plan: Working.'
    })
  })

  it('keeps a session a decision waits on, named or not, in archive and delete', async () => {
    const reason = 'Kept: waiting on your decision (plan.md).'
    state.waiting.set('tab-1:leaf-1', reason)
    for (const params of [
      { apply: true, request: 'clean up', include: ['tab-1:leaf-1'] },
      { apply: true, request: 'clean up', delete: true, unverified: true }
    ]) {
      const result = await run(params)
      expect(result.rows[0]).toMatchObject({ action: 'skip', reason, group: 'awaiting-answer' })
    }
    expect(state.mutate).not.toHaveBeenCalled()
  })

  it('refuses an --include pane the sidebar does not hold', async () => {
    await expect(run({ include: ['tab-9:leaf-9'] })).rejects.toThrow('tab-9:leaf-9')
  })
})

describe('sessionManage.tidy --delete', () => {
  beforeEach(() => {
    add('tab-3:leaf-1', { state: 'unknown', verdict: 'unverifiable', archived: true })
  })

  it('refuses --unverified without --delete', async () => {
    await expect(run({ unverified: true })).rejects.toThrow(SESSION_TIDY_UNVERIFIED_NEEDS_DELETE)
  })

  it('keeps what it cannot verify unless --unverified, and never a working session', async () => {
    const plain = await run({ delete: true })
    expect(plain.mode).toBe('delete')
    expect(plain.rows.map((row) => [row.paneKey, row.action])).toEqual([
      ['tab-1:leaf-1', 'delete'],
      ['tab-2:leaf-1', 'skip'],
      ['tab-3:leaf-1', 'skip']
    ])
    const unverified = await run({ delete: true, unverified: true })
    expect(unverified.rows.map((row) => row.action)).toEqual(['delete', 'skip', 'delete'])
    expect(unverified.counts.delete).toBe(2)
  })

  it('deletes through the existing delete path, marking rows it cannot verify', async () => {
    const result = await run({
      delete: true,
      unverified: true,
      apply: true,
      request: 'delete all sessions'
    })
    expect(state.mutate.mock.calls.map((call) => (call[1] as { op: unknown }).op)).toEqual([
      { kind: 'deleteSession', paneKey: 'tab-1:leaf-1', tabId: 'tab-1' },
      { kind: 'deleteSession', paneKey: 'tab-3:leaf-1', tabId: 'tab-3', unverified: true }
    ])
    expect(state.mutate.mock.calls[0]![1]).toMatchObject({ request: 'delete all sessions' })
    expect(result.applied).toEqual({ archived: 0, deleted: 2, skipped: 0, failed: 0 })
  })
})

// Why (C3 step 5): a process an earlier remote click started runs in the background, not in a
// window; tidy names it with that reason and never archives or ends it, in either mode.
describe('sessionManage.tidy with background terminals', () => {
  const orphanPane = 'tab-orphan:leaf-9'
  beforeEach(() => {
    background.holder.terminals = [
      {
        ptyId: 'wt-1@@orphan',
        worktreeId: 'repo::/ads',
        tabId: 'tab-orphan',
        paneKey: orphanPane,
        handle: 'term_orphan',
        title: 'claude conversation',
        launchAgent: 'claude',
        hostId: 'local'
      }
    ]
    state.entries.set(
      orphanPane,
      manageEntry({ paneKey: orphanPane, tabId: 'tab-orphan', state: 'exited', verdict: 'exited' })
    )
  })

  it('keeps it with its reason and leaves it out of apply, archive and delete alike', async () => {
    for (const params of [
      { apply: true, request: 'clean up' },
      { delete: true, apply: true, request: 'delete them' }
    ]) {
      state.mutate.mockClear()
      const result = await run(params)
      expect(result.rows.find((row) => row.paneKey === orphanPane)).toMatchObject({
        action: 'skip',
        group: 'background-not-in-window'
      })
      expect(
        state.mutate.mock.calls.some(
          (call) => (call[1] as { op: { paneKey?: string } }).op.paneKey === orphanPane
        )
      ).toBe(false)
    }
  })

  it('keeps a named one in archive mode: a background process has no tab to archive', async () => {
    const result = await run({ include: [orphanPane], apply: true, request: 'archive it' })

    expect(result.rows.find((row) => row.paneKey === orphanPane)).toMatchObject({
      action: 'skip',
      group: 'background-not-in-window',
      reason: 'A background process has no tab to archive; name it with --delete to end it.'
    })
    expect(background.closeTerminal).not.toHaveBeenCalled()
  })

  it('ends a named one in delete mode through the audited close, with the request recorded', async () => {
    const dry = await run({ delete: true, include: [orphanPane] })
    expect(dry.rows.find((row) => row.paneKey === orphanPane)).toMatchObject({
      action: 'delete',
      included: true
    })
    expect(dry.counts.delete).toBe(2)

    const result = await run({
      delete: true,
      include: [orphanPane],
      apply: true,
      request: 'end the background one',
      reason: 'Sal asked'
    })

    expect(background.closeTerminal).toHaveBeenCalledExactlyOnceWith('term_orphan')
    expect(result.rows.find((row) => row.paneKey === orphanPane)).toMatchObject({
      outcome: 'deleted'
    })
    expect(state.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'session.delete',
        target: expect.objectContaining({ paneKey: orphanPane, tabId: 'tab-orphan' }),
        provenance: {
          reason: expect.stringContaining('Sal asked — session tidy:'),
          request: 'end the background one'
        },
        after: expect.objectContaining({ ptyId: 'wt-1@@orphan', background: true })
      })
    )
    expect(
      state.mutate.mock.calls.some(
        (call) => (call[1] as { op: { paneKey?: string } }).op.paneKey === orphanPane
      )
    ).toBe(false)
  })

  it('re-checks at apply time and leaves one that is no longer a background process', async () => {
    // Why: the plan reads the listing once; the apply-time re-check finds the process adopted.
    background.list.mockImplementationOnce(() => background.holder.terminals).mockReturnValue([])

    const result = await run({
      delete: true,
      include: [orphanPane],
      apply: true,
      request: 'end it'
    })

    expect(background.closeTerminal).not.toHaveBeenCalled()
    expect(result.rows.find((row) => row.paneKey === orphanPane)).toMatchObject({
      outcome: 'skipped',
      outcomeReason: expect.stringContaining('no longer runs in the background')
    })
  })

  it('never ends the cleanup session itself, though it runs in the background', async () => {
    // Why: an automatic cleanup session launched in the background is itself such a process.
    state.actor = { kind: 'pane', paneKey: orphanPane, title: 'cleanup' }

    const result = await run({
      delete: true,
      include: [orphanPane],
      apply: true,
      request: 'delete everything finished'
    })

    expect(result.rows.find((row) => row.paneKey === orphanPane)).toMatchObject({
      action: 'skip',
      reason: 'This is the session running the cleanup.'
    })
    expect(background.closeTerminal).not.toHaveBeenCalled()
  })

  it('still refuses an --include that names nothing', async () => {
    await expect(run({ delete: true, include: ['tab-9:leaf-9'] })).rejects.toThrow('tab-9:leaf-9')
  })
})
