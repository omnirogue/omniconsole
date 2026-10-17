// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type {
  NextStepSuggestion,
  NextStepSuggestionSet
} from '../../../../shared/next-step-suggestions'
import {
  NEXT_STEPS_RPC,
  type NextStepsCurrentResult
} from '../../../../shared/next-step-suggestions-rpc'
import type { NextStepKeepGoingState } from '../../../../shared/next-step-keep-going'
import { usePendingNextSteps } from './next-steps-pending-store'
import { NextStepsTray } from './NextStepsTray'
import { latestNextStepsReply } from './next-steps-tray-model'

type Host = {
  turnKey: string | null
  ai?: NextStepSuggestionSet
  parsed?: NextStepSuggestionSet
  answered: boolean
  turnObserved?: boolean | null
  turnCompletedAt?: number
  revision: number
}

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  save: vi.fn(),
  host: { turnKey: 't1', answered: false, revision: 1 } as Host,
  keepGoing: [] as NextStepKeepGoingState[],
  keepGoingRevision: 1
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.rpc,
  RuntimeRpcCallError: class extends Error {
    code = 'error'
  }
}))
vi.mock('./next-steps-save-for-later', () => ({ saveNextStepsForLater: mocks.save }))
vi.mock('@/components/sidebar/session-folders/use-sidebar-sessions', () => ({
  useSidebarSessions: () => [{ paneKey: 'tab-1:leaf-1', tabId: 'tab-1', label: 'Parser work' }]
}))
vi.mock('@/lib/conversation-source-for-session', () => ({
  conversationSourceForSession: () => SOURCE
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    fallback.replace(/{{(\w+)}}/g, (_match, name: string) => String(options?.[name] ?? ''))
}))

const SOURCE = { worktreeId: 'wt', paneKey: 'tab-1:leaf-1', kind: 'pty' as const }
const reply = (text: string, id = 'reply'): NativeChatMessage => ({
  id,
  role: 'assistant',
  timestamp: 1,
  source: 'transcript',
  blocks: [{ type: 'text', text }]
})
const LIST = reply(
  'Next steps:\n1. Review the PR\n2. Deploy the change to omni-dev\n3. Update the changelog\n4. Add a regression test'
)
const step = (id: string, title: string, over: Partial<NextStepSuggestion> = {}) => ({
  id,
  title,
  prompt: `Please ${title.toLowerCase()}.`,
  risk: 'safe' as const,
  kind: 'continue' as const,
  ...over
})
const aiSet = (over: Partial<NextStepSuggestionSet>): NextStepSuggestionSet => ({
  id: 'ai-1',
  conversation: SOURCE,
  worktreeId: 'wt',
  turnKey: 't1',
  origin: 'ai',
  createdAt: 10,
  status: 'pending',
  suggestions: [step('a1', 'Run the parser tests'), step('a2', 'Open a draft PR')],
  ...over
})
/** A turn whose reply proposed nothing: the AI's set leads. */
const aiOnly = (over: Partial<NextStepSuggestionSet> = {}) => {
  mocks.host.parsed = undefined
  mocks.host.ai = aiSet(over)
}
const calls = (method: string) =>
  mocks.rpc.mock.calls.filter(([, name]) => name === method).map(([, , params]) => params)
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

