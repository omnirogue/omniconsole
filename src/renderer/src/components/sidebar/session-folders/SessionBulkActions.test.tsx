// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWaitLater } from '@/store/wait-later-store'
import { emptyWaitLater } from '@/lib/wait-later'
import { SessionBulkActions } from './SessionBulkActions'
import { useSessionSelection } from '@/store/session-selection'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { useSessionFolders } from '@/store/session-folders'
import { emptySessionSidebarView } from '@/lib/session-sidebar-view'
import { pauseSidebarSession } from '@/lib/conversation-fleet-pause'

const mocks = vi.hoisted(() => ({
  keys: ['a', 'b'],
  runs: [] as { rowKey: string; sessionKey: string | null; title: string }[]
}))
vi.mock('@/store/conversation-fleet-store', () => ({
  useConversationFleetRuns: () => mocks.runs
}))
vi.mock('./use-sidebar-sessions', () => ({
  useSidebarSessions: () =>
    mocks.keys.map((key) => ({
      rowKey: key,
      sessionKey: key,
      label: `Session ${key}`,
      agent: 'codex',
      workspaceLabel: 'Project',
      kind: 'terminal',
      unavailable: false,
      // A row a paired owner's ledger created (session parity, step 6) is keyed `[…, 'ledger', …]`.
      ...(key.includes('"ledger"')
        ? {
            hostId: 'runtime:env-studio',
            mirroredConversation: {
              environmentId: 'env-studio',
              conversation: '0123456789abcdef01234567',
              ownerPaneKey: null,
              ownerTabId: null,
              rest: 'asleep',
              listed: true,
              stale: false,
              ownerState: 'ready'
            }
          }
        : {})
    }))
}))
vi.mock('@/lib/conversation-fleet-pause', () => ({ pauseSidebarSession: vi.fn() }))

beforeEach(() => {
  mocks.keys = ['a', 'b']
  mocks.runs = []
  useWaitLater.setState({ loaded: true, view: emptyWaitLater(), waiting: new Set() })
  useSessionSelection.getState().set([])
  useSessionSidebarView.setState({ loaded: true, view: emptySessionSidebarView(), archived: [] })
  useSessionFolders.setState({
    loaded: true,
    metadata: { version: 1, folders: [], membership: {} },
    error: null
  })
  vi.mocked(pauseSidebarSession).mockReset()
})
afterEach(cleanup)

async function selectAll() {
  const user = userEvent.setup()
  render(<SessionBulkActions />)
  await user.click(screen.getByRole('button', { name: 'Select matching' }))
  return user
}

