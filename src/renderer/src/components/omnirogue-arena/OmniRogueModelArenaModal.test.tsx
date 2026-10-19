// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { OmniRogueCreditBalance } from '../../../../shared/omnirogue-account'
import type { OmniRogueCreditsApi } from '../../../../preload/api/omnirogue-api'
import { OmniRogueModelArenaModal } from './OmniRogueModelArenaModal'
import type { OmniRogueModelArenaModalProps } from './OmniRogueModelArenaModal'
import {
  MODEL_ARENA_MAX_CONTENDERS, ModelArenaError, buildModelArenaRequest, fillModelArenaLabel,
  formatModelArenaCredits, formatModelArenaLatency, isCompleteModelArenaRound, modelArenaContenderName,
  modelArenaDisplayOrder, modelArenaErrorKey, modelArenaModelLabel, modelArenaRoundCredits,
  resolveModelArenaLabels, toggleModelArenaSelection
} from './omnirogue-model-arena-helpers'
import type {
  ModelArenaAnswer, ModelArenaModel, ModelArenaQuote, ModelArenaRequest, ModelArenaRound,
  ModelArenaVerdict, OmniRogueModelArenaService
} from './omnirogue-model-arena-helpers'

const translate = vi.hoisted(() => vi.fn((_key: string, fallback: string) => fallback))
vi.mock('@/i18n/i18n', () => ({ translate }))
const models: ModelArenaModel[] = [
  { id: 'opus', label: 'Opus', provider: 'anthropic' },
  { id: 'astra', label: 'Astra', provider: 'openai' },
  { id: 'argon', label: 'Argon', provider: 'google' },
  { id: 'haiku', label: 'Haiku', provider: 'anthropic' },
  { id: 'flash', label: 'Flash', provider: 'google' }
]
const labels = resolveModelArenaLabels()
const balance = (availableCredits = 500): OmniRogueCreditBalance => ({ availableCredits, updatedAt: '2026-10-16', lowBalanceThreshold: 100 })
const quote = (credits = 20): ModelArenaQuote => ({ id: 'quote-1', credits, expiresAt: Date.now() + 60_000 })
const request: ModelArenaRequest = { prompt: 'Explain closures', modelIds: ['opus', 'astra'] }
const answer = (modelId: string, extra: Partial<ModelArenaAnswer> = {}): ModelArenaAnswer =>
  ({ modelId, status: 'completed', output: `${modelId} answer`, latencyMs: 1200, credits: 10, ...extra })
const roundFor = (input: ModelArenaRequest, id = 'round-1'): ModelArenaRound =>
  ({ id, answers: input.modelIds.map((modelId) => answer(modelId)) })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
let service: OmniRogueModelArenaService
let creditsApi: OmniRogueCreditsApi
let balanceChanged: (value: OmniRogueCreditBalance | null) => void
let onVerdict: Mock<(verdict: ModelArenaVerdict) => void>
beforeEach(() => {
  onVerdict = vi.fn<(verdict: ModelArenaVerdict) => void>()
  creditsApi = {
    getBalance: vi.fn().mockResolvedValue(balance()),
    refreshBalance: vi.fn().mockResolvedValue(balance()), openTopUp: vi.fn(),
    onBalanceChanged: vi.fn((listener) => { balanceChanged = listener; return vi.fn() })
  }
  service = {
    quote: vi.fn(async (input: ModelArenaRequest) => quote(input.modelIds.length * 10)),
    run: vi.fn(async (input: ModelArenaRequest) => roundFor(input)),
    vote: vi.fn().mockResolvedValue(undefined)
  }
})
afterEach(() => { cleanup(); vi.clearAllMocks() })
function mount(overrides: Partial<OmniRogueModelArenaModalProps> = {}) {
  const props = { service, creditsApi, models, onVerdict, open: true, showTrigger: false, ...overrides }
  return render(<OmniRogueModelArenaModal {...props} />)
}
function pick(...names: string[]) {
  for (const name of names) {
    fireEvent.click(screen.getByRole('checkbox', { name }))
  }
}
async function ready(prompt = '  Explain closures ') {
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: prompt } })
  pick('Opus', 'Astra')
  await waitFor(() => expect(screen.getByRole('button', { name: 'Run round' })).toBeEnabled())
}
async function runRound() {
  fireEvent.click(screen.getByRole('button', { name: 'Run round' }))
  return screen.findByRole('group', { name: /^Model A/ })
}

