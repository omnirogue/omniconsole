// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { emptySessionSidebarView } from '@/lib/session-sidebar-view'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useAppStore } from '@/store'
import { useSessionSelection } from '@/store/session-selection'
import type { PublicKnownRuntimeEnvironment } from '../../../../../shared/runtime-environments'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { SessionSelectionPicker } from './SessionSelectionPicker'

/**
 * Why this test exists: the picker listed every conversation flat, archived ones included, so
 * a bulk selection scrolled through rows the person had already put away for good.
 */
function session(label: string, sessionKey: string): SidebarSession {
  return {
    rowKey: `row-${sessionKey}`,
    sessionKey,
    worktreeId: 'folder:1',
    hostId: 'local',
    tabId: `tab-${sessionKey}`,
    paneKey: `tab-${sessionKey}:pane`,
    kind: 'terminal',
    label,
    workspaceLabel: 'Website',
    agent: 'claude',
    unavailable: false,
    folderKeyMigration: null
  }
}

const sessions = [session('Alpha', 'a'), session('Beta', 'b'), session('Gamma', 'g')]

beforeEach(() => {
  useSessionSidebarView.setState({
    view: { ...emptySessionSidebarView(), archived: ['b', 'g'] },
    archived: ['b', 'g'],
    loaded: true,
    showHidden: false
  })
  useSessionSelection.getState().set([])
})

afterEach(cleanup)

it('keeps archived rows out of the picker until asked, then shows them on the toggle', async () => {
  const user = userEvent.setup()
  render(<SessionSelectionPicker sessions={sessions} pending={false} />)
  expect(screen.getByText('Alpha')).toBeTruthy()
  expect(screen.queryByText('Beta')).toBeNull()
  expect(screen.queryByText('Gamma')).toBeNull()
  const toggle = screen.getByRole('button', {
    name: '2 archived hidden · Show'
  })
  expect(toggle.getAttribute('aria-pressed')).toBe('false')

  await user.click(toggle)
  expect(screen.getByText('Beta')).toBeTruthy()
  expect(screen.getByText('Gamma')).toBeTruthy()
  expect(screen.getByRole('button', { name: '2 archived shown · Hide' })).toBeTruthy()

  await user.click(screen.getByRole('button', { name: '2 archived shown · Hide' }))
  expect(screen.queryByText('Beta')).toBeNull()
})

it('lets a search reach an archived row by name, like the tree does', async () => {
  const user = userEvent.setup()
  render(<SessionSelectionPicker sessions={sessions} pending={false} />)
  await user.type(screen.getByRole('textbox', { name: 'Find sessions to select' }), 'bet')
  expect(screen.getByText('Beta')).toBeTruthy()
  expect(screen.queryByText('Alpha')).toBeNull()
  expect(screen.queryByRole('button', { name: /archived hidden/ })).toBeNull()
})

// E1/F13 (session parity, Phase 1b): a row a paired owner's ledger created runs there, so a batch
// never picks it here; a live mirror row the ledger joined stays pickable as before.
it('never picks a ledger-only row, saying where it runs, and keeps a joined mirror row pickable', async () => {
  const user = userEvent.setup()
  useAppStore.setState({
    runtimeEnvironments: [{ id: 'env-studio', name: 'Mac Studio' } as PublicKnownRuntimeEnvironment]
  })
  const mirrored = {
    environmentId: 'env-studio',
    conversation: '0123456789abcdef01234567',
    ownerPaneKey: null,
    ownerTabId: null,
    rest: 'asleep' as const,
    listed: true,
    stale: false,
    ownerState: 'ready' as const
  }
  const ledgerKey = JSON.stringify(['runtime:env-studio', 'ledger', 'folder:1', 'c:0123'])
  const ledgerOnly: SidebarSession = {
    ...session('Owner paused', 'l'),
    rowKey: ledgerKey,
    sessionKey: ledgerKey,
    hostId: 'runtime:env-studio',
    tabId: null,
    paneKey: null,
    mirroredConversation: mirrored
  }
  const joined: SidebarSession = {
    ...session('Owner live', 'j'),
    hostId: 'runtime:env-studio',
    mirroredConversation: { ...mirrored, rest: 'live' }
  }
  render(
    <SessionSelectionPicker
      sessions={[session('Alpha', 'a'), ledgerOnly, joined]}
      pending={false}
    />
  )
  const box = (label: string) =>
    screen.getByText(label).closest('label')!.querySelector<HTMLButtonElement>('[role="checkbox"]')!
  expect(box('Owner paused').disabled).toBe(true)
  expect(screen.getByText('Owner paused').closest('label')!.title).toBe('Open it on Mac Studio.')
  expect(box('Owner live').disabled).toBe(false)

  await user.click(screen.getByRole('button', { name: 'Select matching' }))
  expect(useSessionSelection.getState().keys).toEqual(['a', 'j'])
  useAppStore.setState({ runtimeEnvironments: [] })
})

it('selects only what is on screen and follows the tree when it already shows archived rows', async () => {
  const user = userEvent.setup()
  const { rerender } = render(<SessionSelectionPicker sessions={sessions} pending={false} />)
  await user.click(screen.getByRole('button', { name: 'Select matching' }))
  expect(useSessionSelection.getState().keys).toEqual(['a'])

  rerender(<SessionSelectionPicker sessions={sessions} pending={false} showArchived />)
  expect(screen.getByText('Beta')).toBeTruthy()
  expect(screen.queryByRole('button', { name: /archived/ })).toBeNull()
})
