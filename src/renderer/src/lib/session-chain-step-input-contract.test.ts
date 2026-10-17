// Compat gate for the bytes a chain step puts on its pane's PTY: one prompt per
// step, no interleaving, nothing to a rebound PTY.
//
// The delivery path HAS now changed — each path hands its whole sequence to the
// host's per-session input queue — so these cases run with that entry point
// installed, which is what production has. The two authority-bound cases and the
// remote-runtime case below still exercise the documented direct-write fallback.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  SessionInputReceipt,
  SessionInputSubmission
} from '../../../shared/session-input-program'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import {
  pasteDraftToAgentPtyWhenReady,
  POST_PASTE_SUBMIT_DELAY_MS,
  submitPromptToAgentPty
} from './agent-paste-draft'
import {
  NATIVE_CHAT_SUBMIT_DELAY_MS,
  resetNativeChatPtySendQueuesForTests,
  sendNativeChatMessage
} from '@/components/native-chat/native-chat-runtime-send'

const testState = vi.hoisted(() => ({
  writes: [] as { ptyId: string; data: string }[],
  waitForReady: vi.fn(),
  sendInput: vi.fn(),
  inspectProcess: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ settings: {}, tabsByWorktree: {} }) }
}))

vi.mock('./agent-draft-readiness', () => ({
  waitForAgentDraftInputReady: testState.waitForReady
}))

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  inspectRuntimeTerminalProcess: testState.inspectProcess,
  sendRuntimePtyInputVerified: (
    _settings: unknown,
    ptyId: string,
    data: string
  ): Promise<boolean> => testState.sendInput(ptyId, data),
  // The native-chat path writes fire-and-forget on the same PTY.
  sendRuntimePtyInput: (_settings: unknown, ptyId: string, data: string): void => {
    testState.writes.push({ ptyId, data })
  }
}))

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
const ENTER = '\r'
const STEP_PROMPT = 'Continue the queued work: polish the intro.'
const CODEX_SUBMIT_RETRY_DELAY_MS = TUI_AGENT_CONFIG.codex.submitRetryDelayMs ?? 0

function writesTo(ptyId: string): string[] {
  return testState.writes.filter((write) => write.ptyId === ptyId).map((write) => write.data)
}

/**
 * Stands in for the host's per-session input queue: executes a submitted program's
 * steps in order and holds the next item for a session until the current one ends.
 *
 * The real queue's ordering, idempotency, cancellation and receipts are pinned
 * host-side in src/main/runtime/session-input/. What this double supplies is the
 * transport, so these cases fail if a send path goes back to writing its own bytes
 * on its own clock — that regression is what they exist to catch.
 */
function hostSessionInputQueueDouble(): {
  submitSessionInput: (submission: SessionInputSubmission) => Promise<SessionInputReceipt>
  cancelSessionInput: (ptyId: string) => Promise<boolean>
} {
  const tailByPtyId = new Map<string, Promise<void>>()
  const runProgram = async (submission: SessionInputSubmission): Promise<void> => {
    for (const step of submission.program.steps) {
      if (step.kind === 'write') {
        testState.writes.push({ ptyId: submission.ptyId, data: step.data })
        continue
      }
      const waitMs = step.kind === 'pause' ? step.ms : step.afterMs
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, waitMs))
      if (step.kind === 'clear-confirm') {
        testState.writes.push({ ptyId: submission.ptyId, data: step.widenTo })
      }
    }
  }
  return {
    submitSessionInput: (submission) => {
      const previous = tailByPtyId.get(submission.ptyId) ?? Promise.resolve()
      const run = previous.then(() => runProgram(submission))
      tailByPtyId.set(
        submission.ptyId,
        run.then(
          () => undefined,
          () => undefined
        )
      )
      return run.then(() => ({
        clientMessageId: submission.clientMessageId,
        status: 'delivered' as const
      }))
    },
    cancelSessionInput: async () => true
  }
}

