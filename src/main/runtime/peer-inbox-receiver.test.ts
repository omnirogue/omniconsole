import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  PeerInboxReceiver,
  parsePeerInboxPending,
  type PeerInboxAdmission,
  type PeerInboxAttempt,
  type PeerInboxReceiverOwner
} from './peer-inbox-receiver'

type Binding = { readonly key: string; readonly generation: number }
type Submit = 'submitted' | 'not-written' | 'uncertain'
type Observation = 'unresolved' | 'completed' | 'not-written'
const pending = (available = 1, leased = 0, blocked = 0) => ({
  schema_version: 1,
  pending: available + leased + blocked,
  available,
  leased,
  blocked
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture() {
  const binding: Binding = { key: 'scope/native/pty-generation-1', generation: 1 }
  const state = {
    current: true,
    admission: 'ready' as PeerInboxAdmission,
    metadata: pending(),
    persisted: null as PeerInboxAttempt | null,
    observation: 'unresolved' as Observation
  }
  const owner = {
    isCurrent: vi.fn((candidate: Readonly<Binding>) => candidate === binding && state.current),
    readPending: vi.fn(async (_signal: AbortSignal): Promise<unknown> => state.metadata),
    admit: vi.fn(async () => state.admission),
    loadAttempt: vi.fn(async () => state.persisted),
    persistAttempt: vi.fn(async (_binding: Readonly<Binding>, attempt: PeerInboxAttempt) => {
      state.persisted = attempt
    }),
    clearAttempt: vi.fn(async (_binding: Readonly<Binding>, nonce: string) => {
      if (state.persisted?.nonce === nonce) {
        state.persisted = null
      }
    }),
    submitHint: vi.fn(
      async (_binding: Readonly<Binding>, _nonce: string, _signal: AbortSignal): Promise<Submit> =>
        'submitted'
    ),
    observeAttempt: vi.fn(
      async (_binding: Readonly<Binding>, _nonce: string): Promise<Observation> => state.observation
    )
  } satisfies PeerInboxReceiverOwner<Binding>
  const create = () => {
    const receiver = new PeerInboxReceiver(binding, owner, { pollIntervalMs: 100 })
    receivers.push(receiver)
    receiver.start()
    return receiver
  }
  return { binding, state, owner, create }
}

const receivers: PeerInboxReceiver<Binding>[] = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  for (const receiver of receivers.splice(0)) {
    receiver.dispose()
  }
  vi.useRealTimers()
})

