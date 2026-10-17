import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  conversationDigest,
  LEDGER_ENV,
  LEDGER_T0,
  ledgerBucket,
  ledgerOwner,
  ledgerRecord,
  ledgerSlices,
  pairedSource,
  providerSession
} from '@/lib/mirrored-conversation-test-fixtures'
import { sessionCountsByHost } from '@/lib/session-host-scope'
import { emptySessionSidebarView } from '@/lib/session-sidebar-view'
import {
  SESSION_TEST_LEAF,
  SESSION_TEST_WORKTREE,
  sessionTestSource
} from '@/lib/sidebar-session-test-fixtures'
import {
  buildSidebarSessions,
  type SidebarSession,
  type SidebarSessionSource
} from '@/lib/sidebar-sessions'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { makePaneKey } from '../../../../../shared/stable-pane-id'
import type { SessionFrameLogRecord } from '../../../../../shared/session-frame-log'
import {
  _flushSessionFrameLogForTests,
  _resetSessionFrameLogForTests,
  setSessionFrameLogEnabled
} from '@/runtime/session-frame-log'
import {
  _resetRenderedSidebarCountsForTests,
  publishRenderedSidebarCounts,
  readRenderedSidebarCounts,
  SIDEBAR_NOT_ON_SCREEN_REASON,
  SIDEBAR_NOT_READY_REASON,
  unpublishRenderedSidebarCounts,
  type RenderedSidebarCountsInput
} from './rendered-sidebar-counts'

const store = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => store.state } }))

const STUDIO_STATUS = new Map([
  [
    'studio',
    {
      status: { graphStatus: 'ready', appVersion: '1.12.21-local.1.abcdef123456' },
      checkedAt: 5
    }
  ]
])

function session(overrides: Partial<SidebarSession>): SidebarSession {
  return {
    rowKey: 'row',
    sessionKey: null,
    worktreeId: 'wt',
    hostId: null,
    tabId: 'tab',
    paneKey: 'tab:leaf',
    kind: 'terminal',
    label: 'Session',
    workspaceLabel: 'Work',
    agent: 'claude',
    unavailable: false,
    folderKeyMigration: null,
    ...overrides
  }
}

function input(overrides: Partial<RenderedSidebarCountsInput> = {}): RenderedSidebarCountsInput {
  const local = session({ rowKey: 'local-row', sessionKey: 'claude:1@local', hostId: 'local' })
  const peer = session({
    rowKey: 'peer-row',
    sessionKey: 'claude:2@studio',
    hostId: 'runtime:studio'
  })
  return {
    countedSessions: [local, peer],
    sessionCounts: new Map([
      ['local', 1],
      ['runtime:studio', 1]
    ]),
    hostOptions: [
      { id: 'local', label: 'This Mac', kind: 'local', health: 'ready' },
      { id: 'runtime:studio', label: 'Mac Studio', kind: 'runtime', health: 'ready' }
    ],
    hostFilter: { kinds: ['local', 'runtime'], hiddenHostIds: [] },
    archivedCount: 1,
    hiddenCount: 0,
    showArchived: false,
    archivedKeys: new Set(['claude:2@studio']),
    ready: true,
    ...overrides
  }
}

