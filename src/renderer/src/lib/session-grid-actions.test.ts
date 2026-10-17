// @vitest-environment happy-dom
import { subscribeSessionGridPaneFlash } from './session-grid-pane-flash'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionGrid } from '@/store/session-grid'
import type { SidebarSession } from './sidebar-sessions'
import { sessionGridContentForSession } from './session-grid-panes'

const mocks = vi.hoisted(() => ({
  state: { activeView: 'grid', settings: { commandCenter: false }, setActiveView: vi.fn() },
  activate: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('./activate-sidebar-session', () => ({ activateSidebarSession: mocks.activate }))
vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: () => null
}))
import { dropOnSessionGrid, focusSessionInGrid, resumeSessionInGrid } from './session-grid-actions'

const row: SidebarSession = {
  rowKey: 'row',
  sessionKey: 'local|row',
  hostId: 'local',
  worktreeId: 'wt',
  tabId: 'tab',
  paneKey: 'pane',
  kind: 'terminal',
  label: 'Session',
  workspaceLabel: 'Workspace',
  agent: 'claude',
  unavailable: false,
  folderKeyMigration: null
}

beforeEach(() => {
  useSessionGrid.getState().cancelPendingWrites()
  localStorage.clear()
  vi.clearAllMocks()
  useSessionGrid.setState(useSessionGrid.getInitialState(), true)
})

afterEach(() => useSessionGrid.getState().cancelPendingWrites())

describe('command-center session grid activation', () => {
  it.each(['left', 'right', 'top', 'bottom', 'center', 'empty'] as const)(
    'places content through the existing %s drop zone',
    (zone) => {
      mocks.state.settings.commandCenter = true
      useSessionGrid.getState().load(true)
      const anchor = useSessionGrid.getState().addPane({ kind: 'view', viewId: 'terminal' })
      if (anchor.status === 'full') {
        throw new Error('fixture full')
      }
      const before = useSessionGrid.getState().layout.tracks.flat().length
      expect(
        dropOnSessionGrid(zone === 'empty' ? null : { paneId: anchor.paneId, zone }, {
          payload: { kind: 'content', content: sessionGridContentForSession(row) },
          sidebarKeys: []
        })
      ).toBe(true)
      const panes = Object.values(useSessionGrid.getState().panes)
      expect(
        panes.some((pane) => pane.kind === 'session' && pane.sessionKey === row.sessionKey)
      ).toBe(true)
      expect(useSessionGrid.getState().layout.tracks.flat().length).toBe(
        before + (zone === 'center' ? 0 : 1)
      )
      expect(mocks.activate).not.toHaveBeenCalled()
    }
  )
  it('focuses and flashes a duplicate without replacing its drop target or starting a session', () => {
    mocks.state.settings.commandCenter = true
    useSessionGrid.getState().load(true)
    const original = useSessionGrid.getState().addPane(sessionGridContentForSession(row))
    const target = useSessionGrid.getState().addPane({ kind: 'view', viewId: 'terminal' })
    if (original.status === 'full' || target.status === 'full') {
      throw new Error('fixture full')
    }
    const flashes: string[] = []
    const stop = subscribeSessionGridPaneFlash((id) => flashes.push(id))
    const panes = useSessionGrid.getState().panes
    dropOnSessionGrid(
      { paneId: target.paneId, zone: 'center' },
      { payload: { kind: 'content', content: sessionGridContentForSession(row) }, sidebarKeys: [] }
    )
    expect(useSessionGrid.getState().focusedPaneId).toBe(original.paneId)
    expect(useSessionGrid.getState().panes).toBe(panes)
    expect(flashes).toEqual([original.paneId])
    expect(mocks.activate).not.toHaveBeenCalled()
    stop()
  })
  it.each([false, true])(
    'returns only an opened session to the surface (commandCenter=%s)',
    async (commandCenter) => {
      mocks.state.settings.commandCenter = commandCenter
      mocks.activate.mockResolvedValueOnce({ handled: 'opened' })
      resumeSessionInGrid(row)
      await Promise.resolve()
      expect(mocks.state.setActiveView).toHaveBeenCalledWith(commandCenter ? 'attention' : 'grid')
      mocks.state.setActiveView.mockClear()
      mocks.activate.mockResolvedValueOnce({ handled: 'explained' })
      resumeSessionInGrid(row)
      await Promise.resolve()
      expect(mocks.state.setActiveView).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['attention', false, false],
    ['attention', true, true],
    ['grid', false, true],
    ['grid', true, true]
  ])('focuses sessions in %s only on its grid surface (%s)', (view, enabled, expected) => {
    mocks.state.activeView = String(view)
    mocks.state.settings.commandCenter = Boolean(enabled)
    useSessionGrid.getState().load()
    useSessionGrid.getState().addPane(sessionGridContentForSession(row))
    expect(focusSessionInGrid(row)).toBe(expected)
    expect(
      focusSessionInGrid({ ...row, hostId: 'runtime:remote', sessionKey: 'runtime:remote|row' })
    ).toBe(false)
  })
})
