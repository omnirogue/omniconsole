import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { indexPersistedPtySurfaceBindings } from './persisted-terminal-surface-bindings'
import { OrcaRuntimeService } from './omni-runtime'

const WORKSPACE = 'folder:597c3c95-3a92-449f-9a6d-c0b49eab8106'
const LEAF = '37ea54aa-c387-4b05-a714-92a756e4bc72'
const HOST_TAB = 'cc1326af-0a02-498a-99ca-80ffb8a4808d'
const MIRROR_TAB = 'web-terminal-9aea1d37-ea11-4120-98d9-a9e69a2de728'
const PTY = `${WORKSPACE}@@ea48a9bf`
const INCARNATION = '14041ffb-daf3-4f2e-ad5b-b1ad24b40e17'

function duplicateSurfaceSession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKSPACE]: [MIRROR_TAB, HOST_TAB].map((id) => ({
        id,
        ptyId: PTY,
        worktreeId: WORKSPACE,
        title: id,
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }))
    },
    terminalLayoutsByTabId: Object.fromEntries(
      [MIRROR_TAB, HOST_TAB].map((id) => [
        id,
        {
          root: { type: 'leaf' as const, leafId: LEAF },
          activeLeafId: LEAF,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF]: PTY }
        }
      ])
    ),
    terminalPtyIncarnationsByPaneKey: {
      [makePaneKey(HOST_TAB, LEAF)]: INCARNATION,
      [makePaneKey(MIRROR_TAB, LEAF)]: INCARNATION
    },
    tabGroups: {
      [WORKSPACE]: [
        { id: 'group', worktreeId: WORKSPACE, activeTabId: HOST_TAB, tabOrder: [HOST_TAB] }
      ]
    }
  }
}

