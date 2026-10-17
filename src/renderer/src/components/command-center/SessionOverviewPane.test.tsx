// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionGrid } from '@/store/session-grid'
import {
  getSessionSidebarDrag,
  clearSessionSidebarDrag,
  SESSION_ROW_DRAG_TYPE
} from '@/lib/session-sidebar-drag'
import type { SidebarSession } from '@/lib/sidebar-sessions'
const mocks = vi.hoisted(() => ({ enabled: true, add: vi.fn() }))
vi.mock('@/store', () => ({
  useAppStore: (select: (value: unknown) => unknown) =>
    select({ settings: { commandCenter: mocks.enabled }, agentStatusEpoch: 1 })
}))
vi.mock('../attention/use-agent-pane-snapshot', () => ({
  useAgentPaneSnapshot: () => ({ cardsByPaneKey: new Map() })
}))
vi.mock('@/store/wait-later-store', () => ({
  useFinishedMarks: () => new Map(),
  useWaitingKeys: () => new Set(),
  useWaitingUntil: () => ({})
}))
vi.mock('../session-activity/use-session-activity', () => ({
  useSessionActivity: () => ({ line: 'Reviewing files', state: { at: 1 } })
}))
vi.mock('@/lib/execution-host-display-label', () => ({
  selectExecutionHostDisplayLabel: () => 'Paired Mac'
}))
vi.mock('@/lib/session-grid-actions', () => ({ addContentsToSessionGrid: mocks.add }))
vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: () => null
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
import SessionOverviewPane from './SessionOverviewPane'
const session: SidebarSession = {
  rowKey: 'row',
  sessionKey: 'host-qualified-session',
  hostId: 'runtime:peer',
  worktreeId: 'wt',
  tabId: 'tab',
  paneKey: 'pane',
  kind: 'terminal',
  agent: 'codex',
  label: 'Review changes',
  workspaceLabel: 'Workspace',
  unavailable: false,
  folderKeyMigration: null
}
beforeEach(() => {
  mocks.enabled = true
  mocks.add.mockReset()
  useSessionGrid.setState(
    {
      ...useSessionGrid.getInitialState(),
      loaded: true,
      panes: {
        overview: { id: 'overview', kind: 'view', viewId: 'overview' },
        other: { id: 'other', kind: 'view', viewId: 'terminal' }
      },
      layout: {
        orientation: 'columns',
        tracks: [['overview'], ['other']],
        trackSizes: [0.5, 0.5],
        paneSizes: [[1], [1]]
      },
      focusedPaneId: 'overview',
      recentPaneIds: ['overview', 'other']
    },
    true
  )
})
afterEach(() => {
  cleanup()
  clearSessionSidebarDrag()
  useSessionGrid.getState().cancelPendingWrites()
})
describe('session overview pane', () => {
  it('shows session activity and host, and defaults row clicks to a new pane', () => {
    render(<SessionOverviewPane paneId="overview" sessions={[session]} />)
    expect(screen.getByText(/Reviewing files.*Paired Mac/)).toBeTruthy()
    expect(screen.getByText('Done today')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(mocks.add).toHaveBeenCalledWith(
      [
        expect.objectContaining({ sessionKey: session.sessionKey, executionHostId: session.hostId })
      ],
      { paneId: 'overview', zone: 'right' }
    )
  })
  it('lets a row replace the last focused pane while preserving the overview', () => {
    render(<SessionOverviewPane paneId="overview" sessions={[session]} />)
    fireEvent.change(screen.getByLabelText('Session placement'), { target: { value: 'focused' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(
      Object.values(useSessionGrid.getState().panes).some(
        (pane) => pane.kind === 'session' && pane.sessionKey === session.sessionKey
      )
    ).toBe(true)
    expect(useSessionGrid.getState().panes.overview?.kind).toBe('view')
    expect(mocks.add).not.toHaveBeenCalled()
  })
  it('drags the same bare sessionKey as the sidebar', () => {
    render(<SessionOverviewPane paneId="overview" sessions={[session]} />)
    const values = new Map<string, string>()
    fireEvent.dragStart(screen.getByText('Review changes').closest('li')!, {
      dataTransfer: {
        setData: (key: string, value: string) => {
          values.set(key, value)
        }
      }
    })
    expect(values.get(SESSION_ROW_DRAG_TYPE)).toBe(session.sessionKey)
    expect(getSessionSidebarDrag()).toMatchObject({ sessionKey: session.sessionKey })
  })
  it('does not subscribe to the overview or place sessions with the flag off', () => {
    mocks.enabled = false
    expect(
      render(<SessionOverviewPane paneId="overview" sessions={[session]} />).container.innerHTML
    ).toBe('')
    expect(mocks.add).not.toHaveBeenCalled()
  })
})
