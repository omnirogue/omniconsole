import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_PROMPT_BRACKETED_PASTE_END,
  AGENT_PROMPT_BRACKETED_PASTE_START,
  buildAgentPromptPasteBytes
} from '../../shared/agent-prompt-injection'
import { createAgentPromptSubmissionRuntime } from './agent-prompt-submission-runtime-test-fixture'

vi.mock('../git/worktree', () => {
  const worktrees = [{ path: '/tmp/worktree-a', head: 'abc', branch: 'feature/omp-paste' }]
  return {
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
  }
})

const prompt = Array.from({ length: 150 }, (_, i) => `${i}: ${'context '.repeat(25)}`).join('\n')

describe('OMP automated prompt delivery', () => {
  afterEach(() => vi.useRealTimers())

  it('submits a chunked large paste without selecting the native paste menu', async () => {
    vi.useFakeTimers()
    let buffered = ''
    let menuOpened = false
    const received: string[] = []
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      (runtime, data) => {
        buffered += data
        const end = buffered.indexOf(AGENT_PROMPT_BRACKETED_PASTE_END)
        if (end === -1) {
          return
        }
        const text = buffered.slice(AGENT_PROMPT_BRACKETED_PASTE_START.length, end)
        const remaining = buffered.slice(end + AGENT_PROMPT_BRACKETED_PASTE_END.length)
        // OMP 18.2 opens its selector for >=100 lines unless submit shares the paste event.
        if (text.split('\n').length >= 100 && remaining !== '\r') {
          menuOpened = true
          return
        }
        if (!menuOpened && remaining === '\r') {
          received.push(text)
          runtime.onPtyData(
            'pty-prompt',
            '\x1b]9999;{"state":"working","agentType":"omp"}\x07',
            Date.now()
          )
        }
      },
      'omp'
    )

    const submission = runtime.sendTerminalAgentPrompt(handle, prompt, {
      clientMessageId: 'owned-omp-dispatch'
    })
    await vi.runAllTimersAsync()
    await expect(submission).resolves.toMatchObject({
      accepted: true,
      bytesWritten: Buffer.byteLength(buildAgentPromptPasteBytes(prompt), 'utf8') + 1
    })
    expect(menuOpened).toBe(false)
    expect(received).toEqual([prompt])
    expect(writes.length).toBeGreaterThan(2)
    const deliveredWrites = [...writes]
    await expect(
      runtime.sendTerminalAgentPrompt(handle, prompt, { clientMessageId: 'owned-omp-dispatch' })
    ).resolves.toMatchObject({ accepted: true, bytesWritten: 0 })
    expect(writes).toEqual(deliveredWrites)
  })

  it('closes a cancelled paste without submitting it', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      () => undefined,
      'omp'
    )
    const submission = runtime.sendTerminalAgentPrompt(handle, 'owned prompt', {
      signal: controller.signal
    })
    const rejected = expect(submission).rejects.toThrow('request_aborted')
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await vi.runAllTimersAsync()
    await rejected
    expect(writes.join('')).toBe(buildAgentPromptPasteBytes('owned prompt'))
    expect(writes.some((data) => data.includes('\r'))).toBe(false)
  })

  it('does not use the submit burst to answer a newly shown permission prompt', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      (runtime, data) => {
        if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_START)) {
          runtime.onPtyData(
            'pty-prompt',
            '\x1b]9999;{"state":"waiting","agentType":"omp"}\x07',
            Date.now()
          )
        }
      },
      'omp'
    )
    const rejected = expect(
      runtime.sendTerminalAgentPrompt(handle, 'owned prompt')
    ).rejects.toThrow('agent_prompt_blocked')
    await vi.runAllTimersAsync()
    await rejected
    expect(writes.join('')).toBe(buildAgentPromptPasteBytes('owned prompt'))
  })

  it('still requires an observed turn and never retries a swallowed submit', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      () => undefined,
      'omp'
    )
    const rejected = expect(
      runtime.sendTerminalAgentPrompt(handle, 'owned prompt')
    ).rejects.toThrow('agent_prompt_stalled')
    await vi.runAllTimersAsync()
    await rejected
    expect(writes.join('')).toBe(`${buildAgentPromptPasteBytes('owned prompt')}\r`)
    expect(writes.filter((data) => data.includes('\r'))).toHaveLength(1)
  })

  it('sends no closing marker or Enter to a replacement process during the wait', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      () => undefined,
      'omp'
    )
    const submission = runtime.sendTerminalAgentPrompt(handle, 'owned prompt')
    const rejected = expect(submission).rejects.toThrow('terminal_handle_stale')
    await vi.advanceTimersByTimeAsync(0)
    runtime.synchronizePtyOutputSequenceFromProvider(
      'pty-prompt',
      { value: 0, generation: 'reset' },
      0
    )
    await vi.runAllTimersAsync()
    await rejected
    expect(writes.join('')).toBe(`${AGENT_PROMPT_BRACKETED_PASTE_START}owned prompt`)
  })
})
