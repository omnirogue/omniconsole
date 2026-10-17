import { describe, expect, it } from 'vitest'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { createMockMux } from './ssh-pty-provider-mock-multiplexer'
import { createSshPtyAgentInterrupter } from './ssh-pty-agent-interrupt'
import type { TerminalAgentProcessProof } from '../../shared/pty-agent-process-evidence'

function fixture() {
  const mux = createMockMux()
  const state = { present: true, incarnation: 'birth-a', current: true }
  const abort = new AbortController()
  const interrupt = createSshPtyAgentInterrupter({
    mux: mux as unknown as SshChannelMultiplexer,
    toRelayPtyId: () => 'relay-pty',
    hasPty: () => state.present,
    getIncarnation: () => state.incarnation
  })
  const proof: TerminalAgentProcessProof = {
    ptyId: 'app-pty',
    incarnationId: 'birth-a',
    rootPid: 100,
    pid: 200,
    pgid: 200,
    startTimeMs: 20000,
    agent: 'claude',
    via: 'command-line',
    interruptToken: '9d283a44-cbc8-4db9-a2e5-fb8154cd8ba4'
  }
  const reply = {
    id: 'relay-pty',
    incarnationId: 'birth-a',
    interruptToken: proof.interruptToken,
    outcome: 'written'
  }
  mux.request.mockResolvedValue(reply)
  const send = () =>
    interrupt('app-pty', proof, { signal: abort.signal, isCurrent: () => state.current })
  return { mux, state, abort, proof, reply, send }
}

describe('SSH owner interrupt transport', () => {
  it('uses only the dedicated owner ticket request, without raw data or a local fallback', async () => {
    const f = fixture()
    expect(await f.send()).toBe('written')
    expect(f.mux.request).toHaveBeenCalledWith(
      'pty.interruptAgent',
      {
        id: 'relay-pty',
        incarnationId: 'birth-a',
        interruptToken: f.proof.interruptToken
      },
      { timeoutMs: 5000, signal: f.abort.signal }
    )
    expect(f.mux.notify).not.toHaveBeenCalled()
  })

  it.each(['incarnation', 'presence', 'transport', 'controller', 'cancel'])(
    'reports uncertainty if %s changes in flight',
    async (change) => {
      const f = fixture()
      f.mux.request.mockImplementation(async () => {
        if (change === 'incarnation') {
          f.state.incarnation = 'birth-b'
        }
        if (change === 'presence') {
          f.state.present = false
        }
        if (change === 'transport') {
          f.mux.isDisposed.mockReturnValue(true)
        }
        if (change === 'controller') {
          f.state.current = false
        }
        if (change === 'cancel') {
          f.abort.abort()
        }
        return f.reply
      })
      expect(await f.send()).toBe('unknown')
      expect(f.mux.request).toHaveBeenCalledTimes(1)
    }
  )

  it('refuses before dispatch when cancelled, and old proofs have no authority', async () => {
    const f = fixture()
    f.abort.abort()
    expect(await f.send()).toBe('refused')
    delete f.proof.interruptToken
    expect(await f.send()).toBe('unsupported')
    expect(f.mux.request).not.toHaveBeenCalled()
  })

  it('caches old-relay unsupported separately from uncertain writes', async () => {
    const f = fixture()
    f.mux.request.mockRejectedValueOnce(new Error('timeout'))
    expect(await f.send()).toBe('unknown')
    f.mux.request.mockRejectedValue({ code: -32601 })
    expect(await f.send()).toBe('unsupported')
    expect(await f.send()).toBe('unsupported')
    expect(f.mux.request).toHaveBeenCalledTimes(2)
  })

  it('does not trust a mismatched acknowledgement', async () => {
    const f = fixture()
    f.reply.id = 'other'
    expect(await f.send()).toBe('unknown')
  })
})
