// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NEXT_STEPS_RPC } from '../../../../shared/next-step-suggestions-rpc'
import { NextStepsStartPill } from './NextStepsStartPill'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  owned: true,
  turnKey: null as string | null,
  unknown: false
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/components/sidebar/session-folders/use-sidebar-sessions', () => ({
  useSidebarSessions: () => [
    { kind: 'terminal', paneKey: 'tab-1:leaf-1', tabId: 'tab-1', label: 'New session' }
  ]
}))
vi.mock('@/lib/conversation-source-for-session', () => ({
  conversationSourceForSession: () => (mocks.owned ? SOURCE : null)
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      agentStatusByPaneKey: {
        'tab-1:leaf-1': {
          state: 'done',
          sessionBoundary: true,
          prompt: '',
          stateHistory: [],
          agentType: 'claude'
        }
      }
    })
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

const SOURCE = { worktreeId: 'wt', paneKey: 'tab-1:leaf-1', kind: 'pty' as const }

beforeEach(() => {
  mocks.owned = true
  mocks.turnKey = null
  mocks.unknown = false
  mocks.rpc.mockImplementation((_target: unknown, method: string) =>
    method === NEXT_STEPS_RPC.current
      ? Promise.resolve({
          turnKey: mocks.turnKey,
          turnObserved: mocks.unknown ? null : mocks.turnKey !== null,
          // Empty values for the sets: freshness is `turnObserved` alone.
          ai: null,
          parsed: null,
          answered: false,
          revision: 1
        })
      : Promise.reject(new Error(`unexpected ${method}`))
  )
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const renderPill = () =>
  render(<NextStepsStartPill worktreeId="wt" tabId="tab-1" paneKey="tab-1:leaf-1" />)

it('shows on a fresh agent once the host confirms it has seen no turn', async () => {
  renderPill()
  expect(await screen.findByRole('button', { name: '✦ Suggested starts' })).toBeTruthy()
  expect(mocks.rpc.mock.calls[0]![2]).toEqual({ conversation: SOURCE })
})

it('stays hidden when the host has seen a turn, or there is no real conversation yet', async () => {
  mocks.turnKey = 'tab-1:leaf-1@5'
  const first = renderPill()
  await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1))
  expect(screen.queryByRole('button', { name: '✦ Suggested starts' })).toBeNull()
  first.unmount()
  mocks.owned = false
  mocks.turnKey = null
  renderPill()
  expect(screen.queryByRole('button', { name: '✦ Suggested starts' })).toBeNull()
  expect(mocks.rpc).toHaveBeenCalledTimes(1)
})

it('stays hidden while the host cannot say whether a turn was observed', async () => {
  mocks.unknown = true
  renderPill()
  await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1))
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(screen.queryByRole('button', { name: '✦ Suggested starts' })).toBeNull()
})
