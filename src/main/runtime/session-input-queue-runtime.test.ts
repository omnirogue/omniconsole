import { describe, expect, it, vi } from 'vitest'
import { buildAgentPromptPasteBytes } from '../../shared/agent-prompt-injection'
import { buildSessionInputProgram } from '../../shared/session-input-program'
import { createAgentPromptSubmissionRuntime } from './agent-prompt-submission-runtime-test-fixture'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/session-input-queue',
      isBare: false,
      isMainWorktree: false
    }
  ]),
  listWorktreesStrict: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/session-input-queue',
      isBare: false,
      isMainWorktree: false
    }
  ])
}))

describe('session input queue in the runtime', () => {
  it('writes no further byte to a session that rebinds during the pre-Enter wait', async () => {
    vi.useFakeTimers()
    try {
      const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => undefined)
      const submission = runtime.sendTerminalAgentPrompt(handle, 'review this')
      const stale = expect(submission).rejects.toThrow('terminal_handle_stale')
      // Let the paste land, then take the session away before Enter is due.
      await vi.advanceTimersByTimeAsync(5)
      expect(writes.some((data) => data.includes('review this'))).toBe(true)
      const writesBeforeRebind = writes.length

      runtime.synchronizePtyOutputSequenceFromProvider(
        'pty-prompt',
        { value: 0, generation: 'reset' },
        0
      )
      await vi.advanceTimersByTimeAsync(60_000)
      await stale
      expect(writes).toHaveLength(writesBeforeRebind)
      expect(writes.some((data) => data === '\r')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('delivers one prompt when the same clientMessageId is sent twice', async () => {
    vi.useFakeTimers()
    try {
      const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
        (runtime, data) => {
          if (data === '\r') {
            runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
          }
        }
      )
      const first = runtime.sendTerminalAgentPrompt(handle, 'dispatch this', {
        clientMessageId: 'dispatch-7'
      })
      await vi.runAllTimersAsync()
      const firstResult = await first
      expect(firstResult.accepted).toBe(true)
      expect(firstResult.bytesWritten).toBeGreaterThan(0)
      const writesAfterFirst = writes.length
      expect(writes.filter((data) => data.includes('dispatch this'))).toHaveLength(1)

      const repeat = runtime.sendTerminalAgentPrompt(handle, 'dispatch this', {
        clientMessageId: 'dispatch-7'
      })
      await vi.runAllTimersAsync()
      // Reported as accepted with nothing written: the first delivery stands.
      await expect(repeat).resolves.toMatchObject({ accepted: true, bytesWritten: 0 })
      expect(writes).toHaveLength(writesAfterFirst)
    } finally {
      vi.useRealTimers()
    }
  })

  it('serializes a submitted item behind a worker prompt on the same session', async () => {
    vi.useFakeTimers()
    try {
      const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
        (runtime, data) => {
          if (data === '\r') {
            runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
          }
        }
      )
      const worker = runtime.sendTerminalAgentPrompt(handle, 'worker prompt')
      const chat = runtime.submitSessionInput({
        ptyId: 'pty-prompt',
        clientMessageId: 'chat-1',
        origin: 'chat',
        body: 'chat text',
        program: buildSessionInputProgram({
          clearInput: '\x15',
          body: buildAgentPromptPasteBytes('chat text'),
          submitDelayMs: 500,
          submit: '\r'
        })
      })
      await vi.runAllTimersAsync()
      await expect(worker).resolves.toMatchObject({ accepted: true })
      await expect(chat).resolves.toMatchObject({ status: 'delivered' })

      // Whichever item takes the turn first, neither one's bytes may appear
      // inside the other's: the chat clear cannot wipe a pasted worker prompt,
      // and neither Enter can submit the other's text.
      const workerPasteIndex = writes.findIndex((data) => data.includes('worker prompt'))
      expect(workerPasteIndex).toBeGreaterThanOrEqual(0)
      expect(writes[workerPasteIndex + 1]).toBe('\r')

      const clearIndex = writes.indexOf('\x15')
      expect(clearIndex).toBeGreaterThanOrEqual(0)
      expect(writes[clearIndex + 1]).toContain('chat text')
      expect(writes[clearIndex + 2]).toBe('\r')
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a submitted item when the session rebinds before its turn', async () => {
    vi.useFakeTimers()
    try {
      const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => undefined)
      const worker = runtime.sendTerminalAgentPrompt(handle, 'worker prompt')
      const stale = expect(worker).rejects.toThrow('terminal_handle_stale')
      // Why the tick: the prompt path measures its payload before taking the
      // session's turn, so the item below has to queue behind a holder.
      await vi.advanceTimersByTimeAsync(1)
      const queued = runtime.submitSessionInput({
        ptyId: 'pty-prompt',
        clientMessageId: 'chat-2',
        origin: 'chat',
        body: 'never sent',
        program: buildSessionInputProgram({
          clearInput: '\x15',
          body: buildAgentPromptPasteBytes('never sent'),
          submitDelayMs: 500,
          submit: '\r'
        })
      })
      await vi.advanceTimersByTimeAsync(5)
      runtime.synchronizePtyOutputSequenceFromProvider(
        'pty-prompt',
        { value: 0, generation: 'reset' },
        0
      )
      await vi.advanceTimersByTimeAsync(60_000)
      await stale
      await expect(queued).resolves.toMatchObject({ status: 'cancelled', reason: 'rebound' })
      expect(writes.some((data) => data.includes('never sent'))).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