describe('arena selection and round validation', () => {
  it('toggles selections and caps contenders without mutating input', () => {
    const selected = ['opus', 'astra', 'argon', 'haiku']
    expect(toggleModelArenaSelection(['opus'], 'astra')).toEqual(['opus', 'astra'])
    expect(toggleModelArenaSelection(selected, 'astra')).toEqual(['opus', 'argon', 'haiku'])
    expect(toggleModelArenaSelection(selected, 'flash')).toEqual(selected)
    expect(toggleModelArenaSelection(selected, 'flash')).not.toBe(selected)
    expect(MODEL_ARENA_MAX_CONTENDERS).toBe(4)
  })
  it('builds a trimmed request only for 2-4 unique known models', () => {
    expect(buildModelArenaRequest('  Explain closures ', ['opus', 'astra'], models)).toEqual(request)
    for (const selected of [['opus'], ['opus', 'opus'], ['opus', 'missing'], models.map((model) => model.id)]) {
      expect(buildModelArenaRequest('Prompt', selected, models)).toBeNull()
    }
    expect(buildModelArenaRequest('   ', ['opus', 'astra'], models)).toBeNull()
  })
  it('accepts exactly one valid answer per requested model', () => {
    expect(isCompleteModelArenaRound(roundFor(request), request)).toBe(true)
    expect(isCompleteModelArenaRound({ id: 'r', answers: [answer('opus'), answer('astra', { status: 'failed', output: '' })] }, request)).toBe(true)
    const broken: (ModelArenaRound | null)[] = [
      null,
      { ...roundFor(request), id: ' ' },
      { id: 'r', answers: [answer('opus')] },
      { id: 'r', answers: [answer('opus'), answer('opus')] },
      { id: 'r', answers: [answer('opus'), answer('argon')] },
      { id: 'r', answers: [answer('opus'), answer('astra'), answer('argon')] },
      { id: 'r', answers: [answer('opus'), answer('astra', { credits: Number.NaN })] },
      { id: 'r', answers: [answer('opus'), answer('astra', { latencyMs: -1 })] },
      { id: 'r', answers: [answer('opus'), answer('astra', { status: 'pending' as never })] }
    ]
    for (const round of broken) {
      expect(isCompleteModelArenaRound(round, request)).toBe(false)
    }
  })
  it('keeps the service order when not blind and a stable shuffled permutation when blind', () => {
    const wide: ModelArenaRequest = { prompt: 'p', modelIds: ['opus', 'astra', 'argon', 'haiku'] }
    const round = roundFor(wide)
    expect(modelArenaDisplayOrder(round, false)).toEqual(round.answers)
    const blind = modelArenaDisplayOrder(round, true)
    expect(blind).toEqual(modelArenaDisplayOrder(round, true))
    expect(blind.map((item) => item.modelId).toSorted()).toEqual([...wide.modelIds].toSorted())
    const orders = Array.from({ length: 20 }, (_, index) =>
      modelArenaDisplayOrder(roundFor(wide, `round-${index}`), true).map((item) => item.modelId).join())
    expect(orders.some((order) => order !== wide.modelIds.join())).toBe(true)
  })
  it('formats credits, latency, contender names and templates from labels', () => {
    expect(formatModelArenaCredits(1234.5, labels)).toBe('1,234.5 cr')
    expect(formatModelArenaLatency(849.6, labels)).toBe('850 ms')
    expect(formatModelArenaLatency(1234, labels)).toBe('1.2 s')
    expect(['A', 'B', 'C', 'D'].map((_, index) => modelArenaContenderName(index, labels))).toEqual(['Model A', 'Model B', 'Model C', 'Model D'])
    expect(fillModelArenaLabel('{a} and {b}', { a: 1 })).toBe('1 and {b}')
    expect(modelArenaModelLabel('astra', models)).toBe('Astra')
    expect(modelArenaModelLabel('unknown-model', models)).toBe('unknown-model')
    expect(modelArenaRoundCredits(roundFor(request))).toBe(20)
  })
  it('resolves labels through translation with prop overrides winning', () => {
    const custom = resolveModelArenaLabels({ run: 'Fight' })
    expect(custom.run).toBe('Fight')
    expect(custom.title).toBe('Model Arena')
    expect(translate).toHaveBeenCalledWith('omnirogueModelArena.title', 'Model Arena')
    expect(translate).not.toHaveBeenCalledWith('omnirogueModelArena.run', expect.anything())
    expect(modelArenaErrorKey(new ModelArenaError('expired'), 'runFailed')).toBe('expired')
    expect(modelArenaErrorKey(new Error('raw adapter text'), 'runFailed')).toBe('runFailed')
  })
})