function fakeHost(target: unknown, method: string, params: Record<string, unknown>) {
  void target
  const host = mocks.host
  if (method === NEXT_STEPS_RPC.current) {
    return Promise.resolve({ turnObserved: true, ...host } satisfies NextStepsCurrentResult)
  }
  if (method === NEXT_STEPS_RPC.list) {
    return Promise.resolve({
      sets: [],
      skips: [],
      revision: mocks.keepGoingRevision,
      keepGoing: mocks.keepGoing
    })
  }
  if (method === NEXT_STEPS_RPC.keepGoing) {
    // Like the host: stopping what is not running changes nothing.
    const current = mocks.keepGoing[0]
    if (!params.enabled && current && !current.enabled) {
      return Promise.resolve({ state: current })
    }
    const state: NextStepKeepGoingState = params.enabled
      ? {
          conversation: SOURCE,
          enabled: true,
          maxRounds: params.maxRounds as number,
          roundsUsed: 0,
          startedAt: 20
        }
      : {
          conversation: SOURCE,
          enabled: false,
          maxRounds: 3,
          roundsUsed: 2,
          startedAt: 20,
          stoppedAt: 30,
          stopReason: 'person-stopped'
        }
    mocks.keepGoing = [state]
    mocks.keepGoingRevision += 1
    return Promise.resolve({ state })
  }
  if (method === NEXT_STEPS_RPC.offerParsed) {
    const set: NextStepSuggestionSet = {
      id: 'parsed-1',
      conversation: SOURCE,
      worktreeId: 'wt',
      turnKey: `tab-1:leaf-1@reply:${params.messageId as string}`,
      origin: 'parsed',
      createdAt: 2,
      status: 'pending',
      suggestions: params.suggestions as NextStepSuggestion[],
      messageId: params.messageId as string
    }
    mocks.host = { ...host, turnKey: set.turnKey, parsed: set, revision: host.revision + 1 }
    return Promise.resolve({ set })
  }
  if (method === NEXT_STEPS_RPC.decide) {
    const decision = params.decision as { action: string; suggestionIds?: string[] }
    const set = [host.ai, host.parsed].find((entry) => entry?.id === params.setId)!
    const status = decision.action === 'dismiss' ? 'dismissed' : 'accepted'
    const decided = { ...set, status } as NextStepSuggestionSet
    mocks.host = {
      ...host,
      ...(set.origin === 'ai' ? { ai: decided } : { parsed: decided }),
      answered: true,
      revision: host.revision + 1
    }
    return Promise.resolve({
      set: decided,
      queued: decision.action === 'run' ? decision.suggestionIds : [],
      notQueued: []
    })
  }
  if (method === NEXT_STEPS_RPC.generate) {
    return Promise.resolve({ set: aiSet({ id: 'ai-2', status: 'generating', suggestions: [] }) })
  }
  return Promise.reject(new Error(`unexpected ${method}`))
}

function renderTray(messages: readonly NativeChatMessage[] = [LIST]) {
  return render(
    <NextStepsTray messages={messages} paneKey="tab-1:leaf-1" tabId="tab-1" disabled={false} />
  )
}

// What the host reads from the same reply at turn end.
const hostParsed = (): NextStepSuggestionSet => ({
  id: 'parsed-1',
  conversation: SOURCE,
  worktreeId: 'wt',
  turnKey: 't1',
  origin: 'parsed',
  createdAt: 2,
  status: 'pending',
  suggestions: latestNextStepsReply([LIST])!.suggestions
})
/** The host's answer changed: bump its revision and let the tray read it now. */
async function hostChanged(next: Partial<Host>) {
  mocks.host = { ...mocks.host, ...next, revision: mocks.host.revision + 1 }
  window.dispatchEvent(new Event('focus'))
}

beforeEach(() => {
  mocks.host = { turnKey: 't1', answered: false, revision: 1, parsed: hostParsed() }
  mocks.keepGoing = []
  mocks.keepGoingRevision = 1
  usePendingNextSteps.setState({
    counts: new Map(),
    keepGoing: new Map(),
    keepGoingStopsSeen: new Map(),
    keepGoingRevision: null,
    revision: null,
    unknown: false
  })
  mocks.rpc.mockImplementation(fakeHost)
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})

it('shows the steps the host read from the reply and never offers them itself', async () => {
  renderTray()
  expect(await screen.findByText('Review the PR')).toBeTruthy()
  expect(screen.getAllByRole('checkbox')).toHaveLength(4)
  expect(screen.getAllByText('Needs a tick')).toHaveLength(1)
  expect(screen.getByRole('button', { name: 'Run all safe (3)' })).toBeTruthy()
  expect(calls(NEXT_STEPS_RPC.offerParsed)).toEqual([])
})

it('leads with the reply’s own steps and lists an asked-for AI set beside them', async () => {
  mocks.host.ai = aiSet({})
  renderTray()
  expect(await screen.findByText('Review the PR')).toBeTruthy()
  expect(screen.getByText('More ideas from the AI')).toBeTruthy()
  expect(screen.getByText('Run the parser tests')).toBeTruthy()
  expect(screen.queryByText('Thinking of next steps…')).toBeNull()
  // Dismissing the extra ideas answers only the AI's set.
  fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss suggestions' })[1]!)
  await waitFor(() =>
    expect(calls(NEXT_STEPS_RPC.decide)).toEqual([
      { setId: 'ai-1', decision: { action: 'dismiss' } }
    ])
  )
})

