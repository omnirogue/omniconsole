// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NextStepSuggestionSet } from '../../../../shared/next-step-suggestions'
import { NEXT_STEPS_RPC } from '../../../../shared/next-step-suggestions-rpc'
import { NextStepsInbox } from './NextStepsInbox'
import { dismissAllInInbox, nextStepsInboxRows } from './next-steps-inbox'
import { buildInboxRunPlan, runInboxPlan } from './next-steps-inbox-run-plan'
import {
  NEXT_STEPS_PENDING_TIMEOUT_MS,
  pendingNextStepSetsByConversation,
  usePendingNextSteps
} from './next-steps-pending-store'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), sets: [] as unknown[], toast: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/components/sidebar/session-folders/use-sidebar-sessions', () => ({
  useSidebarSessions: () => SESSIONS
}))
vi.mock('@/lib/conversation-source-for-session', () => ({
  conversationSourceForSession: (session: { paneKey: string }) => ({
    worktreeId: 'wt',
    paneKey: session.paneKey,
    kind: 'pty'
  })
}))
vi.mock('@/components/sidebar/session-folders/session-bulk-outcome', async (original) => ({
  ...(await original<object>()),
  toastSessionBulkOutcomes: mocks.toast
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({ agentStatusByPaneKey: {} })
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    fallback.replace(/{{(\w+)}}/g, (_match, name: string) => String(options?.[name] ?? ''))
}))

const SESSIONS = [
  { kind: 'terminal', paneKey: 'tab-1:leaf-1', tabId: 'tab-1', label: 'Parser work' },
  { kind: 'terminal', paneKey: 'tab-2:leaf-2', tabId: 'tab-2', label: 'Docs pass' },
  { kind: 'terminal', paneKey: 'tab-3:leaf-3', tabId: 'tab-3', label: 'Release' }
]

const step = (id: string, title: string, risk: 'safe' | 'risky' = 'safe') => ({
  id,
  title,
  prompt: `Please ${title.toLowerCase()}.`,
  risk,
  kind: 'continue' as const
})
const set = (
  id: string,
  paneKey: string,
  over: Partial<NextStepSuggestionSet> = {}
): NextStepSuggestionSet => ({
  id,
  conversation: { worktreeId: 'wt', paneKey, kind: 'pty' },
  worktreeId: 'wt',
  turnKey: `${paneKey}@1`,
  origin: 'ai',
  createdAt: 10,
  status: 'pending',
  suggestions: [step('a1', 'Run the tests'), step('a2', 'Deploy to production', 'risky')],
  ...over
})
const SETS = [
  set('parser', 'tab-1:leaf-1', { createdAt: 30 }),
  set('docs', 'tab-2:leaf-2', {
    createdAt: 20,
    suggestions: [step('d1', 'Fix the typo'), step('d2', 'Tidy the index')]
  }),
  set('release', 'tab-3:leaf-3', {
    createdAt: 10,
    suggestions: [step('r1', 'Merge the release branch', 'risky')]
  }),
  set('old', 'tab-1:leaf-1', { createdAt: 5, status: 'accepted' }),
  set('gone', 'tab-2:leaf-2', { createdAt: 1, status: 'dismissed' })
]

const calls = (method: string) =>
  mocks.rpc.mock.calls.filter(([, name]) => name === method).map(([, , params]) => params)

function fakeHost(_target: unknown, method: string, params: Record<string, unknown>) {
  if (method === NEXT_STEPS_RPC.list) {
    return Promise.resolve({ sets: mocks.sets, skips: [], revision: 1 })
  }
  if (method === NEXT_STEPS_RPC.decide) {
    const decision = params.decision as { action: string; suggestionIds?: string[] }
    if (!mocks.sets.some((entry) => (entry as { id: string }).id === params.setId)) {
      return Promise.reject(
        new Error('These suggestions are accepted and can no longer be answered.')
      )
    }
    return Promise.resolve({
      set: { id: params.setId, status: decision.action === 'dismiss' ? 'dismissed' : 'accepted' },
      queued: decision.suggestionIds ?? [],
      notQueued: []
    })
  }
  return Promise.reject(new Error(`unexpected ${method}`))
}

