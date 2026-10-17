/**
 * A prompt refused between its text and its Enter leaves that text in the agent's input box. The
 * next automated Enter must never send it along (review 4, R5-3), and a fence revoked in between
 * stops the Enter at the writer (review 4, R5-1, main's node-pty path).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  GuardedWriteOutcome,
  GuardedWriteReceiver,
  WriteFence
} from '../pty/guarded-pty-write'
import { AGENT_PROMPT_TEST_WORKTREE_PATH } from './agent-prompt-submission-runtime-test-fixture'
import { openWriteFence, revokeWriteFencesWhere } from './conversation-write-fence'
import { OrcaRuntimeService } from './omni-runtime'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'
import { clearUnresolvedDraft, UNRESOLVED_DRAFT_REASON } from './terminal-unresolved-draft'

vi.mock('../git/worktree', () => {
  const worktrees = [
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/x',
      isBare: false,
      isMainWorktree: false
    }
  ]
  return {
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
  }
})

const RECEIVER: GuardedWriteReceiver = { pid: 4242, pgid: 4242, startTimeMs: 1_000_000 }

/** A codex terminal whose owner writes guarded input; `onGuarded` decides each write. */
async function terminal(
  onGuarded: (data: string, fence: WriteFence | undefined) => GuardedWriteOutcome
) {
  const runtime = new OrcaRuntimeService(makeStore() as never)
  const writes: string[] = []
  const working = () => runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
  runtime.setPtyController({
    spawn: async () => ({ id: 'pty-prompt' }),
    write: (_ptyId, data) => {
      writes.push(data)
      if (data === '\r') {
        working()
      }
      return true
    },
    guardedWrite: async (_ptyId, data, _receiver, fence) => {
      // The node-pty owner's own synchronous fence check, as `guarded-pty-write.ts` makes it.
      if (fence?.isRevoked()) {
        return 'revoked'
      }
      const outcome = onGuarded(data, fence)
      if (outcome === 'written') {
        writes.push(data)
        if (data === '\r') {
          working()
        }
      }
      return outcome
    },
    kill: () => true,
    getForegroundProcess: async () => null
  })
  const created = await runtime.createTerminal(`path:${AGENT_PROMPT_TEST_WORKTREE_PATH}`, {
    launchAgent: 'codex'
  })
  return { runtime, handle: created.handle, writes }
}

afterEach(() => {
  clearUnresolvedDraft('pty-prompt')
  vi.useRealTimers()
})

describe('text a refused prompt left in the input box', () => {
  it('refuses every later automated Enter until the person explicitly resolves it, so nothing is concatenated', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await terminal((data) =>
      data === '\r' ? 'refused' : 'written'
    )
    const first = runtime.sendTerminalAgentPrompt(handle, 'first prompt', { receiver: RECEIVER })
    const refused = expect(first).rejects.toThrow('no longer holds its terminal')
    await vi.runAllTimersAsync()
    await refused
    const pasted = writes.length
    expect(writes.join('')).toContain('first prompt')
    expect(writes).not.toContain('\r')

    // A second prompt, guarded or not, and a raw Enter: each refused before a byte moves.
    await expect(runtime.sendTerminalAgentPrompt(handle, 'second prompt')).rejects.toThrow(
      UNRESOLVED_DRAFT_REASON
    )
    await expect(runtime.sendTerminal(handle, { enter: true })).rejects.toThrow(
      UNRESOLVED_DRAFT_REASON
    )
    await expect(runtime.sendTerminal(handle, { text: '\r' })).rejects.toThrow(
      UNRESOLVED_DRAFT_REASON
    )
    expect(writes).toHaveLength(pasted)
    expect(runtime.hasTerminalUnresolvedDraft(handle)).toBe(true)
    await expect(runtime.sendTerminal(handle, { interrupt: true })).resolves.toMatchObject({
      accepted: true
    })
    expect(runtime.hasTerminalUnresolvedDraft(handle)).toBe(true)

    // A confirmed manual submission reconciles the draft; ordinary typing does not.
    clearUnresolvedDraft('pty-prompt')
    const third = runtime.sendTerminalAgentPrompt(handle, 'third prompt')
    await vi.runAllTimersAsync()
    await expect(third).resolves.toMatchObject({ accepted: true })
    expect(writes.join('')).not.toContain('second prompt')
  })

  it('stops Enter at the writer when the conversation fence is revoked after the text (R5-1)', async () => {
    vi.useFakeTimers()
    const source = { worktreeId: 'wt', paneKey: 'tab-1:leaf-1', kind: 'pty' as const }
    const writeFence = openWriteFence(source, () => true)
    const { runtime, handle, writes } = await terminal((data) => {
      if (data !== '\r') {
        // The reply changes right after the text went in; main hears of it and revokes.
        queueMicrotask(() => revokeWriteFencesWhere(() => true))
      }
      return 'written'
    })
    const sent = runtime.sendTerminalAgentPrompt(handle, 'fenced prompt', {
      receiver: RECEIVER,
      writeFence
    })
    const refused = expect(sent).rejects.toThrow('conversation changed')
    await vi.runAllTimersAsync()
    await refused
    expect(writes.join('')).toContain('fenced prompt')
    expect(writes).not.toContain('\r')
    expect(runtime.hasTerminalUnresolvedDraft(handle)).toBe(true)
  })
  it('keeps quarantine when a transport reply was lost before the first paste acknowledgement', async () => {
    const { runtime, handle, writes } = await terminal(() => 'unknown')
    await expect(
      runtime.sendTerminalAgentPrompt(handle, 'possibly delivered', { receiver: RECEIVER })
    ).rejects.toThrow('could not be confirmed')
    expect(runtime.hasTerminalUnresolvedDraft(handle)).toBe(true)
    await expect(runtime.sendTerminal(handle, { text: '\r' })).rejects.toThrow(
      UNRESOLVED_DRAFT_REASON
    )
    expect(writes).toEqual([])
  })
})
