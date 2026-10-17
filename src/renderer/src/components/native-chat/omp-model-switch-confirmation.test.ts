// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNativeChatModelSwitchConfirmationObserver } from './native-chat-model-switch-confirmation'

const model = 'openrouter/google/gemini-2.5-flash'

function observe() {
  let data = (_chunk: string): void => {}
  const unsubscribe = vi.fn()
  const submitConfirmation = vi.fn()
  const observer = createNativeChatModelSwitchConfirmationObserver({
    ptyId: 'owned-omp',
    settings: {},
    expectedModelLabel: null,
    expectedOmpModelId: model,
    subscribeToData: (watcher) => {
      data = watcher
      return unsubscribe
    },
    submitConfirmation,
    timeoutMs: 100
  })
  return { observer, data: (chunk: string) => data(chunk), unsubscribe, submitConfirmation }
}

afterEach(() => vi.useRealTimers())

describe('OMP native model confirmation', () => {
  it('waits for the exact live provider/model acknowledgement across chunks', async () => {
    const r = observe()
    await r.observer.ready
    r.data(`Session-only model: ${model}.`)
    r.observer.arm()
    r.data(`/switch ${model}\r\n`)
    r.data('Session-only\u001b[20Gmodel: openrouter/google/gemini-')
    r.data('2.5-flash. Use alt+m or /model for roles.')
    await expect(r.observer.result).resolves.toBe('applied')
    expect(r.unsubscribe).toHaveBeenCalledOnce()
    expect(r.submitConfirmation).not.toHaveBeenCalled()
  })

  it.each([
    `/switch ${model}`,
    'Session-only model: openrouter/google/gemini-2.5-flash-lite.',
    'Session-only model: google/gemini-2.5-flash.',
    'Switch model? This conversation is cached for the current model.'
  ])('does not confirm or replay unproven output: %s', async (output) => {
    vi.useFakeTimers()
    const r = observe()
    await r.observer.ready
    r.observer.arm()
    r.observer.startDetection()
    r.data(output)
    await vi.advanceTimersByTimeAsync(100)
    await expect(r.observer.result).resolves.toBe('unknown')
    expect(r.submitConfirmation).not.toHaveBeenCalled()
  })

  it('surfaces native rejection without submitting another command', async () => {
    const r = observe()
    await r.observer.ready
    r.observer.arm()
    r.data(`Unknown model: ${model}`)
    await expect(r.observer.result).resolves.toBe('rejected')
    expect(r.submitConfirmation).not.toHaveBeenCalled()
  })
})