describe('arena flow', () => {
  it('opens from the trigger and quotes only once a full request exists', async () => {
    mount({ open: undefined, showTrigger: true })
    fireEvent.click(screen.getByRole('button', { name: 'Model Arena' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Explain closures' } })
    pick('Opus')
    await act(async () => {})
    expect(service.quote).not.toHaveBeenCalled()
    pick('Astra')
    await screen.findByText('Round cost: 20 cr')
    expect(service.quote).toHaveBeenCalledExactlyOnceWith(request, { signal: expect.any(AbortSignal) })
  })
  it('runs a blind round, hides names until the vote, then reveals the winner', async () => {
    mount(); await ready()
    const group = await runRound()
    expect(service.run).toHaveBeenCalledExactlyOnceWith(request, { quoteId: 'quote-1', signal: expect.any(AbortSignal) })
    expect(screen.getByRole('group', { name: 'Model B' })).toBeInTheDocument()
    expect(within(group).queryByText(/Opus|Astra/)).toBeNull()
    expect(screen.getByText('opus answer')).toBeInTheDocument()
    expect(screen.getByText('Round charged: 20 cr')).toBeInTheDocument()
    const winner = modelArenaDisplayOrder(roundFor(request), true)[0].modelId
    fireEvent.click(within(group).getByRole('button', { name: 'Pick as winner' }))
    await waitFor(() => expect(onVerdict).toHaveBeenCalledExactlyOnceWith({ roundId: 'round-1', winnerModelId: winner, blind: true }))
    expect(service.vote).toHaveBeenCalledExactlyOnceWith({ roundId: 'round-1', winnerModelId: winner, blind: true }, { signal: expect.any(AbortSignal) })
    const revealed = screen.getByRole('group', { name: `Model A · ${modelArenaModelLabel(winner, models)}` })
    expect(within(revealed).getByText('Winner')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Pick as winner' })).toBeNull()
  })
  it('shows names immediately when blind mode is off and records ties', async () => {
    mount(); await ready()
    fireEvent.click(screen.getByRole('switch', { name: 'Blind comparison' }))
    await runRound()
    expect(screen.getByRole('group', { name: 'Model A · Opus' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Model B · Astra' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Call it a tie' }))
    expect(await screen.findByText('You called this round a tie.')).toBeInTheDocument()
    expect(onVerdict).toHaveBeenCalledWith({ roundId: 'round-1', winnerModelId: null, blind: false })
  })
  it('caps the selection at four models', () => {
    mount()
    pick('Opus', 'Astra', 'Argon', 'Haiku')
    expect(screen.getByRole('checkbox', { name: 'Flash' })).toBeDisabled()
    expect(screen.getByText('4 of 4 selected (pick at least 2)')).toBeInTheDocument()
    pick('Haiku')
    expect(screen.getByRole('checkbox', { name: 'Flash' })).toBeEnabled()
  })
  it('warns at low balance and disables on live insufficient or unknown balance', async () => {
    mount(); await ready()
    act(() => balanceChanged(balance(110)))
    expect(screen.getByText('Low credit balance after this round.')).toBeInTheDocument()
    act(() => balanceChanged(balance(19)))
    expect(screen.getByText('Insufficient credits for this round.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run round' })).toBeDisabled()
    act(() => balanceChanged(null))
    expect(screen.getByText('Connect OmniRogue or refresh your credits to continue.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run round' })).toBeDisabled()
  })
  it.each([null, balance(1)])('rechecks the balance before running (%j)', async (fresh) => {
    mount(); await ready()
    vi.mocked(creditsApi.refreshBalance).mockResolvedValue(fresh)
    fireEvent.click(screen.getByRole('button', { name: 'Run round' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('unavailable or insufficient')
    expect(service.run).not.toHaveBeenCalled()
  })
  it('rejects an incomplete round without showing results and re-quotes', async () => {
    vi.mocked(service.run).mockResolvedValueOnce({ id: 'round-1', answers: [answer('opus')] })
    mount(); await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Run round' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('incomplete round')
    expect(screen.queryByRole('group', { name: /^Model A/ })).toBeNull()
    await waitFor(() => expect(service.quote).toHaveBeenCalledTimes(2))
  })
  it('shows adapter failures as localized labels, never raw messages', async () => {
    vi.mocked(service.run).mockRejectedValueOnce(new Error('HTTP 500 stack trace'))
    mount(); await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Run round' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(labels.runFailed)
    expect(screen.queryByText(/stack trace/)).toBeNull()
  })
  it('marks failed answers and only offers votes for completed ones', async () => {
    vi.mocked(service.run).mockResolvedValueOnce({ id: 'round-1', answers: [answer('opus'), answer('astra', { status: 'failed', output: '' })] })
    mount(); await ready()
    await runRound()
    expect(screen.getByText('This model did not answer.')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Pick as winner' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Call it a tie' })).toBeNull()
  })
  it('keeps the round after a failed vote and allows a retry', async () => {
    vi.mocked(service.vote).mockRejectedValueOnce(new Error('offline'))
    mount(); await ready()
    const group = await runRound()
    fireEvent.click(within(group).getByRole('button', { name: 'Pick as winner' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save your vote')
    expect(onVerdict).not.toHaveBeenCalled()
    fireEvent.click(within(group).getByRole('button', { name: 'Pick as winner' }))
    await waitFor(() => expect(onVerdict).toHaveBeenCalledOnce())
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it('starts a new round with a fresh quote', async () => {
    mount(); await ready()
    await runRound()
    fireEvent.click(screen.getByRole('button', { name: 'New round' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run round' })).toBeEnabled())
    expect(service.quote).toHaveBeenCalledTimes(2)
    expect(screen.getByLabelText('Prompt')).toHaveValue('  Explain closures ')
  })
  it('ignores out-of-order quotes after the prompt changes', async () => {
    const old = deferred<ModelArenaQuote>()
    vi.mocked(service.quote).mockReturnValueOnce(old.promise)
    mount()
    pick('Opus', 'Astra')
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Old' } })
    await waitFor(() => expect(service.quote).toHaveBeenCalledOnce())
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'New' } })
    await screen.findByText('Round cost: 20 cr')
    await act(async () => old.resolve(quote(999)))
    expect(screen.getByText('Round cost: 20 cr')).toBeInTheDocument()
  })
  it.each([
    ['rejected', () => Promise.reject(new Error('offline'))],
    ['expired', async () => ({ ...quote(), expiresAt: Date.now() - 1 })]
  ])('reports a %s quote and keeps running disabled', async (_name, result) => {
    vi.mocked(service.quote).mockImplementation(result)
    mount(); fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Explain closures' } }); pick('Opus', 'Astra')
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the credit cost')
    expect(screen.getByRole('button', { name: 'Run round' })).toBeDisabled()
  })
  it('uses label props instead of defaults', () => {
    mount({ labels: { title: 'Arena', run: 'Fight' } })
    expect(screen.getByRole('heading', { name: 'Arena' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Fight' })).toBeInTheDocument()
  })
  it('blocks closing while running and aborts the run on unmount', async () => {
    const pending = deferred<ModelArenaRound>()
    let signal: AbortSignal | undefined
    vi.mocked(service.run).mockImplementationOnce((_input, options) => { signal = options.signal; return pending.promise })
    const onOpenChange = vi.fn()
    const view = mount({ onOpenChange }); await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Run round' }))
    await screen.findByText('Running models…')
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onOpenChange).not.toHaveBeenCalled()
    view.unmount()
    expect(signal?.aborted).toBe(true)
  })
})
