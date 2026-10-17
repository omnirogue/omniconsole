import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { SessionFrameLogRecord } from '../../../shared/session-frame-log'
import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type { Tab } from '../../../shared/tab-types'
import {
  applyWebSessionTabsSnapshot,
  decideWebSessionTabsSnapshot,
  type WebSessionTabsSyncState
} from './web-session-tabs-sync'
import {
  ENV,
  LEAF_ID,
  NOW,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'
import {
  _flushSessionFrameLogForTests,
  _resetSessionFrameLogForTests,
  setSessionFrameLogEnabled
} from './session-frame-log'
import { _resetReceiverFrameLogForTests } from './session-frame-log-receiver'

vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn(),
    getState: () => ({
      tabsByWorktree: {},
      unifiedTabsByWorktree: {},
      terminalLayoutsByTabId: {},
      worktreesByRepo: {},
      repos: [],
      runtimeStatusByEnvironmentId: new Map()
    })
  }
}))

const OTHER_ENV = 'web-env-2'

function terminal(
  parentTabId: string,
  leafId = LEAF_ID
): RuntimeMobileSessionTabsResult['tabs'][number] {
  return {
    type: 'terminal',
    id: `${parentTabId}::${leafId}`,
    title: 'shell',
    parentTabId,
    leafId,
    isActive: true,
    launchAgent: 'claude',
    status: 'ready',
    terminal: `${parentTabId}-handle`
  }
}

