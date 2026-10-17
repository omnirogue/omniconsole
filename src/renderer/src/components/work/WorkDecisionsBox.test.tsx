// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionDecision } from '../../../../shared/session-decisions'

const decision = (key: string, patch: Partial<SessionDecision> = {}): SessionDecision => ({
  key,
  paneKey: `tab-1:11111111-2222-4333-8444-55555555555${key.length}`,
  worktreeId: 'wt-1',
  agent: 'claude',
  askedAt: Date.now() - 5 * 60_000,
  toolUseId: key,
  toolName: 'AskUserQuestion',
  interactivePrompt: '{}',
  context: 'I merged the fix; one choice left.',
  providerSession: { key: 'session_id', id: `session-${key}` },
  endedAt: null,
  scores: { impact: 0.72, risk: 0.35, effort: 0.2, model: 'jev-1.13.0', at: 1 },
  updatedAt: 1,
  title: null,
  questions: [
    {
      question: `Ship ${key}?`,
      header: 'Next',
      multiSelect: false,
      options: [{ label: 'Yes' }, { label: 'No' }]
    }
  ],
  scoreUnavailable: null,
  ...patch
})

const mocks = vi.hoisted(() => ({
  queue: {} as Record<string, unknown>,
  delivery: { kind: 'keys', tabId: 'tab-1', ptyId: 'pty-1' } as Record<string, unknown>,
  deliver: vi.fn(),
  call: vi.fn(),
  toast: vi.fn()
}))
vi.mock('@/components/needs-you/use-session-decisions', () => ({
  useSessionDecisionQueue: () => mocks.queue
}))
vi.mock('@/components/needs-you/session-decision-answer', () => ({
  decisionDelivery: () => mocks.delivery,
  deliverDecisionAsMessage: mocks.deliver
}))
vi.mock('@/components/needs-you/DecisionLiveQuestion', () => ({
  DecisionLiveQuestion: ({ onAnswered }: { onAnswered: () => void }) => (
    <button type="button" onClick={onAnswered}>
      live card
    </button>
  )
}))
vi.mock('@/components/sidebar/session-folders/use-sidebar-sessions', () => ({
  useSidebarSessions: () => []
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({ agentStatusByPaneKey: new Proxy({}, { get: () => ({ state: 'waiting' }) }) }),
    { getState: () => ({}) }
  )
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.call }))
vi.mock('@/lib/activate-sidebar-session', () => ({ activateSidebarSession: vi.fn() }))
vi.mock('sonner', () => ({
  toast: { success: mocks.toast, error: mocks.toast, message: mocks.toast }
}))

import { WorkDecisionsBox } from './WorkDecisionsBox'

function queue(current: SessionDecision | null, total: number): void {
  mocks.queue = {
    loaded: true,
    failed: false,
    status: total ? 'healthy' : 'healthy-empty',
    issue: null,
    lastSuccessAt: Date.now(),
    current,
    position: current ? 1 : 0,
    total,
    answered: vi.fn(),
    skip: vi.fn(),
    refresh: vi.fn()
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.delivery = { kind: 'keys', tabId: 'tab-1', ptyId: 'pty-1' }
  mocks.call.mockResolvedValue({ removed: true })
})
afterEach(cleanup)

it('shows one decision at a time with its position, JEV reading and the agent’s words', () => {
  queue(decision('a'), 3)
  render(<WorkDecisionsBox />)
  expect(screen.getByText('Needs You — Questions')).toBeTruthy()
  expect(screen.getByText('1 of 3')).toBeTruthy()
  expect(screen.getByText('72%')).toBeTruthy()
  expect(screen.getByText('I merged the fix; one choice left.')).toBeTruthy()
  expect(screen.getAllByRole('button', { name: 'live card' })).toHaveLength(1)
})

it('moves on the moment the live question is answered, and Skip sends it to the back', () => {
  queue(decision('a'), 2)
  render(<WorkDecisionsBox />)
  fireEvent.click(screen.getByRole('button', { name: 'live card' }))
  expect(mocks.queue.answered).toHaveBeenCalledWith('a')
  fireEvent.click(screen.getByRole('button', { name: /Skip/ }))
  expect(mocks.queue.skip).toHaveBeenCalledWith('a')
})

it('answers an ended session by resuming it with the answer, then shows the next one', async () => {
  mocks.delivery = { kind: 'resume', record: {} }
  mocks.deliver.mockResolvedValue(true)
  queue(decision('b', { endedAt: 5 }), 1)
  render(<WorkDecisionsBox />)
  expect(screen.getByText(/ended while it waited/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /Yes/ }))
  await waitFor(() => expect(mocks.queue.answered).toHaveBeenCalledWith('b'))
  expect(mocks.deliver).toHaveBeenCalledWith(
    expect.objectContaining({ key: 'b' }),
    mocks.delivery,
    expect.objectContaining({ questions: expect.any(Array) }),
    [{ indices: [0], other: '' }]
  )
})

it('keeps an ended question it could not deliver, and lets the person dismiss it', async () => {
  mocks.delivery = { kind: 'resume', record: {} }
  mocks.deliver.mockResolvedValue(false)
  queue(decision('c', { endedAt: 5 }), 1)
  render(<WorkDecisionsBox />)
  fireEvent.click(screen.getByRole('button', { name: /No/ }))
  await waitFor(() => expect(mocks.toast).toHaveBeenCalled())
  expect(mocks.queue.answered).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
  await waitFor(() => expect(mocks.queue.answered).toHaveBeenCalledWith('c'))
  expect(mocks.call).toHaveBeenCalledWith({ kind: 'local' }, 'sessionDecisions.dismiss', {
    key: 'c'
  })
})

it('says plainly when nothing is waiting', () => {
  queue(null, 0)
  render(<WorkDecisionsBox />)
  expect(screen.getByText('no session is waiting on a question')).toBeTruthy()
})

it('points a still-waiting question to its session, and offers Dismiss only once it ended', () => {
  mocks.delivery = { kind: 'unreachable' }
  queue(decision('f'), 1)
  const { unmount } = render(<WorkDecisionsBox />)
  expect(screen.getByText(/may still be waiting on it/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
  unmount()
  queue(decision('g', { endedAt: 5 }), 1)
  render(<WorkDecisionsBox />)
  expect(screen.getByText(/can’t be answered from here/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy()
})

it.each(['signed-out', 'unavailable', 'stale'])(
  'shows %s status even with no decisions',
  (status) => {
    queue(null, 0)
    Object.assign(mocks.queue, {
      status,
      failed: true,
      issue: status === 'signed-out' ? 'signed-out' : 'unavailable'
    })
    render(<WorkDecisionsBox />)
    expect(screen.getByRole('status')).toBeTruthy()
    expect(screen.queryByText('no session is waiting on a question')).toBeNull()
    if (status === 'stale') {
      expect(screen.getByRole('status').textContent).toContain('last successful list')
    }
  }
)
