// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { forgetFiledNextStepCards, saveNextStepsForLater } from './next-steps-save-for-later'

const mocks = vi.hoisted(() => ({
  filing: vi.fn(),
  createTask: vi.fn(),
  createNextStepCard: vi.fn(),
  linkSessionToTask: vi.fn(),
  place: vi.fn()
}))
vi.mock('../next-step/next-step-card-filing', () => ({
  resolveNextStepCardFiling: mocks.filing
}))
vi.mock('../next-step/next-step-task-create', () => ({
  signedInEmployeeId: async () => 'emp_sal',
  createNextStepCard: mocks.createNextStepCard
}))
vi.mock('@/store/session-task-store', () => ({ linkSessionToTask: mocks.linkSessionToTask }))
vi.mock('@/store/session-place-store', () => ({ readSessionPlaceChoice: mocks.place }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    fallback.replace(/{{(\w+)}}/g, (_match, name: string) => String(options?.[name] ?? ''))
}))

const conversation = { worktreeId: 'wt', paneKey: 'tab-1:leaf-1', kind: 'pty' as const }
const step = (id: string, title: string, why?: string) => ({
  id,
  title,
  prompt: `Please ${title.toLowerCase()}.`,
  ...(why ? { why } : {}),
  risk: 'safe' as const,
  kind: 'continue' as const
})

beforeEach(() => {
  forgetFiledNextStepCards()
  Object.assign(window, { api: { backoffice: { createTask: mocks.createTask } } })
  mocks.place.mockReturnValue(null)
})
afterEach(() => vi.clearAllMocks())

it('creates one filed Proposed card per step and binds the session to none of them', async () => {
  mocks.filing.mockResolvedValue({ filing: { companyId: 'c1', unitId: 'u1', goalId: 'g1' } })
  mocks.createTask
    .mockResolvedValueOnce({ ok: true, taskId: 'btk_1', title: 'Review the PR' })
    .mockResolvedValueOnce({ ok: false, message: 'Hub is down.' })
  const result = await saveNextStepsForLater({
    conversation,
    sessionLabel: 'Parser work',
    setId: 'set-1',
    suggestions: [step('s1', 'Review the PR', 'It touches auth.'), step('s2', 'Update the docs')]
  })
  expect(mocks.filing).toHaveBeenCalledWith('wt', undefined, null)
  expect(mocks.place).toHaveBeenCalledWith('tab-1:leaf-1')
  expect(mocks.createTask).toHaveBeenNthCalledWith(1, {
    title: 'Review the PR',
    description:
      'Please review the pr.\n\nIt touches auth.\n\nSuggested in the OmniConsole session “Parser work”.',
    companyId: 'c1',
    unitId: 'u1',
    goalId: 'g1',
    ownerEmployeeId: 'emp_sal',
    proposed: true
  })
  expect(result).toEqual({
    cards: [
      { suggestionId: 's1', title: 'Review the PR', ok: true, taskId: 'btk_1' },
      { suggestionId: 's2', title: 'Update the docs', ok: false, message: 'Hub is down.' }
    ]
  })
  expect(mocks.linkSessionToTask).not.toHaveBeenCalled()
  expect(mocks.createNextStepCard).not.toHaveBeenCalled()
})

it('creates nothing when the filing is refused', async () => {
  mocks.filing.mockResolvedValue({
    refusal: { reason: 'Engineering has no active goal.', actionUrl: 'x' }
  })
  const result = await saveNextStepsForLater({
    conversation,
    sessionLabel: 'Parser work',
    setId: 'set-1',
    suggestions: [step('s1', 'Review the PR')]
  })
  expect(result).toEqual({ refusal: 'Engineering has no active goal.' })
  expect(mocks.createTask).not.toHaveBeenCalled()
})

it('never files a card twice: a retry skips the steps already filed for that set', async () => {
  mocks.filing.mockResolvedValue({ filing: { companyId: 'c1', unitId: 'u1', goalId: 'g1' } })
  mocks.createTask
    .mockResolvedValueOnce({ ok: true, taskId: 'btk_1', title: 'Review the PR' })
    .mockResolvedValueOnce({ ok: false, message: 'Hub is down.' })
    .mockResolvedValueOnce({ ok: true, taskId: 'btk_2', title: 'Update the docs' })
  const input = {
    conversation,
    sessionLabel: 'Parser work',
    setId: 'set-1',
    suggestions: [step('s1', 'Review the PR'), step('s2', 'Update the docs')]
  }
  await saveNextStepsForLater(input)
  const retry = await saveNextStepsForLater(input)
  expect(mocks.createTask).toHaveBeenCalledTimes(3)
  expect(mocks.createTask.mock.calls[2]![0]).toMatchObject({ title: 'Update the docs' })
  expect(retry).toEqual({
    cards: [
      { suggestionId: 's1', title: 'Review the PR', ok: true, taskId: 'btk_1', alreadyFiled: true },
      { suggestionId: 's2', title: 'Update the docs', ok: true, taskId: 'btk_2' }
    ]
  })
  // Everything filed: a third save only re-records, touching neither filing nor the hub.
  mocks.filing.mockClear()
  await saveNextStepsForLater(input)
  expect(mocks.filing).not.toHaveBeenCalled()
  expect(mocks.createTask).toHaveBeenCalledTimes(3)
})

it('files one card when two saves overlap', async () => {
  mocks.filing.mockResolvedValue({ filing: { companyId: 'c1', unitId: 'u1', goalId: 'g1' } })
  mocks.createTask.mockResolvedValue({ ok: true, taskId: 'btk_1', title: 'Review the PR' })
  const input = {
    conversation,
    sessionLabel: 'Parser work',
    setId: 'set-1',
    suggestions: [step('s1', 'Review the PR')]
  }
  const [first, second] = await Promise.all([
    saveNextStepsForLater(input),
    saveNextStepsForLater(input)
  ])
  expect(mocks.createTask).toHaveBeenCalledTimes(1)
  expect(first).toEqual({
    cards: [{ suggestionId: 's1', title: 'Review the PR', ok: true, taskId: 'btk_1' }]
  })
  expect(second).toEqual({
    cards: [
      {
        suggestionId: 's1',
        title: 'Review the PR',
        ok: false,
        message: 'It is already being saved.'
      }
    ]
  })
})

it('files one card when the same step is saved from the fallback set and then the real turn', async () => {
  mocks.filing.mockResolvedValue({ filing: { companyId: 'c1', unitId: 'u1', goalId: 'g1' } })
  mocks.createTask.mockResolvedValue({ ok: true, taskId: 'btk_1', title: 'Review the PR' })
  const base = {
    conversation,
    sessionLabel: 'Parser work',
    suggestions: [step('s1', 'Review the PR')]
  }
  await saveNextStepsForLater({ ...base, setId: 'fallback-set' })
  const again = await saveNextStepsForLater({
    ...base,
    setId: 'real-turn-set',
    suggestions: [step('s3', 'Review the PR')]
  })
  expect(mocks.createTask).toHaveBeenCalledTimes(1)
  expect(again).toEqual({
    cards: [
      { suggestionId: 's3', title: 'Review the PR', ok: true, taskId: 'btk_1', alreadyFiled: true }
    ]
  })
})
