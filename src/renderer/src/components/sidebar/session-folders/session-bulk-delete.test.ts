// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTabCloseOptions } from '@/components/terminal/terminal-tab-close-options'

const WORKTREE = 'local-repo::/tmp/app'
const SHARED_PTY = 'local-repo::/tmp/app@@9369dd50'
const MIRROR = 'web-terminal-7f2cf1c5'

const mocks = vi.hoisted(() => ({
  closeTerminalTab: vi.fn<(tabId: string, options?: TerminalTabCloseOptions) => void>(),
  state: {} as Record<string, unknown>
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/components/terminal/terminal-tab-actions', () => ({
  closeTerminalTab: mocks.closeTerminalTab
}))

import { closeSessionTabForBulk, deleteKeepsPtyIds } from './session-bulk-delete'

const retireDeletedTerminalTab = vi.fn<(tabId: string) => Promise<boolean>>()

/** One daemon session listed by the deleted tab, its paired-host mirror row and, when asked, a second presented tab. */
function stateWithRows(ids: readonly string[]): Record<string, unknown> {
  const tab = (id: string) => ({
    id,
    worktreeId: WORKTREE,
    ptyId: SHARED_PTY,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  })
  const layout = (id: string) => ({
    root: null,
    activeLeafId: null,
    expandedLeafId: null,
    ptyIdsByLeafId: { [`leaf-${id}`]: SHARED_PTY }
  })
  return {
    agentStatusByPaneKey: {},
    repos: [{ id: 'local-repo', path: '/tmp/app', name: 'app', executionHostId: 'local' }],
    worktreesByRepo: { 'local-repo': [{ id: WORKTREE, repoId: 'local-repo', path: '/tmp/app' }] },
    tabsByWorktree: { [WORKTREE]: ids.map(tab) },
    unifiedTabsByWorktree: {},
    ptyIdsByTabId: Object.fromEntries(ids.map((id) => [id, [SHARED_PTY]])),
    terminalLayoutsByTabId: Object.fromEntries(ids.map((id) => [id, layout(id)])),
    lastKnownRelayPtyIdByTabId: {},
    deferredSshSessionIdsByTabId: {},
    pendingReconnectPtyIdByTabId: {}
  }
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  mocks.closeTerminalTab.mockReset()
  mocks.state = stateWithRows(['tab-1'])
  retireDeletedTerminalTab.mockReset()
  retireDeletedTerminalTab.mockResolvedValue(true)
  Object.assign(window, { api: { session: { retireDeletedTerminalTab } } })
})

afterEach(() => {
  vi.restoreAllMocks()
  Object.assign(window, { api: {} })
})

describe('closeSessionTabForBulk', () => {
  it('closes as a delete: history kept, no prompt, and the pane PTY ends', async () => {
    mocks.closeTerminalTab.mockImplementation((_tabId, options) => options?.onClosed?.())

    await expect(closeSessionTabForBulk('tab-1')).resolves.toBe('closed')

    expect(mocks.closeTerminalTab).toHaveBeenCalledTimes(1)
    expect(mocks.closeTerminalTab).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({
        reason: 'user',
        captureRecentlyClosed: true,
        skipRunningProcessConfirm: true,
        deleteSession: true
      })
    )
    expect(mocks.closeTerminalTab.mock.calls[0]![1]).not.toHaveProperty(
      'localPtyTeardownOwnedExternally'
    )
  })

  it('retires the saved row before reporting the close', async () => {
    mocks.closeTerminalTab.mockImplementation((_tabId, options) => options?.onClosed?.())

    await expect(closeSessionTabForBulk('tab-1')).resolves.toBe('closed')
    expect(retireDeletedTerminalTab).toHaveBeenCalledWith('tab-1')
  })

  it('closes the mirror row that listed only what the delete ends, with no second teardown, and retires its saved row too', async () => {
    mocks.state = stateWithRows(['tab-1', MIRROR])
    mocks.closeTerminalTab.mockImplementation((_tabId, options) => options?.onClosed?.())

    await expect(closeSessionTabForBulk('tab-1')).resolves.toBe('closed')

    expect(mocks.closeTerminalTab.mock.calls.map(([tabId]) => tabId)).toEqual(['tab-1', MIRROR])
    expect(mocks.closeTerminalTab).toHaveBeenCalledWith(MIRROR, {
      reason: 'cleanup',
      captureRecentlyClosed: false,
      skipRunningProcessConfirm: true,
      rejectPinned: true,
      localPtyTeardownOwnedExternally: true
    })
    expect(retireDeletedTerminalTab.mock.calls.map(([tabId]) => tabId)).toEqual(['tab-1', MIRROR])
  })

  it('leaves the mirror row alone when a live, non-mirror tab still shows the PTY', async () => {
    mocks.state = stateWithRows(['tab-1', MIRROR, 'second-presented-tab'])
    mocks.closeTerminalTab.mockImplementation((_tabId, options) => options?.onClosed?.())

    await expect(closeSessionTabForBulk('tab-1')).resolves.toBe('closed')

    expect(mocks.closeTerminalTab).toHaveBeenCalledTimes(1)
    expect(retireDeletedTerminalTab.mock.calls.map(([tabId]) => tabId)).toEqual(['tab-1'])
    expect(deleteKeepsPtyIds('tab-1')).toEqual([SHARED_PTY])
  })

  it('removes the row only, ending no terminal, when the row could not be verified', async () => {
    mocks.state = stateWithRows(['tab-1', MIRROR])
    mocks.closeTerminalTab.mockImplementation((_tabId, options) => options?.onClosed?.())

    await expect(closeSessionTabForBulk('tab-1', { endProcess: false })).resolves.toBe('closed')

    expect(mocks.closeTerminalTab).toHaveBeenCalledTimes(1)
    expect(mocks.closeTerminalTab).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({ reason: 'user', localPtyTeardownOwnedExternally: true })
    )
    expect(mocks.closeTerminalTab.mock.calls[0]![1]).not.toHaveProperty('deleteSession')
    expect(retireDeletedTerminalTab.mock.calls.map(([tabId]) => tabId)).toEqual(['tab-1'])
  })

  it('does not retire anything when the close is declined', async () => {
    mocks.closeTerminalTab.mockImplementation((_tabId, options) => options?.onCancel?.())

    await expect(closeSessionTabForBulk('tab-1')).resolves.toBe('declined')
    expect(retireDeletedTerminalTab).not.toHaveBeenCalled()
  })

  it('still reports closed when the retirement call rejects', async () => {
    retireDeletedTerminalTab.mockRejectedValue(new Error('ipc down'))
    mocks.closeTerminalTab.mockImplementation((_tabId, options) => options?.onClosed?.())

    await expect(closeSessionTabForBulk('tab-1')).resolves.toBe('closed')
    expect(console.warn).toHaveBeenCalled()
  })

  it('still reports closed on an older preload without the method', async () => {
    Object.assign(window, { api: { session: {} } })
    mocks.closeTerminalTab.mockImplementation((_tabId, options) => options?.onClosed?.())

    await expect(closeSessionTabForBulk('tab-1')).resolves.toBe('closed')
  })
})
