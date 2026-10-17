import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sendRuntimePtyInput = vi.fn(() => true)
const sendRuntimePtyInputVerified = vi.fn(async () => true)
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  sendRuntimePtyInput: (...args: unknown[]) => sendRuntimePtyInput(...(args as [])),
  sendRuntimePtyInputVerified: (...args: unknown[]) => sendRuntimePtyInputVerified(...(args as []))
}))

import { AGENT_TUI_CLEAR_INPUT_MAX } from '../../../../shared/agent-tui-input-clear'
import { NATIVE_CHAT_SUBMIT_DELAY_MS } from '../../../../shared/native-chat-answer-stepping'
import type {
  SessionInputReceipt,
  SessionInputSubmission
} from '../../../../shared/session-input-program'
import { buildNativeChatPasteBytes } from './native-chat-send'
import {
  NATIVE_CHAT_CLEAR_CONFIRM_MS,
  NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT,
  resetNativeChatPtySendQueuesForTests,
  sendNativeChatMessage
} from './native-chat-runtime-send'

type WindowWithApi = {
  api?: {
    pty?: {
      submitSessionInput?: (submission: SessionInputSubmission) => Promise<SessionInputReceipt>
      cancelSessionInput?: (ptyId: string, filter?: unknown) => Promise<boolean>
    }
  }
}

const submitted: SessionInputSubmission[] = []
const cancelled: { ptyId: string; filter?: unknown }[] = []
let nextReceipt: (submission: SessionInputSubmission) => SessionInputReceipt

function installHostQueue(): void {
  ;(globalThis as { window?: WindowWithApi }).window = {
    api: {
      pty: {
        submitSessionInput: async (submission) => {
          submitted.push(submission)
          return nextReceipt(submission)
        },
        cancelSessionInput: async (ptyId, filter) => {
          cancelled.push({ ptyId, filter })
          return true
        }
      }
    }
  }
}

describe('chat sends through the host session input queue', () => {
  beforeEach(() => {
    submitted.length = 0
    cancelled.length = 0
    sendRuntimePtyInput.mockClear()
    nextReceipt = (submission) => ({
      clientMessageId: submission.clientMessageId,
      status: 'delivered'
    })
    installHostQueue()
  })
  afterEach(() => {
    resetNativeChatPtySendQueuesForTests()
    delete (globalThis as { window?: WindowWithApi }).window
  })

  it('hands the clear, body and Enter over as ONE item and writes no bytes itself', async () => {
    const handle = sendNativeChatMessage(null, 'pty-1', 'ship it')
    await handle.settled
    expect(submitted).toHaveLength(1)
    const item = submitted[0]!
    expect(item).toMatchObject({ ptyId: 'pty-1', origin: 'chat', body: 'ship it' })
    expect(item.program.steps).toEqual([
      { kind: 'write', data: NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT },
      { kind: 'write', data: buildNativeChatPasteBytes('ship it') },
      { kind: 'pause', ms: NATIVE_CHAT_SUBMIT_DELAY_MS },
      { kind: 'write', data: '\r' }
    ])
    expect(sendRuntimePtyInput).not.toHaveBeenCalled()
    expect(handle.wasSubmitted?.()).toBe(true)
  })

  it('submits a large OMP paste and Enter in one host write without opening the paste menu', async () => {
    const text = Array.from(
      { length: 150 },
      (_, index) => `Evidence ${index}: ${'x'.repeat(120)}`
    ).join('\n')
    const handle = sendNativeChatMessage(null, 'pty-1', text, { agent: 'omp' })

    await handle.settled

    expect(submitted).toHaveLength(1)
    expect(submitted[0]).toMatchObject({ ptyId: 'pty-1', origin: 'chat', body: text })
    expect(submitted[0]!.program.steps).toEqual([
      { kind: 'write', data: NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT },
      { kind: 'pause', ms: NATIVE_CHAT_SUBMIT_DELAY_MS },
      { kind: 'write', data: `${buildNativeChatPasteBytes(text)}\r` }
    ])
    expect(handle.wasSubmitted?.()).toBe(true)
    expect(sendRuntimePtyInput).not.toHaveBeenCalled()
  })

  it('delivers once when Enter is pressed twice inside the submit window', async () => {
    const seen = new Set<string>()
    nextReceipt = (submission) => {
      // Mirrors the host: identical body from one origin inside the window is
      // refused rather than delivered a second time.
      if (seen.has(submission.body)) {
        return {
          clientMessageId: submission.clientMessageId,
          status: 'duplicate-rejected',
          errorCode: 'session_input_duplicate_body'
        }
      }
      seen.add(submission.body)
      return { clientMessageId: submission.clientMessageId, status: 'delivered' }
    }
    const first = sendNativeChatMessage(null, 'pty-1', 'ship it')
    const second = sendNativeChatMessage(null, 'pty-1', 'ship it')
    await Promise.all([first.settled, second.settled])
    expect(submitted).toHaveLength(2)
    expect(submitted[0]!.clientMessageId).not.toBe(submitted[1]!.clientMessageId)
    expect(first.wasSubmitted?.()).toBe(true)
    // The repeat reports "not submitted by me": the text is already on its way.
    expect(second.wasSubmitted?.()).toBe(false)
    expect(sendRuntimePtyInput).not.toHaveBeenCalled()
  })

  it('lets a deliberate repeat through with the force flag', async () => {
    sendNativeChatMessage(null, 'pty-1', 'ship it')
    const forced = sendNativeChatMessage(null, 'pty-1', 'ship it', { force: true })
    await forced.settled
    expect(submitted.map((item) => item.force)).toEqual([undefined, true])
  })

  it('cancels an in-flight item by client message id, leaving other items alone', async () => {
    // Hold the receipt so the pane can rebind while the item is still in flight.
    let release!: (receipt: SessionInputReceipt) => void
    ;(globalThis as { window?: WindowWithApi }).window = {
      api: {
        pty: {
          submitSessionInput: (submission) => {
            submitted.push(submission)
            return new Promise<SessionInputReceipt>((resolve) => {
              release = resolve
            })
          },
          cancelSessionInput: async (ptyId, filter) => {
            cancelled.push({ ptyId, filter })
            return true
          }
        }
      }
    }
    const handle = sendNativeChatMessage(null, 'pty-1', 'ship it')
    await vi.waitFor(() => expect(submitted).toHaveLength(1))
    handle.cancel()
    expect(cancelled).toEqual([
      { ptyId: 'pty-1', filter: { clientMessageId: submitted[0]!.clientMessageId } }
    ])
    release({ clientMessageId: submitted[0]!.clientMessageId, status: 'cancelled' })
    expect(handle.wasSubmitted?.()).toBe(false)
  })

  it('turns an observed clear into a clear-confirm step that widens', async () => {
    const handle = sendNativeChatMessage(null, 'pty-1', 'ship it', {
      clearInput: '\x15\x15\x15',
      confirmCleared: () => false
    })
    await handle.settled
    expect(submitted[0]!.program.steps.slice(0, 2)).toEqual([
      { kind: 'write', data: '\x15\x15\x15' },
      {
        kind: 'clear-confirm',
        afterMs: NATIVE_CHAT_CLEAR_CONFIRM_MS,
        widenTo: AGENT_TUI_CLEAR_INPUT_MAX
      }
    ])
  })

  it('writes the bytes itself for a PTY this client does not own', async () => {
    const handle = sendNativeChatMessage(null, 'remote:pty-9', 'ship it')
    await vi.waitFor(() => expect(sendRuntimePtyInput).toHaveBeenCalled())
    expect(submitted).toHaveLength(0)
    handle.cancel()
  })
})