describe('session frame log: receiver records', () => {
  const appended: SessionFrameLogRecord[] = []

  beforeEach(() => {
    resetWebSessionTabsSyncTestState()
    _resetSessionFrameLogForTests()
    _resetReceiverFrameLogForTests()
    appended.length = 0
    vi.stubGlobal('window', {
      api: {
        sessionFrameLog: { append: (records: SessionFrameLogRecord[]) => appended.push(...records) }
      }
    })
  })

  afterEach(() => {
    _resetSessionFrameLogForTests()
    vi.unstubAllGlobals()
  })

  function records(kind: string): SessionFrameLogRecord[] {
    _flushSessionFrameLogForTests()
    return appended.filter((record) => record.kind === kind)
  }

  it('records nothing while the flag is off, and the decision is unchanged', () => {
    const decision = decideWebSessionTabsSnapshot(
      makeSnapshot([terminal('host-tab-1')]),
      ENV,
      'subscribeAll'
    )
    applyWebSessionTabsSnapshot(makeState(), makeSnapshot([terminal('host-tab-1')]), ENV, NOW)

    expect(decision).toEqual({ apply: true, settlesHostMirror: true })
    _flushSessionFrameLogForTests()
    expect(appended).toEqual([])
  })

  it('records one frame decision with its identity, membership and reason', () => {
    setSessionFrameLogEnabled(true)
    const decision = decideWebSessionTabsSnapshot(
      makeSnapshot([terminal('host-tab-1'), terminal('host-tab-2')], {
        publicationEpoch: 'epoch-A',
        snapshotVersion: 4
      }),
      ENV,
      'subscribeAll'
    )

    expect(decision.apply).toBe(true)
    const frames = records('receiver.frame')
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({
      environmentId: ENV,
      source: 'subscribeAll',
      decision: 'applied',
      reason: 'first-frame-for-environment-workspace',
      publishers: [],
      frame: {
        worktree: WT,
        epoch: 'epoch-A',
        version: 4,
        removed: false,
        tabCount: 2,
        terminalTabIds: ['host-tab-1', 'host-tab-2'],
        agentTerminalTabIds: ['host-tab-1', 'host-tab-2']
      }
    })
    expect(records('receiver.ownership')[0]).toMatchObject({ worktree: WT, environmentId: ENV })
  })

  it('names an outranked frame and the accepted view that outranked it', () => {
    decideWebSessionTabsSnapshot(
      makeSnapshot([terminal('host-tab-1')], { snapshotVersion: 5 }),
      ENV
    )
    setSessionFrameLogEnabled(true)

    const decision = decideWebSessionTabsSnapshot(
      makeSnapshot([], { snapshotVersion: 3 }),
      ENV,
      'subscribe-active'
    )

    expect(decision.apply).toBe(false)
    expect(records('receiver.frame')).toEqual([
      expect.objectContaining({
        decision: 'outranked',
        reason: 'same-epoch-version-not-newer',
        prior: { epoch: 'epoch-1', version: 5 },
        publishers: [ENV]
      })
    ])
  })

  it('records a removal frame as a removal', () => {
    setSessionFrameLogEnabled(true)
    decideWebSessionTabsSnapshot(
      {
        ...makeSnapshot([], { publicationEpoch: 'removed:1', snapshotVersion: 0 }),
        removed: true
      } as RuntimeMobileSessionTabsResult,
      ENV,
      'subscribeAll'
    )

    expect(records('receiver.frame')[0]).toMatchObject({
      decision: 'removal',
      reason: 'owner-removed-workspace',
      frame: { removed: true }
    })
  })

  // Why: with owner-keyed mirrors (Phase 1 step 2) a frame from one environment never removes
  // another environment's rows; the record must show that instead of a cross-environment removal.
  it("records that an applied frame leaves another environment's rows alone", () => {
    const otherEnvironmentRow = toWebTerminalSurfaceTabId('peer-tab')
    const state = makeState({
      tabsByWorktree: {
        [WT]: [
          {
            id: otherEnvironmentRow,
            ptyId: toRemoteRuntimePtyId('peer-handle', OTHER_ENV),
            worktreeId: WT,
            title: 'peer shell',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: NOW
          }
        ]
      }
    })
    setSessionFrameLogEnabled(true)

    applyWebSessionTabsSnapshot(state, makeSnapshot([terminal('host-tab-1')]), ENV, NOW)

    expect(records('receiver.apply')).toEqual([
      expect.objectContaining({
        environmentId: ENV,
        worktree: WT,
        terminalRowsBefore: 1,
        removedRows: { count: 0, from: {}, ids: [] },
        crossEnvironmentRows: 0
      })
    ])
  })

  it('names the reconcile that removed a restored peer workspace', () => {
    setSessionFrameLogEnabled(true)
    decideWebSessionTabsSnapshot(
      {
        ...makeSnapshot([], {
          publicationEpoch: 'visibility-inventory-removal',
          snapshotVersion: 0
        }),
        removed: true
      } as RuntimeMobileSessionTabsResult,
      ENV,
      'listAll',
      'initial-inventory-reconcile'
    )

    expect(records('receiver.frame')[0]).toMatchObject({
      source: 'listAll',
      decision: 'removal',
      reason: 'initial-inventory-reconcile'
    })
  })

  it('names agent conversations an applied frame dropped and terminals a replaced conversation took', () => {
    const agentTab = (id: string, sessionId: string): Tab => ({
      id,
      entityId: sessionId,
      groupId: 'group-1',
      worktreeId: WT,
      contentType: 'agent-session',
      label: 'Chat',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW
    })
    const state = makeState({
      tabsByWorktree: {
        [WT]: [
          {
            id: 'term-1',
            ptyId: 'local-pty-1',
            worktreeId: WT,
            title: 'codex',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: NOW
          }
        ]
      },
      unifiedTabsByWorktree: {
        [WT]: [
          agentTab('agent-local-1', 'session-old'),
          agentTab('agent-local-2', 'session-gone'),
          {
            ...agentTab('term-1', 'term-1'),
            contentType: 'terminal',
            structuredSessionId: 'session-old'
          }
        ]
      }
    })
    setSessionFrameLogEnabled(true)

    applyWebSessionTabsSnapshot(
      state,
      makeSnapshot(
        [
          {
            type: 'agent-session',
            id: 'host-agent-1',
            title: 'Chat',
            sessionId: 'session-new',
            replacesSessionId: 'session-old',
            agent: 'codex',
            isActive: true
          }
        ],
        { activeTabType: 'agent-session' }
      ),
      ENV,
      NOW,
      { contentScope: 'agent-session' }
    )

    const apply = records('receiver.apply')[0]
    expect(apply).toMatchObject({
      contentScope: 'agent-session',
      removedRows: { count: 1, ids: ['term-1'] },
      replacedConversationTerminalIds: ['term-1'],
      agentConversations: { before: 2, mirrored: 1 }
    })
    const agents = apply!.agentConversations as {
      replaced: { count: number }
      removed: { count: number; ids: string[] }
    }
    expect(agents.replaced.count + agents.removed.count).toBe(2)
    expect(agents.removed.ids).toContain('session-gone')
  })

  it('makes the same decisions and store patches with the log on as off', () => {
    const run = (withLog: boolean) => {
      resetWebSessionTabsSyncTestState()
      _resetReceiverFrameLogForTests()
      setSessionFrameLogEnabled(withLog)
      let state: WebSessionTabsSyncState = makeState()
      const decisions: unknown[] = []
      const frames: [RuntimeMobileSessionTabsResult, string][] = [
        [makeSnapshot([terminal('host-tab-1')], { snapshotVersion: 1 }), ENV],
        [
          makeSnapshot([terminal('host-tab-1'), terminal('host-tab-2')], { snapshotVersion: 2 }),
          ENV
        ],
        [makeSnapshot([], { snapshotVersion: 1 }), ENV],
        [makeSnapshot([terminal('peer-tab')], { publicationEpoch: 'peer' }), OTHER_ENV],
        [
          {
            ...makeSnapshot([], { publicationEpoch: 'removed:1', snapshotVersion: 0 }),
            removed: true
          } as RuntimeMobileSessionTabsResult,
          ENV
        ]
      ]
      for (const [frame, environmentId] of frames) {
        const decision = decideWebSessionTabsSnapshot(frame, environmentId, 'subscribeAll')
        decisions.push(decision)
        if (decision.apply) {
          state = { ...state, ...applyWebSessionTabsSnapshot(state, frame, environmentId, NOW) }
        }
      }
      _flushSessionFrameLogForTests()
      setSessionFrameLogEnabled(false)
      return JSON.parse(JSON.stringify({ decisions, state })) as unknown
    }

    const off = run(false)
    const on = run(true)
    expect(on).toEqual(off)
    expect(appended.filter((record) => record.kind === 'receiver.frame')).toHaveLength(5)
  })
})
