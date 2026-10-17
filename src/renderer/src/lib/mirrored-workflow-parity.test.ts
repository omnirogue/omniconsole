import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore, type AppState } from '@/store'
import type { Repo } from '../../../shared/repo-types'
import {
  sessionWorkflowConversationIdentity,
  type RuntimeSessionWorkflowRecord,
  type RuntimeSessionWorkflowRecordSet
} from '../../../shared/session-workflow-records'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type { Worktree } from '../../../shared/worktree/types'
import { buildSessionWorkflowRecords } from '@/runtime/session-workflow-record-publication'
import { resetWebSessionTabsSyncTestState } from '@/runtime/web-session-tabs-sync-test-harness'
import { applyMirroredWorkflowRecords } from '@/runtime/web-session-workflow-records'
import { conversationViewKey } from './conversation-view'
import { mirroredWorkflowOwnerArchivedKeys } from './mirrored-workflow-rows'
import { sessionCountsByHost } from './session-host-scope'
import { sessionManageWorkflowAnchor } from './session-manage-workflow-anchor'
import { SESSION_TEST_WORKTREE, sessionTestSource } from './sidebar-session-test-fixtures'
import { buildSidebarSessions, type SidebarSession } from './sidebar-sessions'
import { buildSessionManageSidebarRows } from './session-manage-sidebar-rows'
import { emptySessionSidebarView } from './session-sidebar-view'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'

vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: () => null
}))

const ENV = 'studio'
const STUDIO = 'runtime:studio'
const WT = SESSION_TEST_WORKTREE

function ownerState(extra: Partial<AppState> = {}): AppState {
  const source = sessionTestSource()
  source.tabsByWorktree[WT] = [
    {
      id: 'tab-w',
      worktreeId: WT,
      ptyId: null,
      title: 'Which cache?',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 10,
      localWorkflow: { preset: 'council', prompt: 'Q', executionId: 'execution-1' }
    } satisfies TerminalTab
  ]
  return {
    ...source,
    localWorkflowStatusByTabId: {},
    localWorkflowHydrationByTabId: {
      'tab-w': { runId: 'execution-1', outcome: 'failed', attempts: 3 }
    },
    buildReview: { pipelinesById: {}, pipelinesListed: false },
    ...extra
  } as unknown as AppState
}

const recovered = {
  localWorkflowStatusByTabId: {
    'tab-w': {
      conversationId: 'tab-w',
      executionId: 'execution-1',
      preset: 'council' as const,
      state: 'completed' as const,
      running: 0,
      completed: 3,
      total: 3
    }
  }
}

let revision = 0

/** The controller's store taking a publication: a new revision whenever the set changes. */
function ownerSet(
  recordsByWorktree: Record<string, RuntimeSessionWorkflowRecord[]>
): RuntimeSessionWorkflowRecordSet {
  revision += 1
  return { generation: 'owner-gen', revision, complete: true, recordsByWorktree }
}

/** The set as a subscribeAll `workflowRecords` event on a running stream. */
function deliver(value: RuntimeSessionWorkflowRecordSet): void {
  applyMirroredWorkflowRecords(ENV, value, { fresh: false, source: 'subscribeAll' })
}

function receiverRows(): SidebarSession[] {
  return buildSidebarSessions({
    ...sessionTestSource(),
    runtimeStatusByEnvironmentId: new Map([[ENV, { status: { graphStatus: 'ready' } }]]) as never,
    mirroredWorkflowRecordsByOwner: useAppStore.getState().mirroredWorkflowRecordsByOwner
  })
}

function identity(row: SidebarSession): string {
  return sessionWorkflowConversationIdentity(
    row.worktreeId,
    row.mirroredWorkflow?.hostTabId ?? row.tabId!
  )
}