it('answers a session that asked with one "Yes" above the checklist, whatever the risk label', async () => {
  const title = 'Make those two wording fixes, and save the rebuilt originals as backups'
  mocks.host.parsed = {
    ...hostParsed(),
    suggestions: [
      step('s1', title, {
        prompt: `Please go ahead with this next step you suggested: ${title}`,
        risk: 'risky',
        kind: 'fix',
        offered: true
      })
    ]
  }
  renderTray()
  const yes = await screen.findByRole('button', { name: `Yes: ${title}` })
  expect(yes.textContent).toBe('Yes')
  expect(screen.getAllByRole('button', { name: /^Yes: / })).toHaveLength(1)
  // Not in "Run all safe": only the person's explicit answer sends it.
  expect(screen.getByRole('button', { name: 'Run all safe (0)' })).toBeTruthy()
  fireEvent.click(yes)
  await waitFor(() =>
    expect(calls(NEXT_STEPS_RPC.decide)).toEqual([
      { setId: 'parsed-1', decision: { action: 'run', suggestionIds: ['s1'] } }
    ])
  )
})

it('"No" under a question dismisses it and sends nothing', async () => {
  mocks.host.parsed = {
    ...hostParsed(),
    suggestions: [
      step('s1', 'Open a PR', { offered: true }),
      step('s2', 'Add tests', { offered: true })
    ]
  }
  renderTray()
  expect(await screen.findByRole('button', { name: 'Yes: Open a PR' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Yes: Add tests' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'No, send nothing' }))
  await waitFor(() =>
    expect(calls(NEXT_STEPS_RPC.decide)).toEqual([
      { setId: 'parsed-1', decision: { action: 'dismiss' } }
    ])
  )
})

it('shows the AI set in the lead when the reply proposed nothing', async () => {
  aiOnly()
  renderTray()
  expect(await screen.findByText('Run the parser tests')).toBeTruthy()
  expect(screen.queryByText('Review the PR')).toBeNull()
  expect(screen.queryByText('More ideas from the AI')).toBeNull()
})

it('shows the reply’s steps and a thinking line while the AI set is written', async () => {
  mocks.host.ai = aiSet({ status: 'generating', suggestions: [] })
  renderTray()
  expect(await screen.findByText('Review the PR')).toBeTruthy()
  expect(screen.getByText('Thinking of next steps…')).toBeTruthy()
})

it('keeps the reply’s steps and says why when the AI set failed', async () => {
  mocks.host.ai = aiSet({ status: 'failed', suggestions: [], error: 'Codex is not signed in.' })
  renderTray()
  expect(await screen.findByText('Review the PR')).toBeTruthy()
  expect(screen.getByText('No AI suggestions: Codex is not signed in.')).toBeTruthy()
})

it('gives a failed AI set with no reason a default one, never blank text', async () => {
  mocks.host.ai = aiSet({ status: 'failed', suggestions: [] })
  renderTray()
  expect(await screen.findByText('Review the PR')).toBeTruthy()
  expect(screen.getByText('No AI suggestions: Suggestions could not be generated.')).toBeTruthy()
})

it('takes the rows away once the host says the turn is answered', async () => {
  renderTray()
  expect(await screen.findByText('Review the PR')).toBeTruthy()
  await hostChanged({ parsed: { ...hostParsed(), status: 'accepted' }, answered: true })
  await waitFor(() => expect(screen.queryByRole('checkbox')).toBeNull())
  expect(screen.queryByText('Suggest next steps')).toBeNull()
})

it('takes the rows away when a newer turn superseded them', async () => {
  renderTray()
  expect(await screen.findByText('Review the PR')).toBeTruthy()
  await hostChanged({ turnKey: 't2', parsed: undefined })
  await waitFor(() => expect(screen.queryByText('Review the PR')).toBeNull())
})

it('says so quietly when the host cannot be read, and offers nothing on a failed read', async () => {
  mocks.rpc.mockImplementation((target: unknown, method: string, params: never) =>
    method === NEXT_STEPS_RPC.current
      ? Promise.reject(new Error('host unavailable'))
      : fakeHost(target, method, params)
  )
  renderTray()
  expect(await screen.findByText('Suggestions could not be read: host unavailable')).toBeTruthy()
  expect(calls(NEXT_STEPS_RPC.offerParsed)).toEqual([])
})

it('offers a reply only for an agent that reports no turns, paced one try per poll', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  mocks.host = { turnKey: null, answered: false, revision: 1, turnObserved: false }
  let failures = 1
  mocks.rpc.mockImplementation((target: unknown, method: string, params: never) => {
    if (method === NEXT_STEPS_RPC.offerParsed && failures > 0) {
      failures -= 1
      return Promise.reject(new Error('busy'))
    }
    return fakeHost(target, method, params)
  })
  renderTray()
  // A grace period first: an agent with a turn signal reports its turn well within it.
  await vi.advanceTimersByTimeAsync(4_000)
  expect(calls(NEXT_STEPS_RPC.offerParsed)).toEqual([])
  await vi.advanceTimersByTimeAsync(2_100)
  expect(calls(NEXT_STEPS_RPC.offerParsed)).toEqual([
    { conversation: SOURCE, messageId: 'reply', suggestions: expect.any(Array) }
  ])
  expect(
    await screen.findByText('The reply’s suggestions could not be registered: busy')
  ).toBeTruthy()
  // The retry waits for the next tick instead of firing again at once.
  await vi.advanceTimersByTimeAsync(500)
  expect(calls(NEXT_STEPS_RPC.offerParsed)).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(2_000)
  expect(calls(NEXT_STEPS_RPC.offerParsed)).toHaveLength(2)
  expect(await screen.findByText('Review the PR')).toBeTruthy()
})

it('after an answered fallback, the first real turn shows no second tray', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  mocks.host = { turnKey: null, answered: false, revision: 1, turnObserved: false }
  renderTray()
  await vi.advanceTimersByTimeAsync(6_100)
  fireEvent.click(await screen.findByRole('button', { name: 'Run: Review the PR' }))
  await waitFor(() => expect(calls(NEXT_STEPS_RPC.decide)).toHaveLength(1))
  // The real turn arrives; the host carries the answer over to it.
  await hostChanged({
    turnKey: 't1',
    turnObserved: true,
    answered: true,
    parsed: {
      ...hostParsed(),
      status: 'accepted',
      error: "Answered from the reply's own suggestions."
    }
  })
  await vi.advanceTimersByTimeAsync(2_100)
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(calls(NEXT_STEPS_RPC.offerParsed)).toHaveLength(1)
})

it('treats an offer with no result as refused and does not retry it', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  mocks.host = { turnKey: null, answered: false, revision: 1, turnObserved: false }
  mocks.rpc.mockImplementation((target: unknown, method: string, params: never) =>
    method === NEXT_STEPS_RPC.offerParsed
      ? Promise.resolve(undefined)
      : fakeHost(target, method, params)
  )
  renderTray()
  await vi.advanceTimersByTimeAsync(12_000)
  expect(calls(NEXT_STEPS_RPC.offerParsed)).toHaveLength(1)
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(screen.queryByText(/could not be registered/)).toBeNull()
})

