// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  NextStepSuggestion,
  NextStepSuggestionSet
} from '../../../../shared/next-step-suggestions'
import { NEXT_STEPS_RPC } from '../../../../shared/next-step-suggestions-rpc'
import { NextStepsStartTray } from './NextStepsStartTray'
import { isFreshAgentStatus, nextStepsStartView } from './next-steps-start-model'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  set: null as unknown,
  links: {} as Record<string, { taskId: string }>,
  owned: true,
  turnObserved: false as boolean | null
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('./next-steps-save-for-later', () => ({ saveNextStepsForLater: vi.fn() }))
vi.mock('@/components/sidebar/session-folders/use-sidebar-sessions', () => ({
  useSidebarSessions: () => [
    { kind: 'terminal', paneKey: 'tab-1:leaf-1', tabId: 'tab-1', label: 'New session' }
  ]
}))
vi.mock('@/lib/conversation-source-for-session', () => ({
  conversationSourceForSession: () => (mocks.owned ? SOURCE : null)
}))
vi.mock('@/lib/session-task-sidebar-groups', () => ({
  sessionTaskRef: () => mocks.links.card ?? null
}))
vi.mock('@/store/session-task-store', () => {
  const state = { links: {}, loaded: true, load: () => undefined }
  const useSessionTasks = (selector: (value: typeof state) => unknown) => selector(state)
  useSessionTasks.getState = () => state
  return { useSessionTasks }
})
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    fallback.replace(/{{(\w+)}}/g, (_match, name: string) => String(options?.[name] ?? ''))
}))

const SOURCE = { worktreeId: 'wt', paneKey: 'tab-1:leaf-1', kind: 'pty' as const }
const step = (id: string, title: string, risk: 'safe' | 'risky' = 'safe'): NextStepSuggestion => ({
  id,
  title,
  prompt: `Please ${title.toLowerCase()}.`,
  risk,
  kind: 'continue'
})
const startSet = (over: Partial<NextStepSuggestionSet> = {}): NextStepSuggestionSet => ({
  id: 'start-1',
  worktreeId: 'wt',
  turnKey: 'start:wt:2026-09-23-14',
  origin: 'start',
  createdAt: 1,
  status: 'pending',
  suggestions: [
    step('s1', 'Run the tests'),
    step('s2', 'Review the diff'),
    step('c1', 'Finish the parser')
  ],
  ...over
})
const calls = (method: string) =>
  mocks.rpc.mock.calls.filter(([, name]) => name === method).map(([, , params]) => params)

function fakeHost(_target: unknown, method: string, params: Record<string, unknown>) {
  if (method === NEXT_STEPS_RPC.current) {
    return Promise.resolve({
      turnKey: null,
      turnObserved: mocks.turnObserved,
      answered: false,
      revision: 1
    })
  }
  if (method === NEXT_STEPS_RPC.suggestStart) {
    return Promise.resolve({ set: mocks.set })
  }
  if (method === NEXT_STEPS_RPC.decide) {
    const decision = params.decision as { action: string; suggestionIds?: string[] }
    const status = decision.action === 'dismiss' ? 'dismissed' : 'accepted'
    mocks.set = { ...(mocks.set as NextStepSuggestionSet), status }
    return Promise.resolve({
      set: mocks.set,
      queued: decision.action === 'run' ? decision.suggestionIds : [],
      notQueued: []
    })
  }
  if (method === NEXT_STEPS_RPC.list) {
    return Promise.resolve({ sets: [mocks.set], skips: [], revision: 1 })
  }
  return Promise.reject(new Error(`unexpected ${method}`))
}

function renderStart() {
  return render(
    <NextStepsStartTray
      worktreeId="wt"
      paneKey="tab-1:leaf-1"
      tabId="tab-1"
      agent="claude"
      active
    />
  )
}

beforeEach(() => {
  mocks.set = startSet()
  mocks.links = {}
  mocks.owned = true
  mocks.turnObserved = false
  mocks.rpc.mockImplementation(fakeHost)
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('asks the host once for this workspace’s starts, with the launching card when there is one', async () => {
  mocks.links = { card: { taskId: 'btk_1' } }
  renderStart()
  expect(await screen.findByText('Suggested starts')).toBeTruthy()
  expect(calls(NEXT_STEPS_RPC.suggestStart)).toEqual([
    { worktreeId: 'wt', taskId: 'btk_1', agent: 'claude' }
  ])
})

it('sends the first selected step as the first message and queues the rest, in order', async () => {
  renderStart()
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Finish the parser' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Run the tests' }))
  fireEvent.click(screen.getByRole('button', { name: 'Run selected (2)' }))
  await waitFor(() => expect(calls(NEXT_STEPS_RPC.decide)).toHaveLength(1))
  // One decide, bound to this new conversation: the host queues s1 (sent first) then c1.
  expect(calls(NEXT_STEPS_RPC.decide)[0]).toEqual({
    setId: 'start-1',
    decision: { action: 'run', suggestionIds: ['s1', 'c1'] },
    conversation: SOURCE
  })
  await waitFor(() => expect(screen.queryByText('Suggested starts')).toBeNull())
})

