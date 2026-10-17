// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmationDialogContext } from '@/components/confirmation-dialog-context'
import { HOME_SESSION_HOST_FILTER } from '@/lib/session-host-scope'
import type { BackgroundRuntimeTerminal } from '../../../../../shared/background-runtime-terminal'
import {
  BACKGROUND_TERMINALS_EXPANDED_STORAGE_KEY,
  BackgroundTerminalsGroup
} from './BackgroundTerminalsGroup'
import {
  backgroundTerminalsOutsideSidebar,
  refreshBackgroundRuntimeTerminals,
  useBackgroundRuntimeTerminals,
  withBackgroundTerminalCounts
} from './background-runtime-terminals'

// Why (C3 step 5): a process an earlier remote click started must be visible where it runs, with
// Open (adopt) and End (confirmed), and counted under its own computer — never ended by itself.

const mocks = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  call: vi.fn(),
  list: vi.fn(),
  end: vi.fn()
}))
vi.mock('sonner', () => ({ toast: mocks.toast }))

const orphan: BackgroundRuntimeTerminal = {
  ptyId: 'repo::/work/ads@@orphan',
  worktreeId: 'repo::/work/ads',
  tabId: 'tab-orphan',
  paneKey: 'tab-orphan:leaf-9',
  handle: 'term_orphan',
  title: 'claude conversation',
  launchAgent: 'claude',
  hostId: 'local'
}
const onSsh: BackgroundRuntimeTerminal = {
  ...orphan,
  ptyId: 'ssh-pty',
  paneKey: 'tab-ssh:leaf-1',
  handle: 'term_ssh',
  title: 'build box',
  hostId: 'ssh:box'
}

function renderGroup(confirm: ((options: unknown) => Promise<boolean>) | null) {
  return render(
    <ConfirmationDialogContext.Provider value={confirm}>
      <BackgroundTerminalsGroup />
    </ConfirmationDialogContext.Provider>
  )
}

beforeEach(() => {
  window.localStorage.setItem(BACKGROUND_TERMINALS_EXPANDED_STORAGE_KEY, 'true')
  mocks.call.mockReset().mockResolvedValue({ ok: true, result: {} })
  mocks.list.mockReset().mockResolvedValue([orphan, onSsh])
  mocks.end.mockReset().mockResolvedValue({ ended: true, ptyKilled: true })
  vi.stubGlobal(
    'window',
    Object.assign(window, {
      api: {
        runtime: {
          call: mocks.call,
          listBackgroundTerminals: mocks.list,
          endBackgroundTerminal: mocks.end
        }
      }
    })
  )
  useBackgroundRuntimeTerminals.setState({
    terminals: [],
    hostFilter: HOME_SESSION_HOST_FILTER,
    sidebarPaneKeys: new Set()
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Running in the background (Conversations sidebar)', () => {
  it('lists this computer’s background processes under the host filter, with their caption', async () => {
    renderGroup(async () => true)

    expect(await screen.findByText('claude conversation')).toBeTruthy()
    expect(screen.getByText('Running in the background · 1')).toBeTruthy()
    expect(screen.getByText('Running in the background, not in a window · ads')).toBeTruthy()
    // Why: Home shows this computer only, so the SSH host's process waits for its own filter.
    expect(screen.queryByText('build box')).toBeNull()
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('starts collapsed to its heading and remembers when it is opened', async () => {
    window.localStorage.removeItem(BACKGROUND_TERMINALS_EXPANDED_STORAGE_KEY)
    const user = userEvent.setup()
    renderGroup(async () => true)

    const heading = await screen.findByRole('button', { name: /Running in the background · 1/ })
    expect(heading.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('claude conversation')).toBeNull()

    await user.click(heading)
    expect(screen.getByText('claude conversation')).toBeTruthy()
    expect(window.localStorage.getItem(BACKGROUND_TERMINALS_EXPANDED_STORAGE_KEY)).toBe('true')
  })

  it('opens one visibly through the same adopt path as omni session show', async () => {
    const user = userEvent.setup()
    renderGroup(async () => true)

    await user.click(await screen.findByRole('button', { name: 'Open claude conversation' }))

    expect(mocks.call).toHaveBeenCalledWith({
      method: 'terminal.focus',
      params: { terminal: 'term_orphan', navigation: 'host' }
    })
  })

  it('ends one only after a fresh read and the destructive confirmation, re-checked by main', async () => {
    const user = userEvent.setup()
    const confirm = vi.fn(async () => false)
    renderGroup(confirm)

    await user.click(await screen.findByRole('button', { name: 'End claude conversation' }))
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ confirmVariant: 'destructive', confirmLabel: 'End process' })
    )
    expect(mocks.end).not.toHaveBeenCalled()

    const listsBefore = mocks.list.mock.calls.length
    confirm.mockResolvedValueOnce(true)
    await user.click(screen.getByRole('button', { name: 'End claude conversation' }))
    await waitFor(() => expect(mocks.end).toHaveBeenCalledWith({ ptyId: orphan.ptyId }))
    // Why: the list was read again right before the person was asked.
    expect(mocks.list.mock.calls.length).toBeGreaterThan(listsBefore)
    expect(mocks.toast.success).toHaveBeenCalledWith('Ended claude conversation')
    expect(mocks.call).not.toHaveBeenCalled()
  })

  it('does not ask about one that a fresh read shows already gone', async () => {
    const user = userEvent.setup()
    const confirm = vi.fn(async () => true)
    renderGroup(confirm)
    const end = await screen.findByRole('button', { name: 'End claude conversation' })
    mocks.list.mockResolvedValue([onSsh])

    await user.click(end)

    expect(confirm).not.toHaveBeenCalled()
    expect(mocks.end).not.toHaveBeenCalled()
    expect(mocks.toast.info).toHaveBeenCalledWith(
      'claude conversation is no longer running in the background.'
    )
  })

  it('does not list a pane the sidebar already shows as a row', async () => {
    useBackgroundRuntimeTerminals.setState({ sidebarPaneKeys: new Set([orphan.paneKey!]) })
    renderGroup(async () => true)

    await act(refreshBackgroundRuntimeTerminals)

    expect(screen.queryByText('claude conversation')).toBeNull()
  })

  it('never ends one when no confirmation can be asked', async () => {
    const user = userEvent.setup()
    renderGroup(null)

    await user.click(await screen.findByRole('button', { name: 'End claude conversation' }))

    expect(mocks.end).not.toHaveBeenCalled()
  })

  it('keeps the last list when the host cannot tell yet', async () => {
    await act(refreshBackgroundRuntimeTerminals)
    mocks.list.mockResolvedValue(null)
    await act(refreshBackgroundRuntimeTerminals)

    expect(useBackgroundRuntimeTerminals.getState().terminals).toEqual([orphan, onSsh])
  })
})

describe('host counts', () => {
  it('leaves out panes the sidebar already lists before counting', () => {
    expect(
      backgroundTerminalsOutsideSidebar([orphan, onSsh], new Set([orphan.paneKey!])).map(
        (terminal) => terminal.ptyId
      )
    ).toEqual([onSsh.ptyId])
  })

  it('counts each background process under its own host, adding to the sidebar rows', () => {
    const counts = withBackgroundTerminalCounts(
      new Map([
        ['local', 3],
        ['runtime:studio', 2]
      ]),
      [orphan, onSsh]
    )

    expect(Object.fromEntries(counts)).toEqual({ local: 4, 'runtime:studio': 2, 'ssh:box': 1 })
  })
})