const rows = () => nextStepsInboxRows(pendingNextStepSetsByConversation(SETS), SESSIONS as never)

beforeEach(() => {
  usePendingNextSteps.setState({
    counts: new Map(),
    sets: undefined,
    revision: null,
    unknown: false
  })
  mocks.sets = SETS.filter((entry) => entry.status === 'pending')
  mocks.rpc.mockImplementation(fakeHost)
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('lists only conversations with a pending set, keyed by workspace and pane, newest first', () => {
  expect(rows().map((row) => [row.label, row.set.id, row.tabId, row.missing])).toEqual([
    ['Parser work', 'parser', 'tab-1', false],
    ['Docs pass', 'docs', 'tab-2', false],
    ['Release', 'release', 'tab-3', false]
  ])
  // The same pane key in another workspace is another conversation, and has no session here.
  const elsewhere = set('far', 'tab-1:leaf-1', { worktreeId: 'wt2', createdAt: 40 })
  elsewhere.conversation = { worktreeId: 'wt2', paneKey: 'tab-1:leaf-1', kind: 'pty' }
  const withElsewhere = nextStepsInboxRows(
    pendingNextStepSetsByConversation([...SETS, elsewhere]),
    SESSIONS as never
  )
  expect(withElsewhere[0]).toMatchObject({
    set: { id: 'far' },
    label: 'Session not found',
    tabId: null,
    missing: true
  })
  expect(withElsewhere).toHaveLength(4)
})

const current = () => pendingNextStepSetsByConversation(mocks.sets as NextStepSuggestionSet[])

it('plans only safe steps and names what needs the person; runs exactly the plan', async () => {
  const plan = buildInboxRunPlan(rows())
  expect(
    plan.entries.map((entry) => [entry.label, entry.setId, entry.steps.map((s) => s.id)])
  ).toEqual([
    ['Parser work', 'parser', ['a1']],
    ['Docs pass', 'docs', ['d1', 'd2']]
  ])
  expect(plan.count).toBe(3)
  expect(plan.needsYou).toEqual([
    expect.objectContaining({ label: 'Parser work', titles: ['Deploy to production'] }),
    expect.objectContaining({ label: 'Release', titles: ['Merge the release branch'] })
  ])
  const outcomes = await runInboxPlan(plan, current())
  expect(calls(NEXT_STEPS_RPC.decide)).toEqual([
    { setId: 'parser', decision: { action: 'run', suggestionIds: ['a1'] } },
    { setId: 'docs', decision: { action: 'run', suggestionIds: ['d1', 'd2'] } }
  ])
  expect(outcomes).toEqual([
    { key: expect.any(String), label: 'Parser work', ok: true },
    { key: expect.any(String), label: 'Docs pass', ok: true },
    { key: expect.any(String), label: 'Release', ok: false, message: 'Needs you: risky steps' }
  ])
})

it('skips a session whose set changed or was answered between review and confirm', async () => {
  const plan = buildInboxRunPlan(rows())
  // After the review opened: parser was answered, docs rewrote a prompt.
  mocks.sets = [
    set('docs', 'tab-2:leaf-2', {
      createdAt: 20,
      suggestions: [
        step('d1', 'Fix the typo'),
        { ...step('d2', 'Tidy the index'), prompt: 'rm -rf docs' }
      ]
    })
  ]
  const outcomes = await runInboxPlan(plan, current())
  expect(calls(NEXT_STEPS_RPC.decide)).toEqual([])
  expect(outcomes.slice(0, 2)).toEqual([
    expect.objectContaining({
      label: 'Parser work',
      ok: false,
      message: expect.stringMatching(/changed or were answered/)
    }),
    expect.objectContaining({
      label: 'Docs pass',
      ok: false,
      message: expect.stringMatching(/changed or were answered/)
    })
  ])
  expect(await runInboxPlan(plan, null)).toEqual(
    expect.arrayContaining([expect.objectContaining({ label: 'Docs pass', ok: false })])
  )
  expect(calls(NEXT_STEPS_RPC.decide)).toEqual([])
})

it('takes the decide answer as the truth when the host refuses a reviewed set', async () => {
  const plan = buildInboxRunPlan(rows())
  const stillShown = current()
  mocks.sets = SETS.filter((entry) => entry.id === 'docs')
  const outcomes = await runInboxPlan(plan, stillShown)
  expect(outcomes[0]).toMatchObject({
    label: 'Parser work',
    ok: false,
    message: expect.stringMatching(/^Skipped: no longer pending\./)
  })
  expect(outcomes[1]).toMatchObject({ label: 'Docs pass', ok: true })
})

it('never plans a row whose session is not found, nor a set with no steps', () => {
  const [missing] = nextStepsInboxRows(pendingNextStepSetsByConversation(SETS), [])
  const unnamed = [{ kind: 'terminal', paneKey: 'tab-1:leaf-1', tabId: 'tab-1', label: '' }]
  const [row] = nextStepsInboxRows(
    pendingNextStepSetsByConversation([set('parser', 'tab-1:leaf-1')]),
    unnamed as never
  )
  expect(row).toMatchObject({ label: 'Untitled conversation', missing: false })
  const empty = { ...row!, set: { ...row!.set, suggestions: [] } }
  const plan = buildInboxRunPlan([missing!, empty])
  expect(plan.entries).toEqual([])
  expect(plan.needsYou.map((item) => item.reason)).toEqual(['Session not found', 'No suggestions.'])
})

it('dismisses every set, reporting the ones already answered', async () => {
  mocks.sets = SETS.filter((entry) => entry.id !== 'release')
  const outcomes = await dismissAllInInbox(rows())
  expect(calls(NEXT_STEPS_RPC.decide).map((params) => (params as { setId: string }).setId)).toEqual(
    ['parser', 'docs', 'release']
  )
  expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, true, false])
})

