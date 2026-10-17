import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  _configureSessionFrameLogForTests,
  _resetSessionFrameLogForTests,
  setSessionFrameLogEnabled,
  type SessionFrameLogWriter
} from '../observability/session-frame-log'
import { OrcaRuntimeService } from './omni-runtime'
import { _resetOwnerFrameLogDedupeForTests } from './session-frame-log-owner-emit'

const WT = 'repo-1::/tmp/worktree-a'

const storeBase = {
  getRepo: () => ({
    id: 'repo-1',
    path: '/tmp/repo',
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1
  }),
  getRepos: () => [storeBase.getRepo()],
  addRepo: () => {},
  updateRepo: () => undefined as never,
  getAllWorktreeMeta: () => ({}),
  getWorktreeMeta: () => undefined,
  getGitHubCache: () => ({ pr: {}, issue: {} }),
  setWorktreeMeta: () => undefined as never,
  removeWorktreeMeta: () => {},
  getRetiredWorktreeNameRegistry: () => ({ exhaustedTiers: 0, names: [] }),
  addRetiredWorktreeName: () => {},
  mergeRetiredWorktreeNames: () => false,
  getSettings: () => ({
    workspaceDir: '/tmp/workspaces',
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: false,
    branchPrefix: 'none',
    branchPrefixCustom: ''
  })
}

function createRuntime() {
  const session: WorkspaceSessionState = {
    activeRepoId: 'repo-1',
    activeWorktreeId: WT,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {}
  }
  const runtime = new OrcaRuntimeService({
    ...storeBase,
    getWorkspaceSession: () => session,
    setWorkspaceSession: () => {}
  })
  const events: RuntimeMobileSessionTabsResult[] = []
  runtime.onMobileSessionTabsChanged((snapshot) => events.push(structuredClone(snapshot)))
  const sync = (mobileSessionTabs: RuntimeMobileSessionTabsSnapshot[]): void => {
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs })
  }
  return { runtime, sync, events }
}

function terminal(tabId: string, agent?: 'claude') {
  return {
    type: 'terminal' as const,
    id: `${tabId}::leaf-1`,
    parentTabId: tabId,
    leafId: 'leaf-1',
    title: tabId,
    isActive: tabId === 'tab-a',
    ...(agent ? { launchAgent: agent } : {})
  }
}

function rendererSnapshot(
  version: number,
  tabs: RuntimeMobileSessionTabsSnapshot['tabs']
): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: WT,
    publicationEpoch: 'renderer:epoch-1',
    snapshotVersion: version,
    activeGroupId: 'group-1',
    activeTabId: 'tab-a::leaf-1',
    activeTabType: 'terminal',
    tabs
  }
}

