// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  cancel: vi.fn(() => Promise.resolve(true)),
  answer: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { message: mocks.toast } }))
vi.mock('@/runtime/runtime-session-input', () => ({
  cancelRuntimeSessionInputVerified: mocks.cancel
}))

import { sendProvenAgentQuestionAnswer } from './native-chat-proven-answer-send'

const INPUT = { ptyId: 'pty-1', paneKey: 'tab-1:leaf-1', text: '> Which color?\n\nRed' }

describe('an async answer from the pane card or Needs you', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { pty: { answerAgentQuestion: mocks.answer } }
    })
  })

  it('is handed to the host, which proves the agent before writing', async () => {
    mocks.answer.mockResolvedValue({ status: 'delivered' })
    const handle = sendProvenAgentQuestionAnswer(INPUT)
    await handle.settled
    expect(mocks.answer).toHaveBeenCalledWith(expect.objectContaining(INPUT))
    expect(handle.wasSubmitted?.()).toBe(true)
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('says why when the host refuses, and stays retryable', async () => {
    mocks.answer.mockResolvedValue({ status: 'not-sent', reason: 'Codex is no longer running.' })
    const handle = sendProvenAgentQuestionAnswer(INPUT)
    await handle.settled
    expect(handle.wasSubmitted?.()).toBe(false)
    expect(mocks.toast).toHaveBeenCalledWith('Codex is no longer running.')
  })

  it('never offers an answer again that may have landed', async () => {
    mocks.answer.mockResolvedValue({ status: 'unconfirmed', reason: 'Enter was not confirmed.' })
    const handle = sendProvenAgentQuestionAnswer(INPUT)
    await handle.settled
    expect(handle.wasSubmitted?.()).toBe(true)
  })

  it('sends nothing where no proof can be asked for: a remote runtime, a client without the door', async () => {
    const remote = sendProvenAgentQuestionAnswer({
      ...INPUT,
      ptyId: toRemoteRuntimePtyId('term_1', 'env-1')
    })
    await remote.settled
    expect(remote.wasSubmitted?.()).toBe(false)
    Object.defineProperty(window, 'api', { configurable: true, value: { pty: {} } })
    const legacy = sendProvenAgentQuestionAnswer(INPUT)
    await legacy.settled
    expect(legacy.wasSubmitted?.()).toBe(false)
    expect(mocks.answer).not.toHaveBeenCalled()
    expect(mocks.toast).toHaveBeenCalledTimes(2)
  })
})