it('sends nothing until the person confirms the exact prompts shown, then only those', async () => {
  render(<NextStepsInbox />)
  expect(await screen.findByText('Parser work')).toBeTruthy()
  expect(screen.getByText('3 sessions')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Run all safe in 2 sessions' }))
  const shown = await waitFor(() => {
    const prompts = [...document.querySelectorAll('[data-review-prompt]')]
    expect(prompts.length).toBe(3)
    return prompts
  })
  expect(shown.map((node) => node.textContent)).toEqual([
    'Please run the tests.',
    'Please fix the typo.',
    'Please tidy the index.'
  ])
  expect(screen.getByText(/Release: Needs you: risky steps/)).toBeTruthy()
  expect(calls(NEXT_STEPS_RPC.decide)).toEqual([])
  fireEvent.click(screen.getByRole('button', { name: 'Run these 3' }))
  await waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(1))
  const sent = calls(NEXT_STEPS_RPC.decide).flatMap((params) => {
    const { setId, decision } = params as { setId: string; decision: { suggestionIds: string[] } }
    return decision.suggestionIds.map((id) => `${setId}:${id}`)
  })
  expect(sent).toEqual(shown.map((node) => node.getAttribute('data-review-prompt')))
  expect(mocks.toast.mock.calls[0]![0]).toBe('Run all safe')
})

it('cancelling the review sends nothing', async () => {
  render(<NextStepsInbox />)
  fireEvent.click(await screen.findByRole('button', { name: 'Run all safe in 2 sessions' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(document.querySelector('[data-review-prompt]')).toBeNull())
  expect(calls(NEXT_STEPS_RPC.decide)).toEqual([])
})

it('says the inbox is unknown when the host cannot be read, never that nothing is waiting', async () => {
  mocks.rpc.mockImplementation(() => Promise.reject(new Error('method not found')))
  render(<NextStepsInbox />)
  expect(
    await screen.findByText(
      'Suggested next steps could not be read. They will show again once the host answers.'
    )
  ).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Run all safe/ })).toBeNull()
})

it('falls back to unknown when the host never answers', async () => {
  vi.useFakeTimers()
  try {
    mocks.rpc.mockImplementation(() => new Promise(() => {}))
    render(<NextStepsInbox />)
    await vi.advanceTimersByTimeAsync(NEXT_STEPS_PENDING_TIMEOUT_MS + 10)
    expect(usePendingNextSteps.getState().unknown).toBe(true)
  } finally {
    vi.useRealTimers()
  }
})