describe('persisted host terminal surface recovery', () => {
  it('uses the unique grouped host surface for an exact ungrouped web mirror without rewriting either row', () => {
    const session = duplicateSurfaceSession()
    const before = structuredClone(session)
    expect(indexPersistedPtySurfaceBindings(session).get(PTY)).toEqual({
      worktreeId: WORKSPACE,
      tabId: HOST_TAB,
      paneKey: makePaneKey(HOST_TAB, LEAF),
      incarnationId: INCARNATION
    })
    expect(session).toEqual(before)
    session.tabsByWorktree[WORKSPACE].reverse()
    expect(indexPersistedPtySurfaceBindings(session).get(PTY)?.tabId).toBe(HOST_TAB)
  })

  it('refuses competing grouped surfaces', () => {
    const session = duplicateSurfaceSession()
    session.tabGroups![WORKSPACE][0].tabOrder.push(MIRROR_TAB)
    expect(indexPersistedPtySurfaceBindings(session).has(PTY)).toBe(false)
  })

  it('refuses duplicate bindings without saved host group proof', () => {
    const session = duplicateSurfaceSession()
    session.tabGroups = {}
    expect(indexPersistedPtySurfaceBindings(session).has(PTY)).toBe(false)
  })

  it('refuses a different incarnation in the ungrouped mirror', () => {
    const session = duplicateSurfaceSession()
    session.terminalPtyIncarnationsByPaneKey![makePaneKey(MIRROR_TAB, LEAF)] = 'other-incarnation'
    expect(indexPersistedPtySurfaceBindings(session).has(PTY)).toBe(false)
  })

  it('refuses a different leaf in the ungrouped mirror', () => {
    const session = duplicateSurfaceSession()
    const otherLeaf = '47ea54aa-c387-4b05-a714-92a756e4bc72'
    session.terminalLayoutsByTabId[MIRROR_TAB].ptyIdsByLeafId = { [otherLeaf]: PTY }
    session.terminalPtyIncarnationsByPaneKey![makePaneKey(MIRROR_TAB, otherLeaf)] = INCARNATION
    expect(indexPersistedPtySurfaceBindings(session).has(PTY)).toBe(false)
  })

  it('refuses a mirror bound to another workspace', () => {
    const session = duplicateSurfaceSession()
    const [mirror] = session.tabsByWorktree[WORKSPACE].splice(0, 1)
    session.tabsByWorktree['folder:another'] = [{ ...mirror!, worktreeId: 'folder:another' }]
    expect(indexPersistedPtySurfaceBindings(session).has(PTY)).toBe(false)
  })

  it('uses the unique grouped host surface over an exact ungrouped host duplicate and its web mirror', () => {
    const session = duplicateSurfaceSession()
    const ordinaryTab = '9aea1d37-ea11-4120-98d9-a9e69a2de728'
    session.tabsByWorktree[WORKSPACE].splice(1, 0, {
      ...session.tabsByWorktree[WORKSPACE][0],
      id: ordinaryTab
    })
    session.terminalLayoutsByTabId[ordinaryTab] = session.terminalLayoutsByTabId[MIRROR_TAB]
    session.terminalPtyIncarnationsByPaneKey![makePaneKey(ordinaryTab, LEAF)] = INCARNATION
    const before = structuredClone(session)
    expect(indexPersistedPtySurfaceBindings(session).get(PTY)).toEqual({
      worktreeId: WORKSPACE,
      tabId: HOST_TAB,
      paneKey: makePaneKey(HOST_TAB, LEAF),
      incarnationId: INCARNATION
    })
    expect(session).toEqual(before)
    session.tabsByWorktree[WORKSPACE].reverse()
    expect(indexPersistedPtySurfaceBindings(session).get(PTY)?.tabId).toBe(HOST_TAB)
  })

  it('does not restore a retired grouped surface', () => {
    const session = duplicateSurfaceSession()
    session.terminalSurfaceTombstonesByPaneKey = {
      [makePaneKey(HOST_TAB, LEAF)]: {
        worktreeId: WORKSPACE,
        parentTabId: HOST_TAB,
        leafId: LEAF,
        ptyId: PTY,
        incarnationId: INCARNATION,
        retiredAt: 1
      }
    }
    expect(indexPersistedPtySurfaceBindings(session).has(PTY)).toBe(false)
  })

  it('preserves a unique legacy ungrouped surface', () => {
    const session = duplicateSurfaceSession()
    session.tabsByWorktree[WORKSPACE].shift()
    session.tabGroups = {}
    expect(indexPersistedPtySurfaceBindings(session).get(PTY)?.tabId).toBe(HOST_TAB)
  })

  it('restores a daemon folder PTY and its exact host pane through ordinary inventory without spawning or saving', async () => {
    const session = duplicateSurfaceSession()
    const setWorkspaceSession = vi.fn()
    const spawn = vi.fn()
    const kill = vi.fn()
    const runtime = new OrcaRuntimeService({
      getWorkspaceSession: () => session,
      setWorkspaceSession,
      getRepos: () => [],
      getRepo: () => undefined,
      getWorktreeMeta: () => undefined,
      getAllWorktreeMeta: () => ({}),
      getSettings: () => ({}),
      getProjects: () => [],
      getProjectGroups: () => [],
      getFolderWorkspaces: () => [
        {
          id: WORKSPACE.slice('folder:'.length),
          folderPath: '/tmp/work',
          name: 'Work',
          connectionId: null,
          projectGroupId: null,
          isArchived: false
        }
      ]
    } as never)
    runtime.setPtyController({
      spawn,
      kill,
      write: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: PTY,
          incarnationId: INCARNATION,
          terminalHandle: 'term_daemon',
          cwd: '',
          title: 'shell'
        }
      ]
    } as never)
    const internals = runtime as unknown as {
      refreshPtyWorktreeRecordsWithControllerInventory: (worktrees: []) => Promise<unknown>
      ptysById: Map<
        string,
        {
          worktreeId: string
          tabId: string
          paneKey: string
          incarnationId: string
          connected: boolean
        }
      >
    }

    await internals.refreshPtyWorktreeRecordsWithControllerInventory([])

    expect(internals.ptysById.get(PTY)).toMatchObject({
      worktreeId: WORKSPACE,
      tabId: HOST_TAB,
      paneKey: makePaneKey(HOST_TAB, LEAF),
      incarnationId: INCARNATION,
      connected: true
    })
    expect(setWorkspaceSession).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
    expect((await runtime.listTerminals()).terminals).toEqual([
      expect.objectContaining({
        handle: 'term_daemon',
        ptyId: PTY,
        incarnationId: INCARNATION,
        tabId: HOST_TAB,
        leafId: LEAF,
        orphaned: false,
        connected: true
      })
    ])
  })
})