describe('what one chain step puts on its pane', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // Why this shape: no `getMainBufferSnapshot`, so the startup-review read is
    // unavailable and delivery proceeds — that behaviour has its own tests. The
    // session-input entry point IS present, as it is in production, so each send
    // path below hands its sequence to the host instead of writing bytes itself.
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      api: { pty: hostSessionInputQueueDouble() }
    })
    testState.writes = []
    resetNativeChatPtySendQueuesForTests()
    testState.waitForReady.mockReset().mockResolvedValue(true)
    testState.inspectProcess.mockReset()
    testState.sendInput.mockReset().mockImplementation(async (ptyId: string, data: string) => {
      testState.writes.push({ ptyId, data })
      return true
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('delivers exactly one paste and one Enter, to the launched pane only', async () => {
    const delivered = pasteDraftToAgentPtyWhenReady({
      tabId: 'tab-step-2',
      ptyId: 'pty-step-2',
      content: STEP_PROMPT,
      agent: 'claude',
      submit: true,
      forcePaste: true
    })
    await vi.advanceTimersByTimeAsync(POST_PASTE_SUBMIT_DELAY_MS + 10)
    expect(await delivered).toBe(true)
    expect(writesTo('pty-step-2')).toEqual([`${PASTE_START}${STEP_PROMPT}${PASTE_END}`, ENTER])
    // The prompt text itself is written once, and nothing reaches any other pane.
    expect(testState.writes.filter((write) => write.data.includes(STEP_PROMPT))).toHaveLength(1)
    expect(new Set(testState.writes.map((write) => write.ptyId))).toEqual(new Set(['pty-step-2']))
  })

  it('keeps a second delivery out of the first prompt’s submit window', async () => {
    // Why: a double Enter inside the 500ms submit window used to glue two prompts into
    // one composer line. Each delivery owns the line until its own Enter has fired.
    const first = submitPromptToAgentPty({
      tabId: 'tab-step-2',
      ptyId: 'pty-step-2',
      content: 'first prompt'
    })
    const second = submitPromptToAgentPty({
      tabId: 'tab-step-2',
      ptyId: 'pty-step-2',
      content: 'second prompt'
    })
    await vi.advanceTimersByTimeAsync(POST_PASTE_SUBMIT_DELAY_MS * 4 + 10)
    expect(await first).toBe(true)
    expect(await second).toBe(true)
    expect(writesTo('pty-step-2')).toEqual([
      `${PASTE_START}first prompt${PASTE_END}`,
      ENTER,
      `${PASTE_START}second prompt${PASTE_END}`,
      ENTER
    ])
  })

  it('treats the configured retry Enter as one prompt, not two', async () => {
    // Codex can eat the first Enter, so its submit is Enter + one retry Enter. That is
    // still ONE delivered prompt: the body is pasted once and the retry lands on an
    // empty composer, inside the same transaction so nothing can paste between them.
    const delivered = pasteDraftToAgentPtyWhenReady({
      tabId: 'tab-step-3',
      ptyId: 'pty-step-3',
      content: STEP_PROMPT,
      agent: 'codex',
      submit: true,
      forcePaste: true
    })
    await vi.advanceTimersByTimeAsync(POST_PASTE_SUBMIT_DELAY_MS + CODEX_SUBMIT_RETRY_DELAY_MS + 10)
    expect(await delivered).toBe(true)
    const stream = writesTo('pty-step-3')
    expect(stream.filter((data) => data.includes(STEP_PROMPT))).toHaveLength(1)
    expect(stream.filter((data) => data === ENTER)).toHaveLength(2)
    expect(stream).toEqual([`${PASTE_START}${STEP_PROMPT}${PASTE_END}`, ENTER, ENTER])
  })

  it('holds a chat send out of a step’s submit window', async () => {
    // The defect this path was unified for, now inverted. MEASURED before the change,
    // with the paste transaction and the native-chat queue as two independent locks on
    // the SAME pty: the chat send's Ctrl+U killed the pasted step prompt and the STEP's
    // Enter submitted the CHAT text —
    //   paste(step prompt) | Ctrl+U | chat body | ⏎ | ⏎
    // Both paths now hand their whole sequence to the host's session queue, so each
    // item lands intact and in order.
    const stepPrompt = submitPromptToAgentPty({
      tabId: 'tab-step-6',
      ptyId: 'pty-step-6',
      content: STEP_PROMPT
    })
    sendNativeChatMessage({} as never, 'pty-step-6', 'a question the person typed')
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_SUBMIT_DELAY_MS * 2)
    expect(await stepPrompt).toBe(true)
    expect(writesTo('pty-step-6')).toEqual([
      `${PASTE_START}${STEP_PROMPT}${PASTE_END}`,
      ENTER,
      '\x15',
      'a question the person typed',
      ENTER
    ])
    // The step's prompt reached the composer whole: nothing was written between the
    // paste and its own Enter.
    expect(writesTo('pty-step-6').indexOf('\x15')).toBe(2)
  })

  it('FALLBACK — a remote-runtime PTY is written by its own host, so the interleave remains', async () => {
    // Not a regression: a `remote:` PTY's bytes are written by the host that owns it,
    // which needs its own queue entry point. Until that lands these sends keep the old
    // two-lock behaviour, and this case states it rather than letting the queued cases
    // above imply the gap is closed.
    const remotePtyId = 'remote:env-a@@handle-6'
    const stepPrompt = submitPromptToAgentPty({
      tabId: 'tab-step-7',
      ptyId: remotePtyId,
      content: STEP_PROMPT
    })
    sendNativeChatMessage({} as never, remotePtyId, 'a question the person typed')
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_SUBMIT_DELAY_MS * 2)
    expect(await stepPrompt).toBe(true)
    expect(writesTo(remotePtyId)).toEqual([
      `${PASTE_START}${STEP_PROMPT}${PASTE_END}`,
      '\x15',
      'a question the person typed',
      ENTER,
      ENTER
    ])
  })

  it('writes nothing to a pane whose PTY was rebound before the send', async () => {
    let ptyId = 'pty-old'
    const assertSamePty = (): void => {
      if (ptyId !== 'pty-old') {
        throw new Error('automation_terminal_authority_changed')
      }
    }
    ptyId = 'pty-new'
    await expect(
      submitPromptToAgentPty({
        tabId: 'tab-step-4',
        ptyId: 'pty-old',
        content: STEP_PROMPT,
        beforeWrite: assertSamePty,
        writePty: async (data) => {
          testState.writes.push({ ptyId: 'pty-old', data })
          return true
        }
      })
    ).rejects.toThrow('automation_terminal_authority_changed')
    expect(writesTo('pty-old')).toEqual([])
  })

  it('stops at the paste when the PTY is rebound mid-send: no Enter to the old pane', async () => {
    let rebound = false
    const assertSamePty = (): void => {
      if (rebound) {
        throw new Error('automation_terminal_authority_changed')
      }
    }
    const submitted = submitPromptToAgentPty({
      tabId: 'tab-step-5',
      ptyId: 'pty-old',
      content: STEP_PROMPT,
      beforeWrite: assertSamePty,
      writePty: async (data) => {
        testState.writes.push({ ptyId: 'pty-old', data })
        // The pane was reconnected while the submit Enter was still pending.
        rebound = true
        return true
      }
    })
    const settled = expect(submitted).rejects.toThrow('automation_terminal_authority_changed')
    await vi.advanceTimersByTimeAsync(POST_PASTE_SUBMIT_DELAY_MS + 10)
    await settled
    expect(writesTo('pty-old')).toEqual([`${PASTE_START}${STEP_PROMPT}${PASTE_END}`])
  })
})
