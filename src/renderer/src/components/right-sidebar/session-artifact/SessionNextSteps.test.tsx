// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NextStepSuggestionSet } from '../../../../../shared/next-step-suggestions'
import { NEXT_STEPS_RPC } from '../../../../../shared/next-step-suggestions-rpc'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { usePendingNextSteps } from '@/components/next-steps/next-steps-pending-store'
import { SessionNextSteps } from './SessionNextSteps'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), sets: [] as unknown[] }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.rpc,
  RuntimeRpcCallError: class extends Error {
    code = 'error'
  }
}))
// The waits section reads the chain registry, which this suite does not load.
vi.mock('./SessionWaits', () => ({ SessionWaits: () => null }))
vi.mock('@/components/sidebar/session-folders/use-sidebar-sessions', () => ({
  useSidebarSessions: () => []
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({ agentStatusByPaneKey: {} })
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    fallback.replace(/{{(\w+)}}/g, (_match, name: string) => String(options?.[name] ?? ''))
}))

const conversation = { worktreeId: 'wt', paneKey: 'tab-1:leaf-1', kind: 'pty' as const }
const menu: NextStepSuggestionSet = {
  id: 'parsed-1',
  conversation,
  worktreeId: 'wt',
  turnKey: 'tab-1:leaf-1@5',
  origin: 'parsed',
  createdAt: 10,
  status: 'pending',
  suggestions: ['Write the onboarding email', 'Draft the pricing page'].map((title, index) => ({
    id: `s${index + 1}`,
    title,
    prompt: `Please go ahead with this option you offered: ${title}`,
    risk: 'safe' as const,
    kind: 'continue' as const,
    offered: true as const,
    optionGroup: 'menu-1',
    ...(index === 1 ? { preselected: true as const } : {})
  }))
}
const session = {
  kind: 'terminal',
  worktreeId: 'wt',
  paneKey: 'tab-1:leaf-1',
  tabId: 'tab-1',
  label: 'Launch work'
} as unknown as SidebarSession

beforeEach(() => {
  usePendingNextSteps.setState({
    counts: new Map(),
    keepGoing: new Map(),
    keepGoingStopsSeen: new Map(),
    keepGoingRevision: null,
    sets: undefined,
    revision: null,
    unknown: false
  })
  mocks.sets = [menu]
  mocks.rpc.mockImplementation((_target: unknown, method: string) => {
    const set = mocks.sets[0] as NextStepSuggestionSet | undefined
    if (method === NEXT_STEPS_RPC.list) {
      return Promise.resolve({ sets: mocks.sets, skips: [], revision: 2, keepGoing: [] })
    }
    if (method === NEXT_STEPS_RPC.current) {
      return Promise.resolve(
        set
          ? { turnKey: set.turnKey, parsed: set, answered: false, turnObserved: true, revision: 2 }
          : { turnKey: null, answered: false, turnObserved: true, revision: 1 }
      )
    }
    if (method === NEXT_STEPS_RPC.keepGoing) {
      return Promise.resolve({
        state: { conversation, enabled: false, maxRounds: 3, roundsUsed: 0, startedAt: 1 }
      })
    }
    if (method === NEXT_STEPS_RPC.decide) {
      return Promise.resolve({ set: { ...set, status: 'accepted' }, queued: ['s2'], notQueued: [] })
    }
    return Promise.reject(new Error(`unexpected ${method}`))
  })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('shows the conversation’s menu in the side panel, ticked and built with one click', async () => {
  render(<SessionNextSteps session={session} visible />)
  expect(screen.getByText('Launch work')).toBeTruthy()
  fireEvent.click(await screen.findByRole('button', { name: 'Build selected (1)' }))
  await waitFor(() =>
    expect(
      mocks.rpc.mock.calls.filter(([, method]) => method === NEXT_STEPS_RPC.decide).map((c) => c[2])
    ).toEqual([{ setId: 'parsed-1', decision: { action: 'run', suggestionIds: ['s2'] } }])
  )
})

it('says quietly when the conversation has no suggestions', async () => {
  mocks.sets = []
  render(<SessionNextSteps session={session} visible />)
  expect(await screen.findByText('No suggestions for this turn.')).toBeTruthy()
  expect(screen.queryByRole('checkbox')).toBeNull()
})