describe('session bulk actions', () => {
  it('hides and archives a receipt from another computer by its key, and says Pause cannot reach it', async () => {
    const user = userEvent.setup()
    mocks.runs = [{ rowKey: 'remote-row', sessionKey: 'remote-session', title: 'Remote work' }]
    useSessionSelection.getState().set(['a', 'remote-session'])
    render(<SessionBulkActions />)
    expect(screen.getByText('2 sessions selected')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Hide' }))
    expect(useSessionSidebarView.getState().view.hidden).toEqual([
      'conversation:a',
      'conversation:remote-session'
    ])
    await user.click(screen.getByRole('button', { name: 'Archive' }))
    expect(useSessionSidebarView.getState().view.archived).toEqual(['a', 'remote-session'])
    vi.mocked(pauseSidebarSession).mockResolvedValue({ state: 'paused', message: 'Paused.' })
    await user.click(screen.getByRole('button', { name: 'Pause' }))
    expect(await screen.findByText('Pause: 1 succeeded · 0 skipped · 1 not confirmed')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Pause results' }))
    expect(
      within(screen.getByRole('region', { name: 'Pause results' })).getByText(
        'Remote work: Source conversation closed'
      )
    ).toBeTruthy()
    expect(pauseSidebarSession).toHaveBeenCalledTimes(1)
  })

  // E1/F13 (session parity, Phase 1b): a row a paired owner's ledger created runs there, so no
  // bulk action changes it here, even when its key is in the selection.
  it('leaves a ledger-only row out of the count, Hide and Archive', async () => {
    const user = userEvent.setup()
    const ledgerKey = JSON.stringify(['runtime:env-studio', 'ledger', 'repo:/w', 'c:0123'])
    mocks.keys = ['a', ledgerKey]
    useSessionSelection.getState().set(['a', ledgerKey])
    render(<SessionBulkActions />)
    expect(screen.getByText('1 sessions selected')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Hide' }))
    expect(useSessionSidebarView.getState().view.hidden).toEqual(['conversation:a'])
    await user.click(screen.getByRole('button', { name: 'Archive' }))
    expect(useSessionSidebarView.getState().view.archived).toEqual(['a'])
  })

  it('selects multiple sessions and hides, shows, archives and restores them', async () => {
    const user = await selectAll()
    expect(useSessionSelection.getState().keys).toEqual(['a', 'b'])
    await user.click(screen.getByRole('button', { name: 'Hide' }))
    expect(useSessionSidebarView.getState().view.hidden).toEqual([
      'conversation:a',
      'conversation:b'
    ])
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    await user.click(screen.getByRole('button', { name: 'Show' }))
    await user.keyboard('{Escape}')
    expect(useSessionSidebarView.getState().view.hidden).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Archive' }))
    expect(useSessionSidebarView.getState().view.archived).toEqual(['a', 'b'])
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    await user.click(screen.getByRole('button', { name: 'Unarchive' }))
    expect(useSessionSidebarView.getState().view.archived).toEqual([])
  })

  it('keeps Hide and Pause without manual Snooze or Wait, including overflow', async () => {
    const user = await selectAll()
    expect(screen.queryByRole('button', { name: /snooze|^wait$/i })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    expect(screen.queryByRole('button', { name: /snooze|^wait$/i })).toBeNull()
    expect(useWaitLater.getState().view.until).toEqual({})
    expect(pauseSidebarSession).not.toHaveBeenCalled()
  })

  it('keeps a large pause result bounded, distinguishes idle skips and dismisses without replay', async () => {
    mocks.keys = Array.from({ length: 104 }, (_, index) => String(index))
    vi.mocked(pauseSidebarSession)
      .mockResolvedValueOnce({ state: 'paused', message: 'Paused' })
      .mockResolvedValueOnce({ state: 'unverifiable', message: 'Reconnect to host' })
      .mockResolvedValue({ state: 'already-idle', message: 'Already idle' })
    const user = await selectAll()
    await user.click(screen.getByRole('button', { name: 'Pause' }))
    expect(
      await screen.findByText('Pause: 1 succeeded · 102 skipped · 1 not confirmed')
    ).toBeTruthy()
    expect(screen.queryByText('Session 0: Paused')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Pause results' }))
    const details = screen.getByRole('region', { name: 'Pause results' })
    expect(within(details).getByText('Session 0: Paused')).toBeTruthy()
    expect(within(details).getByText('Session 1: Reconnect to host')).toBeTruthy()
    expect(details.querySelectorAll('p')).toHaveLength(104)
    expect(details.classList.contains('overflow-y-auto')).toBe(true)
    expect(details.classList.contains('max-h-60')).toBe(true)
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'Dismiss results' }))
    expect(screen.queryByRole('button', { name: 'Pause results' })).toBeNull()
    expect(useSessionSelection.getState().keys).toHaveLength(104)
    await user.click(screen.getByRole('button', { name: 'Unselect all' }))
    await user.click(screen.getByRole('button', { name: 'Select matching' }))
    expect(screen.queryByRole('button', { name: 'Dismiss results' })).toBeNull()
    expect(pauseSidebarSession).toHaveBeenCalledTimes(104)
  })
})

it('exposes actions and Unselect all without opening the selected count', async () => {
  useSessionSelection.getState().set(['a', 'b'])
  const user = userEvent.setup()
  render(<SessionBulkActions compact />)
  expect(screen.getByRole('toolbar', { name: 'Session bulk actions' })).toBeTruthy()
  for (const name of ['Hide', 'Pause', 'Archive']) {
    expect(screen.getByRole('button', { name })).toBeTruthy()
  }
  expect(screen.queryByRole('textbox', { name: 'Find sessions to select' })).toBeNull()
  await user.click(screen.getByRole('button', { name: 'More actions' }))
  expect(screen.getByRole('button', { name: 'Show' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Unarchive' })).toBeTruthy()
  expect(screen.getByRole('combobox', { name: 'Move to folder' })).toBeTruthy()
  await user.keyboard('{Escape}')
  await user.click(screen.getByRole('button', { name: 'Unselect all' }))
  expect(useSessionSelection.getState().keys).toEqual([])
  expect(screen.getByRole('button', { name: 'Hide' }).hasAttribute('disabled')).toBe(true)
})

it('keeps the full picker and initial selection for the next-step entry point', () => {
  render(<SessionBulkActions initialKey="a" />)
  expect(useSessionSelection.getState().keys).toEqual(['a'])
  expect(screen.getByRole('textbox', { name: 'Find sessions to select' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Select matching' })).toBeTruthy()
})