it('never offers while the host cannot tell whether it has seen a turn', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  mocks.host = { turnKey: null, answered: false, revision: 1, turnObserved: null }
  renderTray()
  await vi.advanceTimersByTimeAsync(12_000)
  expect(calls(NEXT_STEPS_RPC.offerParsed)).toEqual([])
})

it('answers "Run all safe" through decide with the safe ids in order', async () => {
  renderTray()
  fireEvent.click(await screen.findByRole('button', { name: 'Run all safe (3)' }))
  await waitFor(() => expect(screen.queryByText('Review the PR')).toBeNull())
  expect(calls(NEXT_STEPS_RPC.decide)).toEqual([
    { setId: 'parsed-1', decision: { action: 'run', suggestionIds: ['s1', 's3', 's4'] } }
  ])
  expect(calls('promptQueue.enqueue')).toEqual([])
})

it('answers "Run selected" in the set’s order whatever the click order', async () => {
  renderTray()
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Add a regression test' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Deploy the change to omni-dev' }))
  fireEvent.click(screen.getByRole('button', { name: 'Run selected (2)' }))
  await waitFor(() => expect(calls(NEXT_STEPS_RPC.decide)).toHaveLength(1))
  expect(calls(NEXT_STEPS_RPC.decide)[0]).toEqual({
    setId: 'parsed-1',
    decision: { action: 'run', suggestionIds: ['s2', 's4'] }
  })
})

