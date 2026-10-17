import { describe, expect, it } from 'vitest'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { createMockMux } from './ssh-pty-provider-mock-multiplexer'
import { createSshPtyAgentEvidenceReader } from './ssh-pty-agent-process-evidence'

function fixture() {
  const mux = createMockMux()
  const state = { present: true, incarnation: 'birth-a' }
  const read = createSshPtyAgentEvidenceReader({
    mux: mux as unknown as SshChannelMultiplexer,
    toRelayPtyId: () => 'remote-pty',
    hasPty: () => state.present,
    getIncarnation: () => state.incarnation
  })
  const reply = {
    id: 'remote-pty',
    incarnationId: 'birth-a',
    proof: {
      ptyId: 'remote-pty',
      incarnationId: 'birth-a',
      rootPid: 100,
      pid: 200,
      pgid: 200,
      startTimeMs: 20000,
      agent: 'claude',
      via: 'command-line'
    },
    tree: { kind: 'other' }
  }
  mux.request.mockResolvedValue(reply)
  return { mux, state, read, reply }
}

describe('SSH agent process evidence', () => {
  it('maps a matching owner proof to the controller PTY identity', async () => {
    const { read, reply, mux } = fixture()
    expect(await read('ssh:target:remote-pty', 'birth-a')).toEqual({
      proof: { ...reply.proof, ptyId: 'ssh:target:remote-pty' },
      tree: reply.tree
    })
    expect(mux.request).toHaveBeenCalledWith(
      'pty.readAgentProcessEvidence',
      { id: 'remote-pty', incarnationId: 'birth-a' },
      { timeoutMs: 5000 }
    )
  })

  it.each(['incarnation', 'presence', 'transport'] as const)(
    'discards a reply after %s changes while awaiting the host',
    async (change) => {
      const { read, mux, state, reply } = fixture()
      mux.request.mockImplementation(async () => {
        if (change === 'incarnation') {
          state.incarnation = 'birth-b'
        }
        if (change === 'presence') {
          state.present = false
        }
        if (change === 'transport') {
          mux.isDisposed.mockReturnValue(true)
        }
        return reply
      })
      expect(await read('app-pty', 'birth-a')).toBeNull()
    }
  )

  it.each(['id', 'incarnationId', 'proofId', 'proofIncarnation', 'malformed'])(
    'refuses mismatched or invalid %s evidence',
    async (field) => {
      const { read, mux, reply } = fixture()
      if (field === 'id') {
        reply.id = 'other'
      }
      if (field === 'incarnationId') {
        reply.incarnationId = 'other'
      }
      if (field === 'proofId') {
        reply.proof.ptyId = 'other'
      }
      if (field === 'proofIncarnation') {
        reply.proof.incarnationId = 'other'
      }
      mux.request.mockResolvedValue(
        field === 'malformed' ? { tree: { kind: 'agent-gone' } } : reply
      )
      expect(await read('app-pty', 'birth-a')).toBeNull()
    }
  )

  it('caches an old relay refusal per provider, never as process death', async () => {
    const { read, mux } = fixture()
    mux.request.mockRejectedValue({ code: -32601 })
    expect(await read('app-pty', 'birth-a')).toBeNull()
    expect(await read('app-pty', 'birth-a')).toBeNull()
    expect(mux.request).toHaveBeenCalledTimes(1)
    expect(await fixture().read('app-pty', 'birth-a')).not.toBeNull()
  })

  it('can recover after transport failure and accepts only positive owner exit evidence', async () => {
    const { read, mux, reply } = fixture()
    mux.request.mockRejectedValueOnce(new Error('disconnected'))
    expect(await read('app-pty', 'birth-a')).toBeNull()
    mux.request.mockResolvedValue({ ...reply, proof: null, tree: { kind: 'agent-gone' } })
    expect(await read('app-pty', 'birth-a')).toEqual({ proof: null, tree: { kind: 'agent-gone' } })
  })

  it('does not ask an already disposed provider', async () => {
    const { read, mux } = fixture()
    mux.isDisposed.mockReturnValue(true)
    expect(await read('app-pty', 'birth-a')).toBeNull()
    expect(mux.request).not.toHaveBeenCalled()
  })
})
