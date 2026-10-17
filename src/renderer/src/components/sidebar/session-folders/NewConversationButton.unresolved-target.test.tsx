/** @vitest-environment happy-dom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NewConversationButton } from './NewConversationButton'

// Why (measured live on c39b7cf81): a restored active worktree whose host had not resolved
// left the launcher on "Checking available agents…" forever. The launcher must list this
// machine's agents instead and never launch into the unresolved worktree.

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  capabilityWorktrees: [] as (string | null)[]
}))

vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: mocks.launch }))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorkspace: vi.fn() }))
vi.mock('@/lib/activate-tab-and-focus-pane', () => ({ activateTabAndFocusPane: vi.fn() }))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (
      selector: (state: { activeWorktreeId: string; settings: Record<string, unknown> }) => unknown
    ) => selector({ activeWorktreeId: 'restored-worktree', settings: {} }),
    {
      getState: () => ({
        activeWorktreeId: 'restored-worktree',
        settings: { defaultTuiAgent: 'claude' },
        rateLimits: {},
        activeGroupIdByWorktree: {},
        groupsByWorktree: {}
      })
    }
  )
}))
vi.mock('@/hooks/useWorkAgentCapabilities', () => ({
  useWorkAgentCapabilities: (worktreeId: string | null) => {
    mocks.capabilityWorktrees.push(worktreeId)
    const claude = { id: 'claude', label: 'Claude', status: 'usable', models: [] }
    return {
      loading: false,
      capabilities: [claude],
      usable: [claude],
      rates: {},
      refresh: vi.fn().mockResolvedValue([]),
      readCurrent: () => [claude]
    }
  }
}))
vi.mock('@/hooks/useAccountCapacityRows', () => ({ useAccountCapacityRows: () => [] }))
vi.mock('@/hooks/useAgentDetectionTarget', () => ({
  // The restored worktree's host has not resolved; no worktree means this machine.
  useAgentDetectionTargetForWorktree: (worktreeId: string | null) =>
    worktreeId === null ? { kind: 'local' } : undefined
}))
vi.mock('@/runtime/web-runtime-session', () => ({ isWebRuntimeSessionActive: () => false }))
vi.mock('@/components/handoffs/handoff-scope', () => ({ useHandoffScope: () => 'scope' }))
vi.mock('@/components/companies/companies-client', () => ({
  companiesApi: vi.fn(),
  useCompaniesRead: () => ({ data: undefined, loading: false, error: null })
}))
vi.mock('./new-conversation/launcher-target', () => ({
  useLauncherTargets: () => undefined,
  rememberLauncherCompany: vi.fn(),
  openLauncherAccounts: vi.fn()
}))

beforeEach(() => {
  mocks.launch.mockReset().mockReturnValue({ tabId: 'new-tab' })
  mocks.capabilityWorktrees.length = 0
})
afterEach(() => {
  cleanup()
})

it('lists this machine’s agents while the active worktree has no resolved host', () => {
  render(<NewConversationButton />)
  expect(mocks.capabilityWorktrees.length).toBeGreaterThan(0)
  expect(mocks.capabilityWorktrees.every((worktreeId) => worktreeId === null)).toBe(true)
})

it('never launches into the unresolved worktree', async () => {
  render(<NewConversationButton />)
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }))
    await Promise.resolve()
  })
  expect(mocks.launch).not.toHaveBeenCalledWith(
    expect.objectContaining({ worktreeId: 'restored-worktree' })
  )
})