it('runs one row and dismisses through decide', async () => {
  aiOnly()
  const first = renderTray()
  fireEvent.click(await screen.findByRole('button', { name: 'Run: Open a draft PR' }))
  await waitFor(() => expect(calls(NEXT_STEPS_RPC.decide)).toHaveLength(1))
  expect(calls(NEXT_STEPS_RPC.decide)[0]).toEqual({
    setId: 'ai-1',
    decision: { action: 'run', suggestionIds: ['a2'] }
  })
  first.unmount()
  mocks.host = { turnKey: 't1', answered: false, revision: 9, ai: aiSet({}) }
  renderTray()
  fireEvent.click(await screen.findByRole('button', { name: 'Dismiss suggestions' }))
  await waitFor(() => expect(calls(NEXT_STEPS_RPC.decide)).toHaveLength(2))
  expect(calls(NEXT_STEPS_RPC.decide)[1]).toEqual({
    setId: 'ai-1',
    decision: { action: 'dismiss' }
  })
})

it('sends exactly one decide for a double click', async () => {
  aiOnly()
  const answer = deferred<unknown>()
  mocks.rpc.mockImplementation((target: unknown, method: string, params: never) =>
    method === NEXT_STEPS_RPC.decide ? answer.promise : fakeHost(target, method, params)
  )
  renderTray()
  const run = await screen.findByRole('button', { name: 'Run all safe (2)' })
  fireEvent.click(run)
  fireEvent.click(run)
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss suggestions' }))
  // Every answer first stops Keep going on the host, then decides, once.
  await waitFor(() => expect(calls(NEXT_STEPS_RPC.decide)).toHaveLength(1))
  expect(
    screen.getByRole('button', { name: 'Run: Open a draft PR' }).hasAttribute('disabled')
  ).toBe(true)
  mocks.host = { ...mocks.host, ai: aiSet({ status: 'accepted' }), answered: true, revision: 7 }
  answer.resolve({ set: aiSet({ status: 'accepted' }), queued: ['a1', 'a2'], notQueued: [] })
  await waitFor(() => expect(screen.queryByText('Run the parser tests')).toBeNull())
  expect(calls(NEXT_STEPS_RPC.decide)).toHaveLength(1)
})

it('names what the host could not queue', async () => {
  mocks.rpc.mockImplementation((target: unknown, method: string, params: never) =>
    method === NEXT_STEPS_RPC.decide
      ? Promise.resolve({
          set: { ...mocks.host.parsed!, status: 'accepted' },
          queued: ['s1'],
          notQueued: [{ id: 's3', reason: 'The queue is full.' }]
        })
      : fakeHost(target, method, params)
  )
  renderTray()
  fireEvent.click(await screen.findByRole('button', { name: 'Run all safe (3)' }))
  expect((await screen.findByRole('alert')).textContent).toBe(
    'Not queued: Update the changelog. The queue is full.'
  )
})

it('shows a dismissal the decision log could not keep', async () => {
  aiOnly()
  mocks.rpc.mockImplementation((target: unknown, method: string, params: never) =>
    method === NEXT_STEPS_RPC.decide
      ? Promise.resolve({
          set: aiSet({ status: 'dismissed' }),
          queued: [],
          notQueued: [],
          logError: 'This decision could not be written to the decision log: disk full'
        })
      : fakeHost(target, method, params)
  )
  renderTray()
  fireEvent.click(await screen.findByRole('button', { name: 'Dismiss suggestions' }))
  expect((await screen.findByRole('alert')).textContent).toContain('disk full')
})