describe('session frame log: owner records', () => {
  let records: Record<string, unknown>[]
  let factory: Mock<(filePath: string) => SessionFrameLogWriter>
  let directory: string

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.UTC(2026, 9, 4, 18, 0, 0))
    await _resetSessionFrameLogForTests()
    _resetOwnerFrameLogDedupeForTests()
    records = []
    factory = vi.fn((_filePath: string) => ({
      push: (record: unknown) => records.push(record as Record<string, unknown>),
      flush: async () => {}
    }))
    directory = mkdtempSync(join(tmpdir(), 'frame-log-owner-'))
    _configureSessionFrameLogForTests({ directory, writerFactory: factory })
  })

  afterEach(async () => {
    await _resetSessionFrameLogForTests()
    vi.useRealTimers()
    rmSync(directory, { recursive: true, force: true })
  })

  it('records nothing and opens no file while the flag is off', () => {
    const { sync } = createRuntime()
    sync([rendererSnapshot(1, [terminal('tab-a', 'claude'), terminal('tab-b', 'claude')])])
    sync([rendererSnapshot(2, [terminal('tab-a', 'claude')])])
    vi.advanceTimersByTime(100)

    expect(factory).not.toHaveBeenCalled()
    expect(records).toEqual([])
  })

  it('flags an owner transition that loses a tab, with the writer that made it', () => {
    const { sync } = createRuntime()
    sync([rendererSnapshot(1, [terminal('tab-a', 'claude'), terminal('tab-b', 'claude')])])
    setSessionFrameLogEnabled(true, 'test')

    sync([rendererSnapshot(2, [terminal('tab-a', 'claude')])])
    vi.advanceTimersByTime(100)

    const store = records.find((record) => record.kind === 'owner.store' && record.loss === true)
    expect(store).toMatchObject({
      worktree: WT,
      op: 'replace',
      lostTabIds: ['tab-b::leaf-1'],
      addedTabIds: [],
      lostAgentEvidenceTabIds: []
    })
    // The writer is the first frame kept: the map method's own frame is dropped by count.
    const writer = store?.writer as string[]
    expect(writer[0]).toContain('syncMobileSessionTabs')
    expect(writer.some((frame) => frame.includes('FrameLoggedMobileSessionTabsMap'))).toBe(false)
    expect(records.find((record) => record.kind === 'owner.sync.frame')).toMatchObject({
      decision: 'merged',
      incoming: { version: 2, terminalTabIds: ['tab-a'] },
      previous: { version: 1, tabCount: 2 },
      stored: { terminalTabIds: ['tab-a'] },
      lostTabIds: ['tab-b::leaf-1'],
      loss: true
    })
    expect(records.find((record) => record.kind === 'owner.sync')).toMatchObject({
      incomingWorktrees: 1,
      changedWorktrees: [WT]
    })
    expect(records.find((record) => record.kind === 'owner.emit')).toMatchObject({
      path: 'notify',
      frame: { worktree: WT, terminalTabIds: ['tab-a'] }
    })
  })

  it('flags lost agent evidence on a tab that survives', () => {
    const { sync } = createRuntime()
    sync([rendererSnapshot(1, [terminal('tab-a', 'claude')])])
    setSessionFrameLogEnabled(true, 'test')

    sync([rendererSnapshot(2, [terminal('tab-a')])])

    expect(records.find((record) => record.kind === 'owner.store')).toMatchObject({
      lostTabIds: [],
      lostAgentEvidenceTabIds: ['tab-a::leaf-1'],
      loss: true
    })
  })

  it('records a skipped renderer resend and a removed workspace', () => {
    const { sync } = createRuntime()
    sync([rendererSnapshot(3, [terminal('tab-a')])])
    setSessionFrameLogEnabled(true, 'test')

    sync([rendererSnapshot(3, [terminal('tab-a')])])
    sync([])

    expect(records.filter((record) => record.kind === 'owner.sync.frame')).toEqual([
      expect.objectContaining({
        decision: 'skipped',
        reason: 'accepted-renderer-revision-not-newer'
      })
    ])
    expect(records.find((record) => record.kind === 'owner.sync.omitted')).toMatchObject({
      decision: 'removed',
      lostTabIds: ['tab-a::leaf-1'],
      loss: true
    })
    expect(
      records.find((record) => record.kind === 'owner.store' && record.op === 'delete')
    ).toBeTruthy()
  })

  it('never blames listAll repair for a renderer sync that lands during its PTY refresh', async () => {
    const { runtime, sync } = createRuntime()
    sync([rendererSnapshot(1, [terminal('tab-a', 'claude'), terminal('tab-b', 'claude')])])
    setSessionFrameLogEnabled(true, 'test')
    vi.spyOn(
      runtime as unknown as { refreshMobileSessionPtyInventory: () => Promise<null> },
      'refreshMobileSessionPtyInventory'
    ).mockImplementation(async () => {
      sync([rendererSnapshot(2, [terminal('tab-a', 'claude')])])
      return null
    })

    await runtime.listAllMobileSessionTabs()

    const repairs = records.filter((record) => record.kind === 'owner.repair')
    expect(repairs.flatMap((record) => record.changedWorktrees as string[])).not.toContain(WT)
    const loss = records.find((record) => record.kind === 'owner.store' && record.loss === true)
    expect((loss!.writer as string[])[0]).toContain('syncMobileSessionTabs')
    expect(
      records.find((record) => record.kind === 'owner.emit' && record.path === 'listAll')
    ).toMatchObject({ storedVersion: 2, frame: { terminalTabIds: ['tab-a'] } })
  })

  it('logs a listAll projection again only when its revision or membership moves', async () => {
    const { runtime, sync } = createRuntime()
    sync([rendererSnapshot(1, [terminal('tab-a')])])
    setSessionFrameLogEnabled(true, 'test')

    await runtime.listAllMobileSessionTabs()
    await runtime.listAllMobileSessionTabs()
    sync([rendererSnapshot(2, [terminal('tab-a'), terminal('tab-b')])])
    await runtime.listAllMobileSessionTabs()

    const listAll = records.filter(
      (record) => record.kind === 'owner.emit' && record.path === 'listAll'
    )
    expect(
      listAll.map((record) => (record.frame as { terminalTabIds: string[] }).terminalTabIds)
    ).toEqual([['tab-a'], ['tab-a', 'tab-b']])
  })
})

describe('session frame log: owner output with the log on equals the log off', () => {
  afterEach(async () => {
    await _resetSessionFrameLogForTests()
    vi.useRealTimers()
  })

  async function run(withLog: boolean) {
    vi.useFakeTimers()
    vi.setSystemTime(Date.UTC(2026, 9, 4, 18, 0, 0))
    await _resetSessionFrameLogForTests()
    _resetOwnerFrameLogDedupeForTests()
    const directory = mkdtempSync(join(tmpdir(), 'frame-log-parity-'))
    _configureSessionFrameLogForTests({
      directory,
      writerFactory: () => ({ push: () => {}, flush: async () => {} })
    })
    if (withLog) {
      setSessionFrameLogEnabled(true, 'test')
    }
    const { runtime, sync, events } = createRuntime()
    const steps: RuntimeMobileSessionTabsSnapshot[][] = [
      [rendererSnapshot(1, [terminal('tab-a', 'claude'), terminal('tab-b', 'claude')])],
      [rendererSnapshot(2, [terminal('tab-a', 'claude')])],
      [rendererSnapshot(2, [terminal('tab-a', 'claude')])],
      [rendererSnapshot(3, [terminal('tab-a')])],
      [],
      [{ ...rendererSnapshot(1, [terminal('tab-c')]), publicationEpoch: 'renderer:epoch-2' }]
    ]
    for (const step of steps) {
      sync(step)
      vi.advanceTimersByTime(100)
    }
    const listed = await runtime.listAllMobileSessionTabs()
    rmSync(directory, { recursive: true, force: true })
    return { events, listed }
  }

  it('emits the same frames and lists the same inventory', async () => {
    const off = await run(false)
    const on = await run(true)
    expect(off.events.length).toBeGreaterThan(0)
    expect(on).toEqual(off)
  })
})
