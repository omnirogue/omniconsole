/**
 * The defect this queue exists for: a chat send that starts while a chain step's
 * prompt is being pasted.
 *
 * Measured before this change, on one pane's PTY:
 *   paste(step prompt) | Ctrl+U | chat body | Enter | Enter
 * The chat path's Ctrl+U wiped the pasted step prompt and the step's own Enter
 * submitted the chat text, because the paste transaction and the native-chat queue
 * were two independent locks on the same PTY.
 *
 * The programs below are the shapes those two paths submit. That they submit
 * exactly these steps is pinned separately, against the real framing helpers, by
 * native-chat-session-input-send.test.ts and agent-paste-session-input.test.ts.
 * What this file pins is the host's side: each item lands whole.
 */

import { describe, expect, it, vi } from 'vitest'
import { buildSessionInputProgram } from '../../../shared/session-input-program'
import { SessionInputQueue } from './session-input-queue'

const PTY = 'pty-step-and-chat'
const STEP_PASTE = '\x1b[200~Continue the chain step.\x1b[201~'
const CHAT_CLEAR = '\x15'
const CHAT_BODY = 'a question the person typed'
const ENTER = '\r'

/** As built by the chain step launch: paste, its 50 ms gap, Enter. */
const stepProgram = buildSessionInputProgram({
  body: STEP_PASTE,
  submitDelayMs: 50,
  submit: ENTER
})

/** As built by a chat composer send: clear, framed body, its 500 ms gap, Enter. */
const chatProgram = buildSessionInputProgram({
  clearInput: CHAT_CLEAR,
  body: CHAT_BODY,
  submitDelayMs: 500,
  submit: ENTER
})

function createQueue(): { queue: SessionInputQueue; writes: string[] } {
  const writes: string[] = []
  const queue = new SessionInputQueue({
    write: (ptyId, data) => {
      if (ptyId === PTY) {
        writes.push(data)
      }
      return true
    }
  })
  return { queue, writes }
}

describe('a chat send during a chain step paste', () => {
  it('never lands inside the step’s paste-to-Enter window', async () => {
    vi.useFakeTimers()
    try {
      const { queue, writes } = createQueue()
      const step = queue.submit({
        ptyId: PTY,
        clientMessageId: 'chain-1',
        origin: 'chain',
        body: 'Continue the chain step.',
        program: stepProgram
      })
      // The person presses Enter in chat while the step's prompt is being delivered.
      const chat = queue.submit({
        ptyId: PTY,
        clientMessageId: 'chat-1',
        origin: 'chat',
        body: CHAT_BODY,
        program: chatProgram
      })
      await vi.advanceTimersByTimeAsync(5_000)
      await expect(step).resolves.toMatchObject({ status: 'delivered' })
      await expect(chat).resolves.toMatchObject({ status: 'delivered' })
      expect(writes).toEqual([STEP_PASTE, ENTER, CHAT_CLEAR, CHAT_BODY, ENTER])
    } finally {
      vi.useRealTimers()
    }
  })

  it('writes nothing more to a session that rebinds mid-send', async () => {
    vi.useFakeTimers()
    try {
      const { queue, writes } = createQueue()
      const step = queue.submit({
        ptyId: PTY,
        clientMessageId: 'chain-1',
        origin: 'chain',
        body: 'Continue the chain step.',
        program: stepProgram
      })
      const chat = queue.submit({
        ptyId: PTY,
        clientMessageId: 'chat-1',
        origin: 'chat',
        body: CHAT_BODY,
        program: chatProgram
      })
      await vi.advanceTimersByTimeAsync(10)
      const writtenBeforeRebind = writes.length
      expect(writtenBeforeRebind).toBeGreaterThan(0)
      queue.cancelSession(PTY, 'rebound')
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(step).resolves.toMatchObject({ status: 'cancelled', reason: 'rebound' })
      await expect(chat).resolves.toMatchObject({ status: 'cancelled', reason: 'rebound' })
      expect(writes).toHaveLength(writtenBeforeRebind)
      expect(writes).not.toContain(ENTER)
    } finally {
      vi.useRealTimers()
    }
  })
})
