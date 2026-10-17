// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SidebarSession } from '@/lib/sidebar-sessions'
const mocks = vi.hoisted(() => ({ enabled: true, pane: vi.fn() }))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ settings: { commandCenter: mocks.enabled } })
}))
vi.mock('../command-center/SessionPaneBody', () => ({
  SessionPaneBody: (props: unknown) => {
    mocks.pane(props)
    return <div>Shared session pane</div>
  }
}))
vi.mock('@/components/browser-pane/BrowserPane', () => ({ default: () => null }))
vi.mock('@/components/browser-pane/host-guest/browser-page-viewport', () => ({
  claimBrowserOverlaySlotViewport: vi.fn()
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
import { SessionGridSessionBody } from './SessionGridPaneBodies'
const session: SidebarSession = {
  rowKey: 'row',
  sessionKey: 'session',
  worktreeId: 'folder',
  hostId: 'local',
  tabId: 'terminal',
  paneKey: null,
  kind: 'terminal',
  agent: 'claude',
  label: 'Claude',
  workspaceLabel: 'folder',
  unavailable: false,
  folderKeyMigration: null
}
const actions = { onTarget: vi.fn(), onOpen: vi.fn(), onResume: vi.fn(), onRemove: vi.fn() }
beforeEach(() => {
  mocks.enabled = true
  vi.clearAllMocks()
})
afterEach(cleanup)
describe('grid session pane routing', () => {
  it.each(['terminal', 'structured'] as const)(
    'uses the shared session pane for %s sessions when enabled',
    (kind) => {
      const row = { ...session, kind }
      render(<SessionGridSessionBody session={row} {...actions} />)
      expect(screen.getByText('Shared session pane')).toBeTruthy()
      expect(mocks.pane).toHaveBeenCalledWith({ session: row, onOpen: actions.onOpen })
      expect(actions.onTarget).not.toHaveBeenCalled()
      expect(actions.onResume).not.toHaveBeenCalled()
    }
  )
  it('preserves the existing structured-session explanation with the setting off', () => {
    mocks.enabled = false
    render(<SessionGridSessionBody session={{ ...session, kind: 'structured' }} {...actions} />)
    expect(screen.getByText('Chat conversations show in their own workspace.')).toBeTruthy()
    expect(mocks.pane).not.toHaveBeenCalled()
  })
  it('preserves legacy terminal borrowing with the setting off', () => {
    mocks.enabled = false
    render(<SessionGridSessionBody session={session} {...actions} />)
    expect(screen.getByText('Connecting terminal…')).toBeTruthy()
    expect(actions.onTarget).toHaveBeenCalledWith(expect.any(HTMLElement))
    expect(mocks.pane).not.toHaveBeenCalled()
  })
  it('keeps the missing-session card without resuming anything', () => {
    render(<SessionGridSessionBody session={null} {...actions} />)
    expect(screen.getByText('This conversation is no longer in the sidebar.')).toBeTruthy()
    expect(mocks.pane).not.toHaveBeenCalled()
    expect(actions.onResume).not.toHaveBeenCalled()
  })
})