it('shows the exact prompt behind a disclosure, open already on a risky row', async () => {
  renderTray()
  const safePrompt = 'Please go ahead with this next step you suggested: Review the PR'
  await screen.findByText('Review the PR')
  expect(screen.queryByText(safePrompt)).toBeNull()
  expect(
    screen.getByText(
      'Please go ahead with this next step you suggested: Deploy the change to omni-dev'
    )
  ).toBeTruthy()
  const disclosure = screen.getByRole('button', { name: 'Show prompt: Review the PR' })
  expect(disclosure.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(disclosure)
  expect(screen.getByText(safePrompt)).toBeTruthy()
  expect(disclosure.getAttribute('aria-expanded')).toBe('true')
})

it('always shows every AI prompt, so "Run all safe" never sends one unseen', async () => {
  aiOnly({
    suggestions: [
      step('a1', 'Clean up', { prompt: 'Run `rm -rf dist` and rebuild.' }),
      step('a2', 'Read the notes', { prompt: 'Read https://example.com/notes first.' }),
      step('a3', 'Open a draft PR', { prompt: 'Open a draft PR' })
    ]
  })
  renderTray()
  const shown = await screen.findAllByLabelText('Prompt that will be sent')
  expect(shown.map((element) => element.textContent)).toEqual([
    'Run `rm -rf dist` and rebuild.',
    'Read https://example.com/notes first.'
  ])
  // No disclosure hides an AI prompt; one that only repeats its title is not repeated.
  expect(screen.queryByRole('button', { name: /^Show prompt:/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Run all safe (3)' }))
  await waitFor(() => expect(calls(NEXT_STEPS_RPC.decide)).toHaveLength(1))
  const sent = (calls(NEXT_STEPS_RPC.decide)[0] as { decision: { suggestionIds: string[] } })
    .decision.suggestionIds
  const prompts = mocks.host.ai!.suggestions.filter((entry) => sent.includes(entry.id))
  for (const prompt of prompts) {
    expect(
      prompt.prompt === prompt.title || shown.some((el) => el.textContent === prompt.prompt)
    ).toBe(true)
  }
})

it('asks for suggestions without force; only the explicit "Suggest again" forces', async () => {
  mocks.host.parsed = undefined
  const first = renderTray([reply('All done, the parser is fixed.')])
  fireEvent.click(await screen.findByRole('button', { name: 'Suggest next steps' }))
  await waitFor(() => expect(calls(NEXT_STEPS_RPC.generate)).toEqual([{ conversation: SOURCE }]))
  first.unmount()
  mocks.host = { turnKey: 't1', answered: false, revision: 5, ai: aiSet({}) }
  renderTray()
  await screen.findByText('Run the parser tests')
  fireEvent.click(screen.getByRole('button', { name: 'Suggest again' }))
  await waitFor(() => expect(calls(NEXT_STEPS_RPC.generate)).toHaveLength(2))
  expect(calls(NEXT_STEPS_RPC.generate)[1]).toEqual({ conversation: SOURCE, force: true })
})

it('saves the ticked steps for later, then records the save for the filed ids only', async () => {
  mocks.save.mockResolvedValue({
    cards: [
      { suggestionId: 's1', title: 'Review the PR', ok: true, taskId: 'btk_1' },
      { suggestionId: 's4', title: 'Add a regression test', ok: false, message: 'Hub is down.' }
    ]
  })
  renderTray()
  const save = await screen.findByRole('button', { name: 'Save for later (0)' })
  expect(save.hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Add a regression test' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Review the PR' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save for later (2)' }))
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toContain('Saved “Review the PR” as a Proposed card.')
  expect(alert.textContent).toContain('“Add a regression test” was not saved: Hub is down.')
  expect(mocks.save).toHaveBeenCalledWith({
    conversation: SOURCE,
    sessionLabel: 'Parser work',
    setId: 'parsed-1',
    suggestions: [expect.objectContaining({ id: 's1' }), expect.objectContaining({ id: 's4' })]
  })
  expect(calls(NEXT_STEPS_RPC.decide)).toEqual([
    { setId: 'parsed-1', decision: { action: 'save', suggestionIds: ['s1'] } }
  ])
})

it('warns when the cards were filed but the save was not recorded', async () => {
  mocks.save.mockResolvedValue({
    cards: [{ suggestionId: 's1', title: 'Review the PR', ok: true, taskId: 'btk_1' }]
  })
  mocks.rpc.mockImplementation((target: unknown, method: string, params: never) =>
    method === NEXT_STEPS_RPC.decide
      ? Promise.reject(new Error('The host restarted.'))
      : fakeHost(target, method, params)
  )
  renderTray()
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Review the PR' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save for later (1)' }))
  const alert = await screen.findByRole('alert')
  expect(alert.className).toContain('text-status-warning')
  expect(alert.textContent).toContain('The cards were filed, but the save was not recorded')
})

it('warns when the host did not take the save it was told about', async () => {
  mocks.save.mockResolvedValue({
    cards: [{ suggestionId: 's1', title: 'Review the PR', ok: true, taskId: 'btk_1' }]
  })
  mocks.rpc.mockImplementation((target: unknown, method: string, params: never) =>
    method === NEXT_STEPS_RPC.decide
      ? Promise.resolve({
          set: { ...hostParsed(), status: 'accepted' },
          queued: [],
          notQueued: [{ id: 's1', reason: 'That suggestion is not in this set.' }]
        })
      : fakeHost(target, method, params)
  )
  renderTray()
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Review the PR' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save for later (1)' }))
  const alert = await screen.findByRole('alert')
  expect(alert.className).toContain('text-status-warning')
  expect(alert.textContent).toContain('Saved “Review the PR” as a Proposed card.')
  expect(alert.textContent).toContain('That suggestion is not in this set.')
})