describe('canonical peer pending receiver', () => {
  it('finds a new message while the native session remains idle', async () => {
    const { state, owner, create, binding } = fixture()
    state.metadata = pending(0)
    const receiver = create()
    await vi.advanceTimersByTimeAsync(0)
    expect(receiver.getStatus().phase).toBe('idle')
    state.metadata = pending(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(owner.submitHint).toHaveBeenCalledTimes(1)
    expect(owner.submitHint.mock.calls[0][0]).toBe(binding)
    expect(Object.isFrozen(binding)).toBe(true)
    expect(state.persisted?.nonce).toBe(owner.submitHint.mock.calls[0][1])
    expect(owner.persistAttempt.mock.invocationCallOrder[0]).toBeLessThan(
      owner.submitHint.mock.invocationCallOrder[0]
    )
    expect(receiver.getStatus().phase).toBe('awaiting-completion')
    await vi.advanceTimersByTimeAsync(500)
    expect(owner.submitHint).toHaveBeenCalledTimes(1)
  })

  it.each(['busy', 'consent', 'input'] as const)(
    'coalesces pending hints during %s until the native owner admits input',
    async (admission) => {
      const { state, owner, create } = fixture()
      state.admission = admission
      const receiver = create()
      await vi.advanceTimersByTimeAsync(300)
      expect(owner.submitHint).not.toHaveBeenCalled()
      expect(owner.persistAttempt).not.toHaveBeenCalled()
      expect(receiver.getStatus().phase).toBe(admission)
      state.admission = 'ready'
      receiver.notifyOwnerChanged()
      receiver.notifyOwnerChanged()
      await vi.advanceTimersByTimeAsync(0)
      expect(owner.submitHint).toHaveBeenCalledTimes(1)
    }
  )

  it('does not submit blocked or leased messages', async () => {
    const { state, owner, create } = fixture()
    state.metadata = pending(0, 3, 4)
    const receiver = create()
    await vi.advanceTimersByTimeAsync(0)
    expect(receiver.getStatus().pending?.pending).toBe(7)
    expect(owner.admit).not.toHaveBeenCalled()
    expect(owner.submitHint).not.toHaveBeenCalled()
  })

  it('reports the advertised agent exchange without letting it gate delivery', async () => {
    const { owner, create } = fixture()
    const off = (kind: string) => ({
      kind,
      implementation: 'not_implemented',
      feature_enabled: false,
      receive_mode: 'none',
      wake_mode: 'none',
      lease_ack: false,
      model_ack: false,
      reply_correlation: false,
      task_incorporation: false
    })
    const exchange = {
      ...off('agent_exchange'),
      implementation: 'implemented',
      feature_enabled: true,
      receive_mode: 'explicit_pull',
      lease_ack: true,
      reply_correlation: true
    }
    const channels = [off('human_chat'), exchange, off('managed_job')]
    owner.readPending.mockResolvedValueOnce({
      ...pending(0),
      communication: { schema_version: 1, scope: 'deployment_capabilities', channels }
    })
    const receiver = create()
    await vi.advanceTimersByTimeAsync(0)
    expect(receiver.getStatus().communication).toMatchObject({
      status: 'valid',
      channels: { agent_exchange: { receive_mode: 'explicit_pull', wake_mode: 'none' } }
    })
    owner.readPending.mockResolvedValue({ ...pending(1), communication: { schema_version: 2 } })
    await vi.advanceTimersByTimeAsync(100)
    expect(receiver.getStatus().communication).toEqual({ status: 'unknown' })
    expect(owner.submitHint).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed counts without admitting native input', async () => {
    const { owner, create } = fixture()
    owner.readPending.mockResolvedValue({ ...pending(), available: 1.5 })
    const receiver = create()
    await vi.advanceTimersByTimeAsync(0)
    expect(receiver.getStatus()).toMatchObject({
      phase: 'error',
      reason: 'pending-read-failed'
    })
    expect(owner.persistAttempt).not.toHaveBeenCalled()
  })

  it('keeps only one poll in flight while owner events arrive', async () => {
    const { owner, create } = fixture()
    const read = deferred<unknown>()
    owner.readPending.mockReturnValueOnce(read.promise)
    const receiver = create()
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 5; i++) {
      receiver.notifyOwnerChanged()
    }
    await vi.advanceTimersByTimeAsync(1_000)
    expect(owner.readPending).toHaveBeenCalledTimes(1)
    read.resolve(pending())
    await vi.advanceTimersByTimeAsync(1)
    expect(owner.submitHint).toHaveBeenCalledTimes(1)
    expect(owner.readPending).toHaveBeenCalledTimes(1)
  })

  it.each(['load', 'pending', 'admit', 'persist', 'final-admit'] as const)(
    'rejects a stale binding after awaiting %s',
    async (stage) => {
      const { state, owner, create } = fixture()
      const gate = deferred<never>()
      if (stage === 'load') {
        owner.loadAttempt.mockReturnValueOnce(gate.promise)
      }
      if (stage === 'pending') {
        owner.readPending.mockReturnValueOnce(gate.promise)
      }
      if (stage === 'admit') {
        owner.admit.mockReturnValueOnce(gate.promise)
      }
      if (stage === 'persist') {
        owner.persistAttempt.mockReturnValueOnce(gate.promise)
      }
      if (stage === 'final-admit') {
        owner.admit.mockResolvedValueOnce('ready').mockReturnValueOnce(gate.promise)
      }
      const receiver = create()
      await vi.advanceTimersByTimeAsync(0)
      state.current = false
      gate.resolve((stage === 'load' ? null : stage === 'pending' ? pending() : 'ready') as never)
      await vi.advanceTimersByTimeAsync(1)
      expect(receiver.getStatus().phase).toBe('revoked')
      expect(owner.submitHint).not.toHaveBeenCalled()
      expect(owner.clearAttempt).not.toHaveBeenCalled()
    }
  )

  it('rechecks admission after persistence before the owner can write', async () => {
    const { state, owner, create } = fixture()
    owner.persistAttempt.mockImplementationOnce(async (_binding, attempt) => {
      state.persisted = attempt
      state.admission = 'input'
    })
    const receiver = create()
    await vi.advanceTimersByTimeAsync(0)
    expect(receiver.getStatus().phase).toBe('input')
    expect(owner.submitHint).not.toHaveBeenCalled()
    expect(state.persisted).toBeNull()
  })

  it('fails closed if restart recovery cannot read durable attempt state', async () => {
    const { owner, create } = fixture()
    owner.loadAttempt.mockRejectedValue(new Error('private diagnostics'))
    const receiver = create()
    await vi.advanceTimersByTimeAsync(500)
    expect(receiver.getStatus()).toMatchObject({
      phase: 'error',
      reason: 'attempt-load-failed'
    })
    expect(JSON.stringify(receiver.getStatus())).not.toContain('private diagnostics')
    expect(owner.readPending).not.toHaveBeenCalled()
    expect(owner.submitHint).not.toHaveBeenCalled()
  })

  it.each(['uncertain', 'throw'] as const)(
    'does not retry a potentially partial write (%s), including after restart',
    async (outcome) => {
      const { state, owner, create } = fixture()
      if (outcome === 'throw') {
        owner.submitHint.mockRejectedValueOnce(new Error('lost link'))
      } else {
        owner.submitHint.mockResolvedValueOnce('uncertain')
      }
      const first = create()
      await vi.advanceTimersByTimeAsync(0)
      const nonce = state.persisted?.nonce
      expect(nonce).toBeTruthy()
      expect(first.getStatus().phase).toBe('uncertain')
      first.dispose()
      const restarted = create()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(owner.submitHint).toHaveBeenCalledTimes(1)
      expect(restarted.getStatus()).toMatchObject({ phase: 'uncertain', attemptNonce: nonce })
      expect(owner.clearAttempt).not.toHaveBeenCalled()
    }
  )

  it('only retries after a definite before-write failure', async () => {
    const { state, owner, create } = fixture()
    owner.submitHint.mockResolvedValueOnce('not-written')
    create()
    await vi.advanceTimersByTimeAsync(0)
    expect(state.persisted).toBeNull()
    await vi.advanceTimersByTimeAsync(100)
    expect(owner.submitHint).toHaveBeenCalledTimes(2)
    expect(owner.submitHint.mock.calls[0][1]).not.toBe(owner.submitHint.mock.calls[1][1])
  })

  it('requires authoritative attempt completion before another hint', async () => {
    const { state, owner, create } = fixture()
    const receiver = create()
    await vi.advanceTimersByTimeAsync(0)
    const nonce = state.persisted?.nonce
    await vi.advanceTimersByTimeAsync(200)
    expect(owner.submitHint).toHaveBeenCalledTimes(1)
    state.observation = 'completed'
    state.metadata = pending(0)
    receiver.notifyOwnerChanged()
    await vi.advanceTimersByTimeAsync(0)
    expect(owner.clearAttempt).toHaveBeenCalledWith(expect.anything(), nonce, undefined)
    expect(receiver.getStatus().phase).toBe('idle')
    state.observation = 'unresolved'
    state.metadata = pending(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(owner.submitHint).toHaveBeenCalledTimes(2)
  })

  it('aborts teardown and ignores a late response from the old binding', async () => {
    const { owner, create } = fixture()
    const gate = deferred<unknown>()
    owner.readPending.mockReturnValueOnce(gate.promise)
    const receiver = create()
    await vi.advanceTimersByTimeAsync(0)
    const signal = owner.readPending.mock.calls[0][0]
    receiver.dispose()
    expect(signal.aborted).toBe(true)
    gate.resolve(pending())
    await vi.advanceTimersByTimeAsync(1_000)
    expect(receiver.getStatus().phase).toBe('stopped')
    expect(owner.submitHint).not.toHaveBeenCalled()
    expect(owner.readPending).toHaveBeenCalledTimes(1)
  })

  it('retains the durable latch when disposed during a possible write', async () => {
    const { state, owner, create } = fixture()
    const gate = deferred<Submit>()
    owner.submitHint.mockReturnValueOnce(gate.promise)
    const first = create()
    await vi.advanceTimersByTimeAsync(0)
    first.dispose()
    gate.resolve('submitted')
    await vi.advanceTimersByTimeAsync(1)
    expect(state.persisted).not.toBeNull()
    create()
    await vi.advanceTimersByTimeAsync(500)
    expect(owner.submitHint).toHaveBeenCalledTimes(1)
  })

  it('does not write if durable attempt persistence fails after admission', async () => {
    const { state, owner, create } = fixture()
    owner.persistAttempt.mockImplementationOnce(async (_binding, attempt) => {
      state.persisted = attempt
      throw new Error('uncertain disk flush')
    })
    const receiver = create()
    await vi.advanceTimersByTimeAsync(0)
    expect(receiver.getStatus().phase).toBe('uncertain')
    expect(owner.submitHint).not.toHaveBeenCalled()
    expect(state.persisted).not.toBeNull()
    receiver.dispose()
    create()
    await vi.advanceTimersByTimeAsync(500)
    expect(owner.submitHint).not.toHaveBeenCalled()
  })

  it('retries only clearing after a definite no-write result and a storage error', async () => {
    const { state, owner, create, binding } = fixture()
    owner.submitHint.mockResolvedValueOnce('not-written')
    owner.clearAttempt.mockRejectedValueOnce(new Error('disk unavailable'))
    const receiver = create()
    await vi.advanceTimersByTimeAsync(0)
    const nonce = state.persisted!.nonce
    state.metadata = pending(0)
    await vi.advanceTimersByTimeAsync(500)
    expect(owner.submitHint).toHaveBeenCalledTimes(1)
    expect(owner.observeAttempt).not.toHaveBeenCalled()
    expect(owner.clearAttempt).toHaveBeenLastCalledWith(binding, nonce, 'not-written')
    expect(state.persisted).toBeNull()
    expect(receiver.getStatus().phase).toBe('idle')
  })

  it('settles a failed initial reservation before permitting a fresh attempt', async () => {
    const { owner, create, binding } = fixture()
    owner.persistAttempt.mockRejectedValueOnce(new Error('reservation rejected'))
    create()
    await vi.advanceTimersByTimeAsync(0)
    const nonce = owner.persistAttempt.mock.calls[0][1].nonce
    expect(owner.submitHint).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(500)
    expect(owner.clearAttempt).toHaveBeenCalledWith(binding, nonce, 'not-written')
    expect(owner.submitHint).toHaveBeenCalledTimes(1)
    expect(owner.submitHint.mock.calls[0][1]).not.toBe(nonce)
  })

  it('retires polling when admission revokes the binding', async () => {
    const { state, owner, create } = fixture()
    state.admission = 'revoked'
    const receiver = create()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(receiver.getStatus().phase).toBe('revoked')
    state.admission = 'ready'
    receiver.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(owner.readPending).toHaveBeenCalledTimes(1)
    expect(owner.submitHint).not.toHaveBeenCalled()
  })

  it('halts safely when native binding validation becomes unverifiable', async () => {
    const { state, owner, create } = fixture()
    state.metadata = pending(0)
    const receiver = create()
    await vi.advanceTimersByTimeAsync(0)
    owner.isCurrent.mockImplementation(() => {
      throw new Error('native owner unavailable')
    })
    expect(() => receiver.notifyOwnerChanged()).not.toThrow()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(receiver.getStatus()).toMatchObject({
      phase: 'error',
      reason: 'binding-check-failed'
    })
    expect(owner.readPending).toHaveBeenCalledTimes(1)
    expect(owner.submitHint).not.toHaveBeenCalled()
  })

  it('does not let an observer exception interrupt persistence or submission', async () => {
    const { owner, create } = fixture()
    const receiver = create()
    receiver.subscribe(() => {
      throw new Error('UI failure')
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(owner.persistAttempt).toHaveBeenCalledTimes(1)
    expect(owner.submitHint).toHaveBeenCalledTimes(1)
  })
})

describe('pending schema', () => {
  it.each([
    null,
    [],
    { ...pending(), schema_version: 2 },
    { ...pending(), available: -1 },
    { ...pending(), leased: '0' },
    { ...pending(), pending: 3 },
    { ...pending(), pending: Number.MAX_SAFE_INTEGER + 1 }
  ])('rejects incompatible or inconsistent metadata: %j', (value) => {
    expect(() => parsePeerInboxPending(value)).toThrow('Invalid peer pending metadata')
  })

  it('returns counts only, without retaining message bodies or deployment metadata', () => {
    expect(parsePeerInboxPending({ ...pending(), body: 'unused', communication: {} })).toEqual(
      pending()
    )
  })
})
