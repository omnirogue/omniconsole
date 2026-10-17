import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './omni-runtime'
import { SessionInputQueue } from './session-input/session-input-queue'
import { clearUnresolvedDraft } from './terminal-unresolved-draft'
import type { TerminalAgentProcessProof } from './terminal-agent-process'
import type { WriteFence } from '../pty/guarded-pty-write'

const receiver = {
  ptyId: 'key-cancel-pty',
  pid: 20,
  pgid: 20,
  rootPid: 20,
  startTimeMs: 1000,
  incarnationId: 'incarnation'
} as TerminalAgentProcessProof
const fence: WriteFence = {
  token: 'key-test-fence',
  isRevoked: () => false,
  onClose: () => () => {}
}
function fixture() {
  const runtime = Object.create(OrcaRuntimeService.prototype) as OrcaRuntimeService
  const assertProcess = vi.fn(async () => {})
  const guardedWrite = vi.fn(
    async (_id: string, _data: string, _receiver: TerminalAgentProcessProof, _fence: WriteFence) =>
      'written' as const
  )
  Object.assign(runtime, {
    sessionInputQueue: new SessionInputQueue({ write: async () => true }),
    ptyController: { guardedWrite },
    ptysById: new Map([[receiver.ptyId, { connectionId: null }]]),
    getTerminalAgentStatusPtyId: () => receiver.ptyId,
    assertTerminalAgentProcess: assertProcess,
    assertTerminalAgentStatusPtyBinding: () => {}
  })
  return { runtime, assertProcess, guardedWrite }
}
afterEach(() => clearUnresolvedDraft(receiver.ptyId))

describe('guarded key queue cancellation', () => {
  it('refuses a handle/receiver mismatch before borrowing any session queue', async () => {
    const f = fixture()
    const queue = vi.fn()
    Object.assign(f.runtime, { serializeAgentPromptSubmission: queue })
    expect(
      await f.runtime.sendGuardedSessionKey(
        'handle',
        'y',
        { ...receiver, ptyId: 'other-session' },
        fence
      )
    ).toBe('refused')
    expect(queue).not.toHaveBeenCalled()
    expect(f.assertProcess).not.toHaveBeenCalled()
    expect(f.guardedWrite).not.toHaveBeenCalled()
  })

  it('writes no delayed approval after Ctrl-C cancels a process-proof wait, even after draft reconciliation', async () => {
    const f = fixture()
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    f.assertProcess.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
          entered()
        })
    )
    const answer = f.runtime.sendGuardedSessionKey('handle', 'y', receiver, fence)
    const cancelled = expect(answer).rejects.toThrow('terminal_handle_stale')
    await started
    expect(await f.runtime.sendGuardedSessionKey('handle', '\x03', receiver, fence)).toBe('written')
    clearUnresolvedDraft(receiver.ptyId)
    release()
    await cancelled
    await Promise.resolve()
    expect(f.guardedWrite.mock.calls.map((call) => call[1])).toEqual(['\x03'])
  })

  it('closes an already registered owning-writer latch synchronously on cancellation', async () => {
    const f = fixture()
    let release!: () => void
    let entered!: () => void
    let latchClosed = false
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    f.guardedWrite.mockImplementationOnce(async (_id, _data, _receiver, bound) => {
      const detach = bound.onClose!(() => {
        latchClosed = true
      })
      entered()
      await new Promise<void>((resolve) => {
        release = resolve
      })
      expect(bound.isRevoked()).toBe(true)
      detach()
      return 'written' // A late response still cannot reopen the cancelled queue item.
    })
    const answer = f.runtime.sendGuardedSessionKey('handle', 'y', receiver, fence)
    const cancelled = expect(answer).rejects.toThrow('terminal_handle_stale')
    await started
    expect(await f.runtime.sendGuardedSessionKey('handle', '\x03', receiver, fence)).toBe('written')
    expect(latchClosed).toBe(true)
    release()
    await cancelled
  })
})

describe('SSH guarded stop routing', () => {
  function remoteFixture() {
    const f = fixture()
    const remoteReceiver = { ...receiver, interruptToken: '9d283a44-cbc8-4db9-a2e5-fb8154cd8ba4' }
    const interruptAgent = vi.fn(async () => 'written' as const)
    const pty = { connectionId: 'target', connected: true, incarnationId: receiver.incarnationId }
    const provider = { interruptAgent }
    Object.assign(f.runtime, {
      ptysById: new Map([[receiver.ptyId, pty]]),
      getSshProviderFn: () => provider
    })
    return { ...f, remoteReceiver, interruptAgent, pty, provider }
  }

  it('sends Ctrl+C only through the captured execution owner and leaves local writer unused', async () => {
    const f = remoteFixture()
    expect(await f.runtime.sendGuardedSessionKey('handle', '\x03', f.remoteReceiver, fence)).toBe(
      'written'
    )
    expect(f.interruptAgent).toHaveBeenCalledWith(
      receiver.ptyId,
      f.remoteReceiver,
      expect.objectContaining({ signal: expect.any(AbortSignal), isCurrent: expect.any(Function) })
    )
    expect(f.guardedWrite).not.toHaveBeenCalled()
  })

  it('does not promote a stop ticket to approval-key or prompt authority', async () => {
    const f = remoteFixture()
    expect(await f.runtime.sendGuardedSessionKey('handle', 'y', f.remoteReceiver, fence)).toBe(
      'unsupported'
    )
    expect(await f.runtime.sendGuardedSessionKey('handle', '\x03', receiver, fence)).toBe(
      'unsupported'
    )
    expect(f.interruptAgent).not.toHaveBeenCalled()
    expect(f.guardedWrite).not.toHaveBeenCalled()
  })

  it('refuses a changed owner after the asynchronous foreground recheck', async () => {
    const f = remoteFixture()
    f.assertProcess.mockImplementationOnce(async () => {
      f.pty.connected = false
    })
    expect(await f.runtime.sendGuardedSessionKey('handle', '\x03', f.remoteReceiver, fence)).toBe(
      'revoked'
    )
    expect(f.interruptAgent).not.toHaveBeenCalled()
    expect(f.guardedWrite).not.toHaveBeenCalled()
  })
})