it('shows a filing refusal and records no save', async () => {
  mocks.save.mockResolvedValue({ refusal: 'Engineering has no active goal.' })
  renderTray()
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Review the PR' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save for later (1)' }))
  expect((await screen.findByRole('alert')).textContent).toBe('Engineering has no active goal.')
  expect(calls(NEXT_STEPS_RPC.decide)).toEqual([])
  expect(screen.getByText('Review the PR')).toBeTruthy()
})

it('stops polling the host once unmounted', async () => {
  vi.useFakeTimers()
  const view = renderTray()
  await vi.advanceTimersByTimeAsync(4_100)
  const polled = calls(NEXT_STEPS_RPC.current).length
  expect(polled).toBeGreaterThanOrEqual(3)
  view.unmount()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(calls(NEXT_STEPS_RPC.current)).toHaveLength(polled)
})

it('hides while the agent works and once the person replied', () => {
  const { rerender } = renderTray()
  rerender(<NextStepsTray messages={[LIST]} paneKey="tab-1:leaf-1" tabId="tab-1" disabled />)
  expect(screen.queryByLabelText('Suggested next steps')).toBeNull()
  rerender(
    <NextStepsTray
      messages={[LIST, { ...LIST, id: 'user', role: 'user' }]}
      paneKey="tab-1:leaf-1"
      tabId="tab-1"
      disabled={false}
    />
  )
  expect(screen.queryByLabelText('Suggested next steps')).toBeNull()
})

it('turns keep going on from the tray header with the default rounds', async () => {
  aiOnly()
  renderTray()
  fireEvent.click(await screen.findByRole('switch', { name: 'Keep going' }))
  await waitFor(() =>
    expect(calls(NEXT_STEPS_RPC.keepGoing)).toEqual([
      { conversation: SOURCE, enabled: true, maxRounds: 10 }
    ])
  )
  expect(await screen.findByText('Keep going · round 1 of 10')).toBeTruthy()
})

it('shows the running round while the agent works, and Stop turns it off', async () => {
  mocks.keepGoing = [
    { conversation: SOURCE, enabled: true, maxRounds: 3, roundsUsed: 2, startedAt: 20 }
  ]
  render(<NextStepsTray messages={[LIST]} paneKey="tab-1:leaf-1" tabId="tab-1" disabled />)
  expect(await screen.findByText('Keep going · round 2 of 3')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
  await waitFor(() =>
    expect(calls(NEXT_STEPS_RPC.keepGoing)).toEqual([{ conversation: SOURCE, enabled: false }])
  )
  await waitFor(() => expect(screen.queryByText('Keep going · round 2 of 3')).toBeNull())
  // The person's own Stop needs no explanation.
  expect(screen.queryByText(/^Stopped:/)).toBeNull()
})

it('says why keep going stopped until the person acts', async () => {
  aiOnly()
  mocks.keepGoing = [
    {
      conversation: SOURCE,
      enabled: false,
      maxRounds: 3,
      roundsUsed: 1,
      startedAt: 20,
      stoppedAt: 40,
      stopReason: 'needs-you-risky'
    }
  ]
  renderTray()
  expect(await screen.findByText('Stopped: the next step is risky and needs you')).toBeTruthy()
  fireEvent.click(await screen.findByRole('button', { name: 'Dismiss suggestions' }))
  await waitFor(() =>
    expect(screen.queryByText('Stopped: the next step is risky and needs you')).toBeNull()
  )
})

it('disables the switch and says so when keep-going state is unknown', async () => {
  aiOnly()
  renderTray()
  const toggle = await screen.findByRole('switch', { name: 'Keep going' })
  usePendingNextSteps.setState({ unknown: true })
  await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(true))
  expect(screen.getByText('Keep going (unknown)')).toBeTruthy()
})

