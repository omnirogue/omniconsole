import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runTerminalPtyInputTransaction } from '@/components/terminal-pane/terminal-pty-input-transaction'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import {
  AGENT_DRAFT_PASTE_DIRECT_MAX_BYTES,
  pasteDraftToAgentPtyWhenReady,
  POST_PASTE_SUBMIT_DELAY_MS,
  submitPromptToAgentPty
} from './agent-paste-draft'

const testState = vi.hoisted(() => ({
  waitForReady: vi.fn(),
  inspectProcess: vi.fn(),
  sendInput: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ settings: {}, tabsByWorktree: {} })
  }
}))

vi.mock('./agent-draft-readiness', () => ({
  waitForAgentDraftInputReady: testState.waitForReady
}))

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  inspectRuntimeTerminalProcess: testState.inspectProcess,
  sendRuntimePtyInputVerified: testState.sendInput
}))

describe('agent prompt write authority', () => {
  let hubTaskId: string | undefined
  const beforeWrite = (): void => {
    if (hubTaskId) {
      throw new Error(`Workspace is now admitted to ${hubTaskId}`)
    }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout
    })
    hubTaskId = undefined
    testState.waitForReady.mockReset().mockResolvedValue(true)
    testState.inspectProcess.mockReset()
    testState.sendInput.mockReset().mockResolvedValue(true)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('uses a supplied execution writer for both paste and Enter without generic input', async () => {
    const writePty = vi.fn().mockResolvedValue(true)
    const submitted = submitPromptToAgentPty({
      tabId: 'tab-1',
      ptyId: 'pty-1',
      content: 'run',
      writePty
    })
    await vi.advanceTimersByTimeAsync(POST_PASTE_SUBMIT_DELAY_MS)

    await expect(submitted).resolves.toBe(true)
    expect(writePty.mock.calls.map(([text]) => text)).toEqual(['\x1b[200~run\x1b[201~', '\r'])
    expect(testState.sendInput).not.toHaveBeenCalled()
  })

  it.each(['run', 'x'.repeat(AGENT_DRAFT_PASTE_DIRECT_MAX_BYTES + 1)])(
    'preserves a custom writer rejection for short and chunked prompts',
    async (content) => {
      const refusal = new Error('Hub card btk_durable owns this run')
      const writePty = vi.fn().mockRejectedValue(refusal)
      const submitted = submitPromptToAgentPty({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        content,
        writePty
      })
      const result = expect(submitted).rejects.toBe(refusal)
      await vi.advanceTimersByTimeAsync(0)

      await result
      expect(writePty).toHaveBeenCalled()
      expect(testState.sendInput).not.toHaveBeenCalled()
    }
  )

  it('refuses before entering the input queue when authority is already revoked', async () => {
    hubTaskId = 'btk_admitted'

    await expect(
      submitPromptToAgentPty({ tabId: 'tab-1', ptyId: 'pty-1', content: 'run', beforeWrite })
    ).rejects.toThrow('Workspace is now admitted')

    expect(testState.sendInput).not.toHaveBeenCalled()
  })

  it('rechecks a workspace linked while waiting for the existing PTY input transaction', async () => {
    const queue = createDeferred<void>()
    const previous = runTerminalPtyInputTransaction('pty-1', () => queue.promise)
    const submitted = submitPromptToAgentPty({
      tabId: 'tab-1',
      ptyId: 'pty-1',
      content: 'run',
      beforeWrite
    })
    hubTaskId = 'btk_admitted'
    queue.resolve()

    await previous
    await expect(submitted).resolves.toBe(false)
    expect(testState.sendInput).not.toHaveBeenCalled()
  })

  it.each(['composer', 'process fallback'] as const)(
    'rechecks after awaited %s readiness before pasting',
    async (readiness) => {
      const ready = createDeferred<boolean>()
      const process = createDeferred<{ foregroundProcess: string }>()
      testState.waitForReady.mockReturnValue(readiness === 'composer' ? ready.promise : false)
      testState.inspectProcess.mockReturnValue(process.promise)
      const submitted = pasteDraftToAgentPtyWhenReady({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        content: 'run',
        agent: 'codex',
        forcePaste: true,
        submit: true,
        beforeWrite
      })
      await vi.advanceTimersByTimeAsync(0)
      hubTaskId = 'btk_admitted'
      ready.resolve(true)
      process.resolve({ foregroundProcess: 'codex' })

      await expect(submitted).resolves.toBe(false)
      expect(testState.sendInput).not.toHaveBeenCalled()
    }
  )

  it('does not send Enter when authority changes after the paste is accepted', async () => {
    const submitted = submitPromptToAgentPty({
      tabId: 'tab-1',
      ptyId: 'pty-1',
      content: 'run',
      beforeWrite
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(testState.sendInput).toHaveBeenCalledWith({}, 'pty-1', '\x1b[200~run\x1b[201~')
    hubTaskId = 'btk_admitted'
    await vi.advanceTimersByTimeAsync(POST_PASTE_SUBMIT_DELAY_MS)

    await expect(submitted).resolves.toBe(false)
    expect(testState.sendInput).toHaveBeenCalledTimes(1)
  })

  it('does not retry Enter after authority changes and keeps the first submit verdict', async () => {
    const submitted = pasteDraftToAgentPtyWhenReady({
      tabId: 'tab-1',
      ptyId: 'pty-1',
      content: 'run',
      agent: 'codex',
      forcePaste: true,
      submit: true,
      beforeWrite
    })
    await vi.advanceTimersByTimeAsync(POST_PASTE_SUBMIT_DELAY_MS)
    expect(testState.sendInput).toHaveBeenLastCalledWith({}, 'pty-1', '\r')
    hubTaskId = 'btk_admitted'
    await vi.advanceTimersByTimeAsync(TUI_AGENT_CONFIG.codex.submitRetryDelayMs ?? 0)

    await expect(submitted).resolves.toBe(true)
    expect(testState.sendInput).toHaveBeenCalledTimes(2)
  })

  it('rechecks between large-paste writes before sending any remaining content', async () => {
    testState.sendInput.mockImplementation(async () => {
      hubTaskId = 'btk_admitted'
      return true
    })

    await expect(
      submitPromptToAgentPty({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        content: 'x'.repeat(AGENT_DRAFT_PASTE_DIRECT_MAX_BYTES + 1),
        beforeWrite
      })
    ).resolves.toBe(false)

    expect(testState.sendInput).toHaveBeenCalledExactlyOnceWith({}, 'pty-1', '\x1b[200~')
  })
})

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}