it('dismiss hides the starts, and the same hour’s set stays hidden on the next visit', async () => {
  const first = renderStart()
  fireEvent.click(await screen.findByRole('button', { name: 'Dismiss suggestions' }))
  await waitFor(() => expect(screen.queryByText('Suggested starts')).toBeNull())
  expect(calls(NEXT_STEPS_RPC.decide)[0]).toEqual({
    setId: 'start-1',
    decision: { action: 'dismiss' },
    conversation: SOURCE
  })
  first.unmount()
  renderStart()
  await waitFor(() => expect(calls(NEXT_STEPS_RPC.suggestStart)).toHaveLength(2))
  expect(screen.queryByText('Suggested starts')).toBeNull()
})

it('shows carry-over while the AI writes, but nothing can be answered until it is done', async () => {
  mocks.set = startSet({ status: 'generating', suggestions: [step('c1', 'Finish the parser')] })
  renderStart()
  expect(await screen.findByText('Finish the parser')).toBeTruthy()
  expect(screen.getByText('Thinking of next steps…')).toBeTruthy()
  expect(
    (screen.getByRole('button', { name: 'Run all safe (1)' }) as HTMLButtonElement).disabled
  ).toBe(true)
})

it('"Run all safe" on starts never sends a risky step', async () => {
  mocks.set = startSet({
    suggestions: [step('s1', 'Run the tests'), step('s2', 'Deploy to prod', 'risky')]
  })
  renderStart()
  fireEvent.click(await screen.findByRole('button', { name: 'Run all safe (1)' }))
  await waitFor(() => expect(calls(NEXT_STEPS_RPC.decide)).toHaveLength(1))
  expect(calls(NEXT_STEPS_RPC.decide)[0]).toMatchObject({
    decision: { action: 'run', suggestionIds: ['s1'] }
  })
})

it('asks once more with the card when the session’s task becomes known after the first ask', async () => {
  const view = renderStart()
  await waitFor(() => expect(calls(NEXT_STEPS_RPC.suggestStart)).toHaveLength(1))
  mocks.links = { card: { taskId: 'btk_7' } }
  view.rerender(
    <NextStepsStartTray
      worktreeId="wt"
      paneKey="tab-1:leaf-1"
      tabId="tab-1"
      agent="claude"
      active
    />
  )
  await waitFor(() => expect(calls(NEXT_STEPS_RPC.suggestStart)).toHaveLength(2))
  expect(calls(NEXT_STEPS_RPC.suggestStart)[1]).toEqual({
    worktreeId: 'wt',
    taskId: 'btk_7',
    agent: 'claude',
    force: true
  })
  view.rerender(
    <NextStepsStartTray
      worktreeId="wt"
      paneKey="tab-1:leaf-1"
      tabId="tab-1"
      agent="claude"
      active
    />
  )
  expect(calls(NEXT_STEPS_RPC.suggestStart)).toHaveLength(2)
})

it('asks and shows nothing without the real conversation, or once the host saw a turn', async () => {
  mocks.owned = false
  const first = renderStart()
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(screen.queryByText('Suggested starts')).toBeNull()
  expect(mocks.rpc).not.toHaveBeenCalled()
  first.unmount()
  mocks.owned = true
  mocks.turnObserved = true
  renderStart()
  await waitFor(() => expect(calls(NEXT_STEPS_RPC.current)).toHaveLength(1))
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(screen.queryByText('Suggested starts')).toBeNull()
  expect(calls(NEXT_STEPS_RPC.suggestStart)).toEqual([])
})

it('does not ask or show while the host cannot say whether a turn was observed', async () => {
  mocks.turnObserved = null
  renderStart()
  await waitFor(() => expect(calls(NEXT_STEPS_RPC.current)).toHaveLength(1))
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(screen.queryByText('Suggested starts')).toBeNull()
  expect(calls(NEXT_STEPS_RPC.suggestStart)).toEqual([])
})

it('says quietly why there are no starts', async () => {
  mocks.set = null
  mocks.rpc.mockImplementation((target: unknown, method: string, params: never) =>
    method === NEXT_STEPS_RPC.suggestStart
      ? Promise.resolve({ set: null, skipped: 'Suggested next steps are turned off in settings.' })
      : fakeHost(target, method, params)
  )
  renderStart()
  expect(await screen.findByText('Suggested next steps are turned off in settings.')).toBeTruthy()
})

it('reads a start set’s state and a fresh terminal agent', () => {
  expect(nextStepsStartView(startSet({ status: 'accepted' })).shown).toEqual([])
  expect(nextStepsStartView(startSet({ error: 'No model.' })).failure).toBe('No model.')
  const boundary = {
    state: 'done' as const,
    sessionBoundary: true,
    prompt: '',
    stateHistory: []
  }
  expect(isFreshAgentStatus(boundary)).toBe(true)
  expect(isFreshAgentStatus({ ...boundary, prompt: 'Fix it' })).toBe(false)
  expect(
    isFreshAgentStatus({
      ...boundary,
      stateHistory: [{ state: 'working', startedAt: 1 } as never]
    })
  ).toBe(false)
  expect(isFreshAgentStatus(undefined)).toBe(false)
})
