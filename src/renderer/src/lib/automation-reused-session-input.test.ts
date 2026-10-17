import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sendAutomationSessionInput } from './automation-reused-session-input'
import {
  readLastAutomationTerminalInputAt,
  resetTerminalInputActivityCoalescingForTests
} from './terminal-input-activity-coalescing'

const mocks = vi.hoisted(() => ({ call: vi.fn(), record: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.call }))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  recordRuntimeTerminalInputForPtyId: mocks.record
}))
const input = { workspaceId: 'wt-1', paneKey: 'pane-1', ptyId: 'pty-1', text: 'prompt' }

describe('automation executor input', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetTerminalInputActivityCoalescingForTests()
  })

  it('records input only after the exact executor accepts it, as the routine, not a person', async () => {
    mocks.call.mockResolvedValueOnce({
      send: { accepted: true, handle: 'terminal-1', bytesWritten: 6 }
    })

    await expect(sendAutomationSessionInput(input)).resolves.toBe(true)

    expect(mocks.call).toHaveBeenCalledWith({ kind: 'local' }, 'automation.sendInput', input, {
      timeoutMs: 15_000
    })
    expect(mocks.record).toHaveBeenCalledWith('pty-1', expect.any(Number))
    // Why the same stamp: session reuse treats input at or before it as the routine's own.
    expect(readLastAutomationTerminalInputAt('pane-1')).toBe(mocks.record.mock.calls[0][1])
  })

  it('refuses a rejected send result without recording input', async () => {
    mocks.call.mockResolvedValueOnce({
      send: { accepted: false, handle: 'terminal-1', bytesWritten: 0 }
    })

    await expect(sendAutomationSessionInput(input)).rejects.toThrow('refused by the execution host')

    expect(mocks.record).not.toHaveBeenCalled()
    expect(readLastAutomationTerminalInputAt('pane-1')).toBeUndefined()
  })

  it('carries the exact output binding on every reused-session prompt chunk', async () => {
    const automationOutputBinding = Object.freeze({
      automationId: 'routine-1',
      runId: 'run-1',
      token: 'fixture-output-binding-token'
    })
    const chunks = ['\u001b[200~', 'prompt part one', 'prompt part two', '\u001b[201~', '\r']
    mocks.call.mockResolvedValue({
      send: { accepted: true, handle: 'terminal-1', bytesWritten: 1 }
    })

    for (const text of chunks) {
      await sendAutomationSessionInput({ ...input, text, automationOutputBinding })
    }

    expect(mocks.call).toHaveBeenCalledTimes(chunks.length)
    mocks.call.mock.calls.forEach(([target, method, args], index) => {
      expect(target).toEqual({ kind: 'local' })
      expect(method).toBe('automation.sendInput')
      expect(args).toEqual({ ...input, text: chunks[index], automationOutputBinding })
      expect(args.automationOutputBinding).toBe(automationOutputBinding)
    })
  })

  it('preserves the host error without recording or retrying input', async () => {
    const refusal = new Error('Card btk_durable owns this run')
    mocks.call.mockRejectedValueOnce(refusal)

    await expect(sendAutomationSessionInput(input)).rejects.toBe(refusal)

    expect(mocks.call).toHaveBeenCalledOnce()
    expect(mocks.record).not.toHaveBeenCalled()
  })
})