describe('rendered sidebar counts', () => {
  const appended: SessionFrameLogRecord[] = []
  const sidebar = {}

  beforeEach(() => {
    _resetRenderedSidebarCountsForTests()
    _resetSessionFrameLogForTests()
    store.state = { ...sessionTestSource(), runtimeStatusByEnvironmentId: STUDIO_STATUS }
    useSessionSidebarView.setState({ loaded: true, view: emptySessionSidebarView(), archived: [] })
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

  it('is unavailable, with no counts, until the sidebar renders', () => {
    expect(readRenderedSidebarCounts()).toMatchObject({
      available: false,
      reason: SIDEBAR_NOT_ON_SCREEN_REASON,
      onScreen: false,
      switchHostCounts: [],
      archivedCount: null,
      rows: []
    })
  })

  it('reads back the rendered counts, the switch rows apart from hosts with sessions', () => {
    const rendered = input({
      hostOptions: [
        ...input().hostOptions,
        { id: 'ssh:laptop', label: 'laptop', kind: 'ssh', health: 'offline' }
      ]
    })
    publishRenderedSidebarCounts(sidebar, rendered)

    const read = readRenderedSidebarCounts()
    expect(read).toMatchObject({
      available: true,
      onScreen: true,
      ready: true,
      switchHostCounts: [
        { hostId: 'local', label: 'This Mac', count: 1 },
        { hostId: 'runtime:studio', label: 'Mac Studio', count: 1 },
        { hostId: 'ssh:laptop', label: 'laptop', count: 0 }
      ],
      sessionCountsByHost: [
        { hostId: 'local', label: 'This Mac', count: 1 },
        { hostId: 'runtime:studio', label: 'Mac Studio', count: 1 }
      ],
      archivedCount: 1,
      archiveKeys: ['claude:2@studio'],
      rows: [
        { key: 'claude:1@local', hostId: 'local', archived: false },
        { key: 'claude:2@studio', hostId: 'runtime:studio', archived: true }
      ],
      hosts: [
        { hostId: 'local', reachable: null },
        {
          hostId: 'runtime:studio',
          reachable: true,
          graphStatus: 'ready',
          appVersion: '1.12.21-local.1.abcdef123456'
        },
        { hostId: 'ssh:laptop', health: 'offline' }
      ]
    })
    expect(read.readAt).toBeGreaterThanOrEqual(read.renderedAt!)
  })

  // Why (session counts, step 9): a row whose host is unknown is in no per-host count, so its
  // row says so instead of claiming this computer.
  it('counts a hostless row under an unknown computer, never as this one', () => {
    const base = input()
    const hostless = session({ rowKey: 'kept-row', sessionKey: 'claude:3@kept' })
    publishRenderedSidebarCounts(sidebar, {
      ...base,
      countedSessions: [...base.countedSessions, hostless]
    })

    const read = readRenderedSidebarCounts()
    expect(read.rows.map((row) => [row.key, row.hostId])).toEqual([
      ['claude:1@local', 'local'],
      ['claude:2@studio', 'runtime:studio'],
      ['claude:3@kept', 'unknown']
    ])
    expect(read.unknownHostCount).toBe(1)
    // Counted apart under `unknown`, so Home's list = `local` + `unknown`.
    expect(
      read.sessionCountsByHost.map(({ hostId, label, count }) => ({ hostId, label, count }))
    ).toEqual([
      { hostId: 'local', label: 'This Mac', count: 1 },
      { hostId: 'runtime:studio', label: 'Mac Studio', count: 1 },
      { hostId: 'unknown', label: null, count: 1 }
    ])
    // Session parity: a row with no host may be a paired computer's, so it is never this one's list.
    expect(read.sessionCountsByHost[2]).toMatchObject({
      ownerListed: 0,
      receiverOnly: 1,
      unverified: 1
    })
    expect(read.rows[2]).toMatchObject({
      bucket: 'receiverOnly',
      verification: 'unverified',
      bucketReason: 'unknown-host'
    })
  })

  it('names a workflow conversation by its workspace and anchor tab on either computer', () => {
    const base = input()
    const own = session({
      rowKey: 'own-flow',
      hostId: 'local',
      tabId: 'flow-tab',
      paneKey: null,
      workflow: { preset: 'council', status: 'unavailable', runId: 'run-1' }
    })
    const mirrored = session({
      rowKey: 'peer-flow',
      sessionKey: 'peer-flow',
      hostId: 'runtime:studio',
      tabId: null,
      paneKey: null,
      workflow: { preset: 'council', status: 'running', runId: 'run-2' },
      mirroredWorkflow: {
        environmentId: 'studio',
        hostTabId: 'studio-flow-tab',
        runId: 'run-2',
        archivedByOwner: false
      }
    })
    publishRenderedSidebarCounts(sidebar, { ...base, countedSessions: [own, mirrored] })

    expect(readRenderedSidebarCounts().rows.map((row) => row.workflowIdentity)).toEqual([
      JSON.stringify(['workflow', 'wt', 'flow-tab']),
      JSON.stringify(['workflow', 'wt', 'studio-flow-tab'])
    ])
  })

  it('stops answering once the sidebar unmounts, rather than serving stale counts', () => {
    publishRenderedSidebarCounts(sidebar, input())
    unpublishRenderedSidebarCounts(sidebar)

    expect(readRenderedSidebarCounts()).toMatchObject({
      available: false,
      reason: SIDEBAR_NOT_ON_SCREEN_REASON,
      onScreen: false,
      rows: []
    })
  })

  it('answers from another sidebar still on screen when one unmounts', () => {
    const technical = {}
    publishRenderedSidebarCounts(sidebar, input())
    publishRenderedSidebarCounts(technical, input({ archivedCount: 4 }))
    unpublishRenderedSidebarCounts(technical)

    expect(readRenderedSidebarCounts()).toMatchObject({ available: true, archivedCount: 1 })
  })

  it('reports not ready, with no zeros, while the window is still restoring sessions', () => {
    publishRenderedSidebarCounts(
      sidebar,
      input({ ready: false, countedSessions: [], sessionCounts: new Map(), archivedCount: 0 })
    )

    expect(readRenderedSidebarCounts()).toMatchObject({
      available: false,
      reason: SIDEBAR_NOT_READY_REASON,
      onScreen: true,
      ready: false,
      switchHostCounts: [],
      archivedCount: null
    })
  })

  it('logs a count change once, naming the rows that moved, and nothing when off', () => {
    publishRenderedSidebarCounts(sidebar, input())
    _flushSessionFrameLogForTests()
    expect(appended).toEqual([])

    setSessionFrameLogEnabled(true)
    publishRenderedSidebarCounts(sidebar, input())
    publishRenderedSidebarCounts(sidebar, input())
    const fewer = input()
    publishRenderedSidebarCounts(sidebar, {
      ...fewer,
      countedSessions: fewer.countedSessions.slice(0, 1),
      sessionCounts: new Map([['local', 1]])
    })
    unpublishRenderedSidebarCounts(sidebar)
    _flushSessionFrameLogForTests()

    const changes = appended.filter((record) => record.kind === 'renderer.sidebar-counts')
    expect(changes).toHaveLength(3)
    expect(changes[1]).toMatchObject({
      ready: true,
      sessionCountsByHost: [{ hostId: 'local', count: 1 }],
      addedRows: [],
      removedRows: ['claude:2@studio']
    })
    expect(changes[2]).toMatchObject({ onScreen: false })
  })
})

describe('session parity in the rendered counts (step 8)', () => {
  const sidebar = {}
  const STUDIO = `runtime:${LEDGER_ENV}`
  const HELD_PANE = makePaneKey('4c3e6035-ce3a-41cd-a874-7d9d1341abb2', SESSION_TEST_LEAF)
  const STRAY_PANE = makePaneKey('7e0f2a9b-1c3d-4e5f-8a9b-0c1d2e3f4a5b', SESSION_TEST_LEAF)

  /** This computer's own record of a paired owner's pane, on a plain-UUID tab (C4). */
  function addCapture(source: SidebarSessionSource, id: string, paneKey: string): void {
    source.sleepingAgentSessionsByPaneKey[paneKey] = {
      paneKey,
      tabId: paneKey.split(':')[0],
      worktreeId: SESSION_TEST_WORKTREE,
      agent: 'claude',
      providerSession: providerSession(id),
      prompt: '',
      state: 'working',
      capturedAt: 100,
      updatedAt: 100,
      origin: 'live'
    }
  }

  /** A receiver of the Studio: one listed record, a capture it holds unlisted, one it never named. */
  function receiver(bucket: Parameters<typeof ledgerBucket>[1] = {}): SidebarSessionSource {
    const source = pairedSource()
    addCapture(source, 'held', HELD_PANE)
    addCapture(source, 'stray', STRAY_PANE)
    return Object.assign(
      source,
      ledgerSlices([
        ledgerBucket([ledgerRecord('s1'), ledgerRecord('held', { listed: false })], bucket)
      ])
    )
  }

  function publishFrom(
    source: SidebarSessionSource,
    counted?: (sessions: SidebarSession[]) => SidebarSession[],
    background = 0
  ): SidebarSession[] {
    store.state = {
      ...source,
      runtimeStatusByEnvironmentId: new Map(),
      workspaceSessionReady: true
    }
    const sessions = buildSidebarSessions(source)
    const shown = counted ? counted(sessions) : sessions
    const counts = sessionCountsByHost(shown)
    counts.set(
      STUDIO as `runtime:${string}`,
      (counts.get(STUDIO as `runtime:${string}`) ?? 0) + background
    )
    publishRenderedSidebarCounts(sidebar, {
      countedSessions: shown,
      sessionCounts: counts,
      hostOptions: [{ id: STUDIO, label: 'Mac Studio', kind: 'runtime', health: 'ready' }],
      hostFilter: { kinds: ['local', 'runtime'], hiddenHostIds: [] },
      archivedCount: 0,
      hiddenCount: 0,
      showArchived: false,
      archivedKeys: new Set(),
      ready: true
    })
    return sessions
  }

  beforeEach(() => {
    _resetRenderedSidebarCountsForTests()
    useSessionSidebarView.setState({ loaded: true, view: emptySessionSidebarView(), archived: [] })
  })

  it('splits each host count by bucket, the buckets summing to the count (nothing hidden)', () => {
    publishFrom(receiver())

    const read = readRenderedSidebarCounts()
    const studio = read.sessionCountsByHost.find((host) => host.hostId === STUDIO)!
    expect(studio).toMatchObject({
      count: 3,
      ownerListed: 1,
      heldByOwner: 1,
      receiverOnly: 1,
      workflow: 0,
      unverified: 1,
      stale: 0
    })
    expect(
      studio.ownerListed! + studio.heldByOwner! + studio.receiverOnly! + studio.workflow!
    ).toBe(studio.count)
    expect(read.switchHostCounts[0]).toMatchObject({ hostId: STUDIO, count: 3, ownerListed: 1 })
    const byIdentity = new Map(read.rows.map((row) => [row.identity, row]))
    // The ledger's record row is the owner's; the capture it holds unlisted is heldByOwner (G1).
    expect(byIdentity.get(`c:${conversationDigest('s1')}`)).toMatchObject({
      bucket: 'ownerListed',
      verification: 'verified',
      rest: 'asleep'
    })
    expect(byIdentity.get(`c:${conversationDigest('held')}`)).toMatchObject({
      bucket: 'heldByOwner',
      verification: 'verified'
    })
    // A capture no ledger record names is listed only here and can't be verified.
    expect(byIdentity.get(`c:${conversationDigest('stray')}`)).toMatchObject({
      bucket: 'receiverOnly',
      verification: 'unverified',
      bucketReason: 'absence-unverified',
      ownershipUnverified: 'absence-unverified'
    })
  })

  it('flags the rows of a snapshot restored before any live set as stale', () => {
    publishFrom(receiver({ stale: true, ownerState: 'stale' }))

    const read = readRenderedSidebarCounts()
    expect(read.rows.find((row) => row.bucket === 'ownerListed')).toMatchObject({
      verification: 'stale',
      stale: true
    })
    expect(read.sessionCountsByHost.find((host) => host.hostId === STUDIO)).toMatchObject({
      ownerListed: 1,
      stale: 2
    })
  })

  it("reports every paired owner's ledger state: ready, stale, older or unreachable (G2)", () => {
    const source = receiver()
    Object.assign(source, {
      mirroredConversationOwnersByEnvironment: {
        [LEDGER_ENV]: ledgerOwner({ revision: 4 }),
        'env-mini': ledgerOwner({
          environmentId: 'env-mini',
          state: 'unreachable',
          asOf: LEDGER_T0 - 60_000
        }),
        'env-old': ledgerOwner({
          environmentId: 'env-old',
          state: 'older',
          generation: null,
          revision: null,
          source: null,
          asOf: null
        }),
        'env-restored': ledgerOwner({ environmentId: 'env-restored', state: 'stale' })
      }
    })
    publishFrom(source)

    const ledgers = readRenderedSidebarCounts().ownerLedgers ?? []
    expect([...ledgers].sort((a, b) => a.hostId.localeCompare(b.hostId))).toEqual([
      {
        hostId: 'runtime:env-mini',
        generation: 'gen-1',
        revision: 1,
        source: 'window',
        state: 'unreachable',
        asOf: LEDGER_T0 - 60_000
      },
      {
        hostId: 'runtime:env-old',
        generation: null,
        revision: null,
        source: null,
        state: 'older',
        asOf: null
      },
      {
        hostId: 'runtime:env-restored',
        generation: 'gen-1',
        revision: 1,
        source: 'window',
        state: 'stale',
        asOf: LEDGER_T0
      },
      {
        hostId: STUDIO,
        generation: 'gen-1',
        revision: 4,
        source: 'window',
        state: 'ready',
        asOf: LEDGER_T0
      }
    ])
  })

  it('exports the unfiltered population beside the filtered rows, even with the sidebar off screen', () => {
    // As if a tag filter left only the owner's row in the list.
    publishFrom(receiver(), (sessions) =>
      sessions.filter((row) => row.mirroredConversation?.listed)
    )

    const read = readRenderedSidebarCounts()
    expect(read.rows).toHaveLength(1)
    expect(read.parity?.rows.map((row) => [row.identity, row.bucket])).toEqual(
      [
        [`c:${conversationDigest('held')}`, 'heldByOwner'],
        [`c:${conversationDigest('s1')}`, 'ownerListed'],
        [`c:${conversationDigest('stray')}`, 'receiverOnly']
      ].sort((a, b) => a[0]!.localeCompare(b[0]!))
    )
    expect(read.parity?.countsByHost).toEqual([
      {
        hostId: STUDIO,
        count: 3,
        ownerListed: 1,
        heldByOwner: 1,
        receiverOnly: 1,
        workflow: 0,
        unverified: 1,
        stale: 0,
        archived: 0
      }
    ])
    expect(read.parity?.ownerLedgers).toEqual([expect.objectContaining({ hostId: STUDIO })])

    unpublishRenderedSidebarCounts(sidebar)
    const offScreen = readRenderedSidebarCounts()
    expect(offScreen).toMatchObject({ available: false, reason: SIDEBAR_NOT_ON_SCREEN_REASON })
    expect(offScreen.parity).toEqual(read.parity)
  })

  it('counts terminals the switch shows beyond its rows as background, not as any bucket', () => {
    publishFrom(receiver(), undefined, 2)

    expect(
      readRenderedSidebarCounts().sessionCountsByHost.find((host) => host.hostId === STUDIO)
    ).toMatchObject({ count: 5, ownerListed: 1, heldByOwner: 1, receiverOnly: 1, background: 2 })
  })
})
