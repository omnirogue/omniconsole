import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { waitForAgentStartupReview } from './agent-startup-review'
import { hasOptionalAutomationReview } from '../../../shared/agent-setup-review'

const review =
  '\x1b[1mHooks\x1b[0m\n1 hook needs \x1b[33mreview\x1b[0m before it can run.\nesc to close'
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { setTimeout: globalThis.setTimeout })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('recognizes styled review screens without mistaking ordinary work for setup', () => {
  expect(hasOptionalAutomationReview(review)).toBe(true)
  expect(hasOptionalAutomationReview(review.replace('esc to close', 'esc to go back'))).toBe(true)
  expect(hasOptionalAutomationReview('Review Hooks in the application')).toBe(false)
})

it('holds delivery through review and an unreadable repaint until the composer returns', async () => {
  let screen: string | null = review
  const readScreen = vi.fn(async () => screen)
  const finished = vi.fn()
  const pending = waitForAgentStartupReview({ ptyId: 'p', agent: 'codex', readScreen }).then(
    finished
  )
  await vi.advanceTimersByTimeAsync(1000)
  expect(finished).not.toHaveBeenCalled()
  screen = null
  await vi.advanceTimersByTimeAsync(500)
  expect(finished).not.toHaveBeenCalled()
  screen = ''
  await vi.advanceTimersByTimeAsync(500)
  expect(finished).not.toHaveBeenCalled()
  screen = '› Ask Codex to do anything'
  await vi.advanceTimersByTimeAsync(250)
  await pending
  expect(finished).toHaveBeenCalledWith(true)
})

it('keeps waiting while a startup screen is open instead of pasting into it', async () => {
  const finished = vi.fn()
  const onIntervention = vi.fn()
  const pending = waitForAgentStartupReview({
    ptyId: 'p',
    agent: 'codex',
    timeoutMs: 500,
    readScreen: async () => review,
    onIntervention
  }).then(finished)
  await vi.advanceTimersByTimeAsync(5_000)
  expect(finished).not.toHaveBeenCalled()
  expect(onIntervention).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'automation-review' })
  )
  await vi.advanceTimersByTimeAsync(31 * 60_000)
  await pending
  expect(finished).toHaveBeenCalledWith(false)
  expect(onIntervention).toHaveBeenLastCalledWith(null)
})

it('holds the Codex update menu and delivers once it is answered', async () => {
  let screen =
    '› Ask Codex to do anything\n✨ Update available!\n0.153.0 -> 0.154.0\n› 1. Update now\n2. Skip\nPress enter to continue'
  const finished = vi.fn()
  const onIntervention = vi.fn()
  const pending = waitForAgentStartupReview({
    ptyId: 'p',
    agent: 'codex',
    timeoutMs: 500,
    readScreen: async () => screen,
    onIntervention
  }).then(finished)
  await vi.advanceTimersByTimeAsync(2_000)
  expect(finished).not.toHaveBeenCalled()
  expect(onIntervention).toHaveBeenCalledWith(expect.objectContaining({ kind: 'update-available' }))
  screen = '› Ask Codex to do anything'
  await vi.advanceTimersByTimeAsync(300)
  await pending
  expect(finished).toHaveBeenCalledWith(true)
})

it('still times out on an unexplained blank composer', async () => {
  const pending = waitForAgentStartupReview({
    ptyId: 'p',
    agent: 'codex',
    timeoutMs: 500,
    readScreen: async () => ''
  })
  await vi.advanceTimersByTimeAsync(1_000)
  await expect(pending).resolves.toBe(false)
})

it('holds a Claude folder-trust prompt and releases when the composer returns', async () => {
  let screen = 'Quick safety check: Is this a project you created or one you trust?\n❯ No, exit'
  const finished = vi.fn()
  const pending = waitForAgentStartupReview({
    ptyId: 'p',
    agent: 'claude',
    timeoutMs: 500,
    readScreen: async () => screen
  }).then(finished)
  await vi.advanceTimersByTimeAsync(2_000)
  expect(finished).not.toHaveBeenCalled()
  screen = '> Try "fix the failing test"'
  await vi.advanceTimersByTimeAsync(300)
  await pending
  expect(finished).toHaveBeenCalledWith(true)
})

it('waits through a missing initial snapshot and a nested hook review', async () => {
  let screen: string | null = null
  const finished = vi.fn()
  const pending = waitForAgentStartupReview({
    ptyId: 'p',
    agent: 'codex',
    readScreen: async () => screen
  }).then(finished)
  await vi.advanceTimersByTimeAsync(500)
  expect(finished).not.toHaveBeenCalled()
  screen = review.replace('Hooks', 'SessionEnd hooks').replace('esc to close', 'esc to go back')
  await vi.advanceTimersByTimeAsync(500)
  expect(finished).not.toHaveBeenCalled()
  screen = '› Ask Codex to do anything'
  await vi.advanceTimersByTimeAsync(250)
  await pending
  expect(finished).toHaveBeenCalledWith(true)
})

it('rechecks input authority while setup is pending', async () => {
  const beforeWrite = vi.fn()
  const pending = waitForAgentStartupReview({
    ptyId: 'p',
    agent: 'codex',
    readScreen: async () => review,
    beforeWrite
  })
  const assertion = expect(pending).rejects.toThrow('ownership changed')
  await vi.advanceTimersByTimeAsync(250)
  beforeWrite.mockImplementation(() => {
    throw new Error('ownership changed')
  })
  await vi.advanceTimersByTimeAsync(250)
  await assertion
})

it('does not poll setup for other agents', async () => {
  const readScreen = vi.fn()
  await expect(waitForAgentStartupReview({ ptyId: 'p', agent: 'grok', readScreen })).resolves.toBe(
    true
  )
  expect(readScreen).not.toHaveBeenCalled()
})