it('shows the switch as unknown and disabled until the first keep-going read lands', async () => {
  aiOnly()
  const list = deferred<unknown>()
  mocks.rpc.mockImplementation(
    (target: unknown, method: string, params: Record<string, unknown>) =>
      method === NEXT_STEPS_RPC.list ? list.promise : fakeHost(target, method, params)
  )
  renderTray()
  const toggle = await screen.findByRole('switch', { name: 'Keep going (unknown)' })
  expect(toggle.hasAttribute('disabled')).toBe(true)
  list.resolve({ sets: [], skips: [], revision: 1, keepGoing: [], keepGoingRevision: 1 })
  await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false))
})

it('stops keep going on the host before a save starts creating cards', async () => {
  mocks.keepGoing = [
    { conversation: SOURCE, enabled: true, maxRounds: 3, roundsUsed: 1, startedAt: 20 }
  ]
  const order: string[] = []
  mocks.save.mockImplementation(async () => {
    order.push('save')
    return { refusal: 'No goal to file under.' }
  })
  const host = mocks.rpc.getMockImplementation()!
  mocks.rpc.mockImplementation(
    (target: unknown, method: string, params: Record<string, unknown>) => {
      if (method === NEXT_STEPS_RPC.keepGoing) {
        order.push(`keepGoing:${String(params.enabled)}:${String(params.reason)}`)
      }
      return host(target, method, params)
    }
  )
  renderTray()
  await screen.findByText('Keep going · round 1 of 3')
  fireEvent.click(screen.getByRole('checkbox', { name: 'Review the PR' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save for later (1)' }))
  await waitFor(() => expect(order).toContain('save'))
  expect(order[0]).toBe('keepGoing:false:person-acted')
  expect(order.indexOf('save')).toBeGreaterThan(0)
})

it('keeps the stop line when the person’s answer is refused', async () => {
  aiOnly()
  mocks.keepGoing = [
    {
      conversation: SOURCE,
      enabled: false,
      maxRounds: 3,
      roundsUsed: 1,
      startedAt: 20,
      stoppedAt: 40,
      stopReason: 'needs-you-risky'
    }
  ]
  const host = mocks.rpc.getMockImplementation()!
  mocks.rpc.mockImplementation(
    (target: unknown, method: string, params: Record<string, unknown>) =>
      method === NEXT_STEPS_RPC.decide
        ? Promise.reject(new Error('Refused.'))
        : host(target, method, params)
  )
  renderTray()
  await screen.findByText('Stopped: the next step is risky and needs you')
  fireEvent.click(await screen.findByRole('button', { name: 'Dismiss suggestions' }))
  await screen.findByText('Refused.')
  expect(screen.getByText('Stopped: the next step is risky and needs you')).toBeTruthy()
})

it('asks the host to stop before a save even when its cached state says off', async () => {
  // The reviewer's case: the host has Keep going on, this client's last read says off.
  mocks.keepGoing = []
  const order: string[] = []
  mocks.save.mockImplementation(async () => {
    order.push('save')
    return { refusal: 'No goal to file under.' }
  })
  const host = mocks.rpc.getMockImplementation()!
  mocks.rpc.mockImplementation(
    (target: unknown, method: string, params: Record<string, unknown>) => {
      if (method === NEXT_STEPS_RPC.keepGoing) {
        order.push(`keepGoing:${String(params.enabled)}:${String(params.reason)}`)
      }
      return host(target, method, params)
    }
  )
  renderTray()
  await waitFor(() => expect(usePendingNextSteps.getState().revision).not.toBeNull())
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Review the PR' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save for later (1)' }))
  await waitFor(() => expect(order).toContain('save'))
  expect(order.indexOf('keepGoing:false:person-acted')).toBeGreaterThanOrEqual(0)
  expect(order.indexOf('keepGoing:false:person-acted')).toBeLessThan(order.indexOf('save'))
})