describe('workflow conversations counted on both computers (step 9, A4)', () => {
  beforeEach(() => {
    resetWebSessionTabsSyncTestState()
    useAppStore.setState({ mirroredWorkflowRecordsByOwner: {} })
    revision = 0
  })

  it('a record published by its controller appears once on the receiver, same identity and archive state', () => {
    const owner = ownerState()
    const ownerRow = buildSidebarSessions(owner).find((row) => row.workflow)!
    const archived = new Set([conversationViewKey(ownerRow)])
    const published = ownerSet(buildSessionWorkflowRecords(owner, archived))
    // The initial inventory, the inventory a reconnect replays (fresh, like every inventory) with
    // the same set, then a listAll: the same revision every time.
    applyMirroredWorkflowRecords(ENV, published, { fresh: true, source: 'subscribeAll-inventory' })
    applyMirroredWorkflowRecords(ENV, structuredClone(published), {
      fresh: true,
      source: 'subscribeAll-inventory'
    })
    applyMirroredWorkflowRecords(ENV, structuredClone(published), {
      fresh: true,
      source: 'listAll'
    })

    const rows = receiverRows().filter((row) => row.workflow)
    expect(rows).toHaveLength(1)
    expect(identity(rows[0]!)).toBe(identity(ownerRow))
    expect(rows[0]).toMatchObject({ hostId: STUDIO, tabId: null, paneKey: null })
    expect(rows[0]!.workflow).toMatchObject({ preset: 'council', status: 'unavailable' })
    expect(
      mirroredWorkflowOwnerArchivedKeys(useAppStore.getState().mirroredWorkflowRecordsByOwner)
    ).toEqual([conversationViewKey(rows[0]!)])
  })

  it.each([
    ['unavailable', {}, false],
    ['recovered', recovered, false],
    ['archived', recovered, true]
  ] as const)(
    'per-host counts agree with a no-pane workflow %s',
    (_state, extra, archivedOnOwner) => {
      const owner = ownerState(extra)
      const ownerRows = buildSidebarSessions(owner)
      const ownerFlow = ownerRows.find((row) => row.workflow)!
      const ownerArchived = new Set(archivedOnOwner ? [conversationViewKey(ownerFlow)] : [])
      deliver(ownerSet(buildSessionWorkflowRecords(owner, ownerArchived)))

      const rows = receiverRows()
      const receiverArchived = new Set(
        mirroredWorkflowOwnerArchivedKeys(useAppStore.getState().mirroredWorkflowRecordsByOwner)
      )
      // The owner's own conversations equal the receiver's group for it, by identity and count.
      expect(sessionCountsByHost(ownerRows).get('local')).toBe(1)
      expect(sessionCountsByHost(rows).get(STUDIO)).toBe(1)
      expect(rows.map(identity)).toEqual(ownerRows.map(identity))
      expect(rows[0]!.workflow!.status).toBe(ownerFlow.workflow!.status)
      expect(rows.filter((row) => receiverArchived.has(conversationViewKey(row)))).toHaveLength(
        ownerRows.filter((row) => ownerArchived.has(conversationViewKey(row))).length
      )
    }
  )

  it('follows the controller from status unavailable to its recovered status', () => {
    deliver(ownerSet(buildSessionWorkflowRecords(ownerState(), new Set())))
    expect(receiverRows()[0]!.workflow!.status).toBe('unavailable')
    deliver(ownerSet(buildSessionWorkflowRecords(ownerState(recovered), new Set())))
    expect(receiverRows()[0]!.workflow!.status).toBe('done')
  })

  it('never republishes a peer workflow record, only this window’s own runs', () => {
    deliver(ownerSet(buildSessionWorkflowRecords(ownerState(), new Set())))
    // The receiver's real tabs: its own workflow, a terminal mirrored from the Studio, and a
    // mirrored row that somehow carries a workflow anchor (an echo). Its mirrored workflow
    // records sit in their own slice.
    const own: TerminalTab = {
      id: 'own-flow',
      worktreeId: WT,
      ptyId: null,
      title: 'Mine',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1,
      localWorkflow: { preset: 'discover', prompt: 'Q' }
    }
    const mirror: TerminalTab = {
      ...own,
      id: toWebTerminalSurfaceTabId('studio-tab::leaf'),
      title: 'Studio shell',
      ptyId: 'runtime:studio@@pty-1',
      localWorkflow: undefined
    }
    const echo: TerminalTab = {
      ...own,
      id: toWebTerminalSurfaceTabId('tab-w::leaf'),
      title: 'Which cache?'
    }
    const receiver = {
      ...ownerState(),
      tabsByWorktree: { [WT]: [own, mirror, echo] },
      mirroredWorkflowRecordsByOwner: useAppStore.getState().mirroredWorkflowRecordsByOwner
    } as unknown as AppState
    // The receiver's own list, built from those real tabs: the peer's workflow appears once (its
    // mirrored record); neither the terminal mirror nor the echo adds a second workflow row.
    const rows = buildSidebarSessions({
      ...receiver,
      runtimeStatusByEnvironmentId: new Map([[ENV, { status: { graphStatus: 'ready' } }]])
    } as unknown as AppState)
    const workflowRows = rows.filter((row) => row.workflow)
    expect(workflowRows.map((row) => [identity(row), row.displayHostId ?? row.hostId])).toEqual([
      [sessionWorkflowConversationIdentity(WT, 'own-flow'), 'local'],
      [sessionWorkflowConversationIdentity(WT, 'tab-w'), STUDIO]
    ])
    expect(sessionCountsByHost(workflowRows).get(STUDIO)).toBe(1)

    const published = buildSessionWorkflowRecords(receiver, new Set())
    expect(
      Object.values(published)
        .flat()
        .map((entry) => entry.tabId)
    ).toEqual(['own-flow'])
  })

  // One rule on both computers: a workflow counts under the computer whose window runs it.
  it('counts a workflow run in a peer’s workspace under its controller on both computers', () => {
    // The MacBook runs a Council in a workspace the Studio owns.
    const macbook = ownerState({
      repos: [
        { id: 'repo-a', displayName: 'Project A', executionHostId: STUDIO } as unknown as Repo
      ],
      worktreesByRepo: {
        'repo-a': [
          { id: WT, repoId: 'repo-a', displayName: 'main', hostId: STUDIO } as unknown as Worktree
        ]
      }
    })
    const macbookRows = buildSidebarSessions(macbook).filter((row) => row.workflow)
    expect(macbookRows).toHaveLength(1)
    expect([...sessionCountsByHost(macbookRows)]).toEqual([['local', 1]])
    // Its identity and archive key still name the workspace's host, so archive marks keep working.
    expect(macbookRows[0]!.rowKey).toBe(JSON.stringify([STUDIO, WT, 'tab-w']))

    // The Studio mirrors the MacBook's set and counts it under the MacBook.
    applyMirroredWorkflowRecords(
      'macbook',
      ownerSet(buildSessionWorkflowRecords(macbook, new Set())),
      {
        fresh: true,
        source: 'listAll'
      }
    )
    const studioRows = buildSidebarSessions({
      ...sessionTestSource(),
      runtimeStatusByEnvironmentId: new Map([['macbook', { status: { graphStatus: 'ready' } }]]),
      mirroredWorkflowRecordsByOwner: useAppStore.getState().mirroredWorkflowRecordsByOwner
    } as never).filter((row) => row.workflow)
    expect([...sessionCountsByHost(studioRows)]).toEqual([['runtime:macbook', 1]])
    expect(studioRows.map(identity)).toEqual(macbookRows.map(identity))
  })

  // Minor (f): a workflow this computer runs in a workspace a paired computer owns is its run.
  it('publishes a workflow this window runs in a workspace a peer owns', () => {
    const peerOwned = ownerState({
      repos: [
        { id: 'repo-a', displayName: 'Project A', executionHostId: STUDIO } as unknown as Repo
      ],
      worktreesByRepo: {
        'repo-a': [
          { id: WT, repoId: 'repo-a', displayName: 'main', hostId: STUDIO } as unknown as Worktree
        ]
      }
    })
    expect(buildSessionWorkflowRecords(peerOwned, new Set())[WT]).toEqual([
      expect.objectContaining({ tabId: 'tab-w', status: 'unavailable', runId: 'execution-1' })
    ])
  })

  it('keeps a mirrored workflow out of this computer’s own workflow management', () => {
    deliver(ownerSet(buildSessionWorkflowRecords(ownerState(), new Set())))
    const row = receiverRows().find((entry) => entry.workflow)!
    expect(sessionManageWorkflowAnchor(row)).toBeUndefined()
    expect(sessionManageWorkflowAnchor({ ...row, mirroredWorkflow: undefined })).toMatchObject({
      controller: 'local'
    })
  })

  // Minor (d): `omni session list` reads the controller's archive mark too, read-only.
  it('lists a mirrored workflow its controller archived as archived, never as this computer’s', () => {
    useSessionSidebarView.setState({ loaded: true, view: emptySessionSidebarView(), archived: [] })
    useSessionFolders.setState({
      loaded: true,
      metadata: { version: 1, folders: [], membership: {} }
    })
    const owner = ownerState()
    const ownerRow = buildSidebarSessions(owner).find((row) => row.workflow)!
    deliver(ownerSet(buildSessionWorkflowRecords(owner, new Set([conversationViewKey(ownerRow)]))))
    const receiver = {
      ...ownerState(),
      tabsByWorktree: {},
      runtimeStatusByEnvironmentId: new Map([[ENV, { status: { graphStatus: 'ready' } }]]),
      mirroredWorkflowRecordsByOwner: useAppStore.getState().mirroredWorkflowRecordsByOwner
    } as unknown as AppState

    const row = buildSessionManageSidebarRows(receiver, 1_000).find(
      (entry) => entry.workflow === undefined && entry.hostId === STUDIO
    )!
    expect(row).toMatchObject({ archived: true, archivedByHand: false, paneKey: null })
  })
})
