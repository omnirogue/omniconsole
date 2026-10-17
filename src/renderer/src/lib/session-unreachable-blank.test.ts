import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import { unreachableBlankEvidence } from '../../../shared/session-steward-unreachable-blank'
import type { SessionFolderMetadata } from './session-folders'
import type { SessionSidebarView } from './session-sidebar-view'
import type { PursuitSidebarTreeRow } from './session-sidebar-tree-rows'

const mocks = vi.hoisted(() => ({
  view: { loaded: true, archiveStorageReady: true, view: {} as Record<string, unknown> },
  setClocks: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/store/session-folders', () => ({
  useSessionFolders: { getState: () => ({ loaded: true }) }
}))
vi.mock('@/store/session-sidebar-view', () => ({
  useSessionSidebarView: {
    getState: () => ({ ...mocks.view, setUnreachableBlankClocks: mocks.setClocks })
  }
}))
vi.mock('./account-sync/session-organization-intent', () => ({
  sessionOrganizationScope: () => 'scope'
}))
vi.mock('./session-manage-sidebar-rows', () => ({ buildSessionManageSidebarRows: () => [] }))

const { sessionUnreachableBlankRevision, unreachableBlankRefusal } =
  await import('./session-unreachable-blank')
const { updateUnreachableBlankClocks } = await import('./session-unreachable-blank-clocks')

const DAY = 24 * 60 * 60_000
const NOW = 10 * DAY

function treeRow(session: Record<string, unknown> = {}): PursuitSidebarTreeRow {
  return {
    session: {
      rowKey: 'row-1',
      sessionKey: 'session-1',
      worktreeId: 'wt-1',
      hostId: 'ssh:devbox',
      tabId: 'tab-1',
      paneKey: 'tab-1:leaf-1',
      kind: 'terminal',
      label: 'claude conversation',
      agent: 'claude',
      unavailable: true,
      ...session
    }
  } as unknown as PursuitSidebarTreeRow
}
const metadata = { folders: [], membership: {} } as unknown as SessionFolderMetadata
const view = { version: 1, collapsed: [], hidden: [], order: [] } as SessionSidebarView
const state = (status: string | null) =>
  ({
    agentStatusByPaneKey: {},
    sshConnectionStates: new Map(status ? [['devbox', { targetId: 'devbox', status }]] : [])
  }) as unknown as AppState

beforeEach(() => {
  mocks.view = { loaded: true, archiveStorageReady: true, view: {} }
  mocks.setClocks.mockReset()
})

describe('the window’s reading of a blank row on an unreachable SSH host', () => {
  it('reads a revision only once the host was tried and not reached', () => {
    const revision = sessionUnreachableBlankRevision(
      treeRow(),
      state('reconnection-failed'),
      metadata,
      view,
      true
    )
    expect(revision).toEqual(expect.any(String))
    // Still deciding: the clock is kept, never started.
    for (const status of [null, 'connecting', 'reconnecting', 'disconnected']) {
      expect(sessionUnreachableBlankRevision(treeRow(), state(status), metadata, view, true)).toBe(
        undefined
      )
    }
    // Why the stored title: a generated title appearing later does not move the revision.
    const custom = sessionUnreachableBlankRevision(
      treeRow({ customTitle: 'claude session' }),
      state('error'),
      metadata,
      view,
      true
    )
    expect(custom).not.toBe(revision)
  })

  it('reads nothing for a reachable, titled, prompted or conversation-bearing row', () => {
    for (const session of [
      { unavailable: false },
      { hostId: 'local' },
      { label: 'Fix the parser' },
      { customTitle: 'Fix the parser' },
      { providerSession: { key: 'session_id', id: 'abc' } }
    ]) {
      expect(
        sessionUnreachableBlankRevision(treeRow(session), state('error'), metadata, view, true),
        JSON.stringify(session)
      ).toBeNull()
    }
    expect(
      sessionUnreachableBlankRevision(treeRow(), state('error'), metadata, view, false)
    ).toBeNull()
  })
})

describe('the third rule’s clock and last check', () => {
  it('keeps a clock through an undecided host, restarts it on a change, drops it otherwise', () => {
    mocks.view.view = {
      unreachableBlankClocks: {
        kept: { revision: 'r1', since: 5 },
        deciding: { revision: 'r2', since: 6 },
        moved: { revision: 'old', since: 7 },
        gone: { revision: 'r4', since: 8 }
      }
    }
    updateUnreachableBlankClocks(
      [
        { viewKey: 'kept', unreachableBlankRevision: 'r1' },
        { viewKey: 'deciding', unreachableBlankRevision: undefined },
        { viewKey: 'moved', unreachableBlankRevision: 'new' },
        { viewKey: 'gone', unreachableBlankRevision: null },
        { viewKey: 'undecided-new', unreachableBlankRevision: undefined }
      ],
      NOW
    )
    expect(mocks.setClocks).toHaveBeenCalledWith({
      kept: { revision: 'r1', since: 5 },
      deciding: { revision: 'r2', since: 6 },
      moved: { revision: 'new', since: NOW }
    })
  })

  it('lets the archive through only on the same revision, a day old, with its token', () => {
    const row = {
      viewKey: 'view-1',
      unreachableBlankRevision: 'r1',
      unreachableBlankPolicy: { revision: 'r1', since: NOW - DAY }
    }
    const evidence = `blank · unreachable 24 h; ${unreachableBlankEvidence('view-1', 'r1')}`
    expect(unreachableBlankRefusal(row, evidence, NOW)).toBeNull()
    expect(unreachableBlankRefusal(row, 'blank', NOW)).not.toBeNull()
    expect(unreachableBlankRefusal(row, evidence, NOW - 1)).not.toBeNull()
    expect(
      unreachableBlankRefusal({ ...row, unreachableBlankRevision: 'r2' }, evidence, NOW)
    ).not.toBeNull()
    expect(
      unreachableBlankRefusal({ ...row, unreachableBlankRevision: null }, evidence, NOW)
    ).not.toBeNull()
  })
})
