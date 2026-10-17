import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../shared/agent-session-lease-adjudication'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import type { NativePeerInboxBinding } from '../../shared/native-peer-inbox-binding'
import {
  replaceNativePeerInboxRecord,
  type NativePeerInboxReplacement
} from './native-peer-inbox-record'
import { NativePeerInboxOwner } from './native-peer-inbox-owner'

const mocks = vi.hoisted(() => ({
  pending: vi.fn(),
  queue: vi.fn(),
  probe: vi.fn(),
  host: vi.fn(),
  boundSession: vi.fn()
}))
vi.mock('./peer-inbox-pending-client', () => ({ readPeerInboxPending: mocks.pending }))
vi.mock('./peer-inbox-codex-queue', () => ({ queuePeerInboxCodexHint: mocks.queue }))
vi.mock('./agent-session-process-identity-probe', () => ({
  probeAgentSessionProcessIdentity: mocks.probe
}))
vi.mock('./agent-session-pty-write-gate', () => ({
  agentSessionPtyWriteGate: { boundSessionId: mocks.boundSession }
}))
vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: mocks.host
}))

const THREAD = '11111111-1111-4111-8111-111111111111'
const ITEM = '22222222-2222-4222-8222-222222222222'
const TERMINAL = 'terminal:1'
const owners: NativePeerInboxOwner[] = []
const counts = (available = 1) => ({
  schema_version: 1,
  pending: available,
  available,
  leased: 0,
  blocked: 0
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture() {
  const record = agentSessionRecordFixture()
  record.provider = 'codex'
  record.accountHome = { variable: 'CODEX_HOME', path: '/profiles/codex-sal' }
  record.providerHandleChain[0].handle = { provider: 'codex', threadId: THREAD }
  const state = { record, pending: counts() }
  const binding: NativePeerInboxBinding = {
    key: 'caller-key-is-not-authority',
    peerSessionId: 'peer-session-1',
    employeeId: 'employee-1',
    companyId: 'company-1',
    projectId: 'project-1',
    taskId: 'task-1',
    apiOrigin: 'https://hub.example.test',
    tokenFile: '/private/peer/session.token',
    runtimeId: 'runtime-1',
    terminalHandle: TERMINAL,
    ptyId: 'pty-1',
    incarnation: 'incarnation-1',
    executionHostId: 'local',
    workspaceId: 'workspace-1',
    paneKey: 'pane-1',
    provider: 'codex',
    providerSessionId: THREAD,
    nativeSessionId: record.sessionId,
    runtimeFence: 7,
    wakeConsent: true
  }
  const store = {
    getRecord: vi.fn((id: string) =>
      id === state.record.sessionId ? structuredClone(state.record) : null
    ),
    replacePeerInbox: vi.fn(async (next: NativePeerInboxReplacement) => {
      state.record = replaceNativePeerInboxRecord(state.record, next)
    })
  }
  const stopExit = vi.fn()
  let exit = () => {}
  const runtime = {
    getRuntimeId: vi.fn(() => binding.runtimeId),
    getTerminalProcessIncarnation: vi.fn(() => binding.incarnation),
    getTerminalPaneKey: vi.fn(() => binding.paneKey),
    getTerminalWorktreeIdForPaneKey: vi.fn(() => binding.workspaceId),
    resolveLiveLeafForHandle: vi.fn(() => ({ ptyId: binding.ptyId })),
    subscribeToPtyExit: vi.fn((_ptyId: string, listener: () => void) => {
      exit = listener
      return stopExit
    }),
    sendTerminalAgentPrompt: vi.fn(() => {
      throw new Error('PTY writes are forbidden')
    })
  }
  mocks.host.mockReturnValue({ deps: { store } })
  mocks.boundSession.mockReturnValue(record.sessionId)
  mocks.pending.mockImplementation(async () => state.pending)
  mocks.probe.mockResolvedValue({ outcome: 'identity-matched', matchedOn: ['process-start-time'] })
  mocks.queue.mockResolvedValue({ status: 'queued', nativeItemId: ITEM })
  const create = () => {
    const owner = new NativePeerInboxOwner(runtime)
    owners.push(owner)
    return owner
  }
  return { state, binding, store, runtime, stopExit, exit: () => exit(), create, owner: create() }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(35_000)
})
afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.stop(TERMINAL)
  }
  vi.useRealTimers()
})

describe('native peer inbox owner with canonical pending and Codex queue', () => {
  it('persists an attempt before queuing into the exact native thread and profile', async () => {
    const { owner, binding, state, store, runtime } = fixture()
    const status = await owner.bind(binding)
    expect(status.bindingKey).toMatch(/^[a-f0-9]{64}$/)
    await vi.advanceTimersByTimeAsync(0)
    const attempt = state.record.peerInbox?.attempt
    expect(attempt).toMatchObject({ outcome: 'submitted', nativeItemId: ITEM })
    expect(mocks.queue).toHaveBeenCalledTimes(1)
    expect(mocks.queue).toHaveBeenCalledWith(
      expect.objectContaining({
        record: expect.objectContaining({
          sessionId: binding.nativeSessionId,
          accountHome: { variable: 'CODEX_HOME', path: '/profiles/codex-sal' },
          peerInbox: expect.objectContaining({
            attempt: { nonce: attempt?.nonce, outcome: 'uncertain' }
          })
        }),
        threadId: THREAD,
        correlationNonce: attempt?.nonce,
        hint: expect.stringContaining(attempt!.nonce)
      })
    )
    expect(store.replacePeerInbox.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.queue.mock.invocationCallOrder[0]
    )
    expect(mocks.probe).toHaveBeenCalledWith({ identity: state.record.lease.ownerProcess })
    expect(runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    expect(owner.status(TERMINAL)?.phase).toBe('awaiting-completion')
  })

  it('finds pending work after an already idle native session was bound', async () => {
    const { owner, binding, state } = fixture()
    state.pending = counts(0)
    await owner.bind(binding)
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.queue).not.toHaveBeenCalled()
    state.pending = counts(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(mocks.queue).toHaveBeenCalledTimes(1)
  })

  it('clears only the native attempt after the exact model completion receipt', async () => {
    const { owner, binding, state } = fixture()
    const status = await owner.bind(binding)
    await vi.advanceTimersByTimeAsync(0)
    const nonce = state.record.peerInbox!.attempt!.nonce
    state.pending = counts(0)
    await owner.complete(TERMINAL, status.bindingKey, nonce)
    await vi.advanceTimersByTimeAsync(0)
    expect(state.record.peerInbox?.attempt).toBeNull()
    expect(owner.status(TERMINAL)?.phase).toBe('idle')
    expect(mocks.queue).toHaveBeenCalledTimes(1)
    expect(mocks.pending.mock.calls.every((call) => call[1].signal instanceof AbortSignal)).toBe(
      true
    )
  })

  it('does not clear a native attempt using another binding key or nonce', async () => {
    const { owner, binding, state } = fixture()
    const status = await owner.bind(binding)
    await vi.advanceTimersByTimeAsync(0)
    const nonce = state.record.peerInbox!.attempt!.nonce
    await expect(owner.complete(TERMINAL, 'different-key', nonce)).rejects.toThrow(
      'peer_inbox_binding_changed'
    )
    await expect(owner.complete(TERMINAL, status.bindingKey, 'different-nonce')).rejects.toThrow(
      'peer_inbox_attempt_changed'
    )
    expect(state.record.peerInbox?.attempt?.outcome).toBe('submitted')
  })

  it.each([
    { runtimeFence: 8 },
    { provider: 'claude' },
    { providerSessionId: 'different-thread' },
    { runtimeId: 'different-runtime' },
    { ptyId: 'different-pty' },
    { nativeSessionId: 'different-session' }
  ] satisfies Partial<NativePeerInboxBinding>[])(
    'rejects a mismatched native mapping before persisting or queuing: %j',
    async (overrides) => {
      const { owner, binding, store } = fixture()
      await expect(owner.bind({ ...binding, ...overrides })).rejects.toThrow()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(store.replacePeerInbox).not.toHaveBeenCalled()
      expect(mocks.queue).not.toHaveBeenCalled()
    }
  )

  it.each(['profile', 'fence', 'provider', 'scope'] as const)(
    'does not queue after the pinned %s changes during a process probe',
    async (change) => {
      const { owner, binding, state } = fixture()
      const proof = deferred<AgentSessionOwnerProbe>()
      mocks.probe.mockReturnValueOnce(proof.promise)
      await owner.bind(binding)
      await vi.advanceTimersByTimeAsync(0)
      if (change === 'profile') {
        state.record.accountHome.path = '/profiles/someone-else'
      }
      if (change === 'fence') {
        state.record.lease.runtimeFence++
      }
      if (change === 'provider') {
        state.record.provider = 'claude'
      }
      if (change === 'scope') {
        state.record.peerInbox!.binding.projectId = 'different-project'
      }
      proof.resolve({ outcome: 'identity-matched', matchedOn: ['process-start-time'] })
      await vi.advanceTimersByTimeAsync(5_001)
      expect(mocks.queue).not.toHaveBeenCalled()
      expect(owner.status(TERMINAL)?.phase).toBe('revoked')
    }
  )

  it.each([
    { outcome: 'pid-absent' },
    { outcome: 'identity-mismatch', field: 'process-start-time' },
    { outcome: 'indeterminate', reason: 'identity is unavailable' }
  ] satisfies AgentSessionOwnerProbe[])(
    'does not queue without process identity proof: %j',
    async (proof) => {
      const { owner, binding, state } = fixture()
      mocks.probe.mockResolvedValue(proof)
      await owner.bind(binding)
      await vi.advanceTimersByTimeAsync(0)
      expect(mocks.queue).not.toHaveBeenCalled()
      expect(state.record.peerInbox?.attempt).toBeNull()
    }
  )

  it('revalidates the terminal incarnation after the process probe', async () => {
    const { owner, binding, runtime } = fixture()
    const proof = deferred<AgentSessionOwnerProbe>()
    mocks.probe.mockReturnValueOnce(proof.promise)
    await owner.bind(binding)
    await vi.advanceTimersByTimeAsync(0)
    runtime.getTerminalProcessIncarnation.mockReturnValue('incarnation-2')
    proof.resolve({ outcome: 'identity-matched', matchedOn: ['process-start-time'] })
    await vi.advanceTimersByTimeAsync(5_001)
    expect(mocks.queue).not.toHaveBeenCalled()
    expect(owner.status(TERMINAL)?.phase).toBe('revoked')
  })

  it.each(['uncertain', 'throw'] as const)(
    'does not enqueue again after %s acceptance, including owner restart',
    async (outcome) => {
      const { owner, binding, state, create } = fixture()
      if (outcome === 'uncertain') {
        mocks.queue.mockResolvedValue({ status: 'uncertain', reason: 'queue-unconfirmed' })
      } else {
        mocks.queue.mockRejectedValue(new Error('lost response'))
      }
      await owner.bind(binding)
      await vi.advanceTimersByTimeAsync(15_000)
      const nonce = state.record.peerInbox!.attempt!.nonce
      expect(mocks.queue).toHaveBeenCalledTimes(1)
      expect(state.record.peerInbox?.attempt?.outcome).toBe('uncertain')
      owner.stop(TERMINAL)
      const restarted = create()
      await restarted.bind(binding)
      await vi.advanceTimersByTimeAsync(15_000)
      expect(mocks.queue).toHaveBeenCalledTimes(1)
      expect(restarted.status(TERMINAL)).toMatchObject({ phase: 'uncertain', attemptNonce: nonce })
    }
  )

  it('records a definite not-started queue result before clearing the attempt', async () => {
    const { owner, binding, state } = fixture()
    mocks.queue.mockResolvedValue({ status: 'not-started', reason: 'command-unavailable' })
    await owner.bind(binding)
    await vi.advanceTimersByTimeAsync(0)
    expect(state.record.peerInbox?.attempt).toBeNull()
    expect(owner.status(TERMINAL)?.phase).toBe('idle')
  })

  it('does not replace an early model completion with a late queue receipt', async () => {
    const { owner, binding, state } = fixture()
    mocks.queue.mockImplementationOnce(async () => {
      const receipt = state.record.peerInbox!
      state.pending = counts(0)
      await owner.complete(TERMINAL, receipt.binding.key, receipt.attempt!.nonce)
      return { status: 'queued', nativeItemId: ITEM }
    })
    await owner.bind(binding)
    await vi.advanceTimersByTimeAsync(1)
    expect(state.record.peerInbox?.attempt).toBeNull()
    expect(mocks.queue).toHaveBeenCalledTimes(1)
  })

  it.each(
    ['probe', 'queue'].flatMap((source) =>
      ['settle', 'clear'].flatMap((stage) =>
        [false, true].map((committed) => ({ source, stage, committed }))
      )
    )
  )(
    'recovers a known no-enqueue receipt after storage failure: %j',
    async ({ source, stage, committed }) => {
      const { owner, binding, state, store } = fixture()
      let fail = true
      store.replacePeerInbox.mockImplementation(async (change) => {
        const clearing = change.next.attempt === null && state.record.peerInbox?.attempt != null
        const settling = change.next.attempt?.outcome === 'not-written'
        if (fail && (stage === 'clear' ? clearing : settling)) {
          fail = false
          if (committed) {
            state.record = replaceNativePeerInboxRecord(state.record, change)
          }
          throw new Error('storage acknowledgement unavailable')
        }
        state.record = replaceNativePeerInboxRecord(state.record, change)
      })
      if (source === 'probe') {
        mocks.probe.mockImplementationOnce(async () => {
          state.pending = counts(0)
          return { outcome: 'pid-absent' }
        })
      } else {
        mocks.queue.mockImplementationOnce(async () => {
          state.pending = counts(0)
          return { status: 'not-started', reason: 'command-unavailable' }
        })
      }
      await owner.bind(binding)
      await vi.advanceTimersByTimeAsync(0)
      expect(fail).toBe(false)
      expect(owner.status(TERMINAL)?.phase).toBe('uncertain')
      await vi.advanceTimersByTimeAsync(20_000)
      expect(state.record.peerInbox?.attempt).toBeNull()
      expect(owner.status(TERMINAL)?.phase).toBe('idle')
      expect(mocks.queue).toHaveBeenCalledTimes(source === 'probe' ? 0 : 1)
    }
  )

  it.each([false, true])(
    'recovers a failed initial intent without duplicate enqueue (committed=%s)',
    async (committed) => {
      const { owner, binding, state, store } = fixture()
      let failedNonce: string | undefined
      store.replacePeerInbox.mockImplementation(async (change) => {
        if (!failedNonce && change.next.attempt?.outcome === 'uncertain') {
          failedNonce = change.next.attempt.nonce
          if (committed) {
            state.record = replaceNativePeerInboxRecord(state.record, change)
          }
          throw new Error('intent write failed')
        }
        state.record = replaceNativePeerInboxRecord(state.record, change)
      })
      await owner.bind(binding)
      await vi.advanceTimersByTimeAsync(0)
      expect(failedNonce).toBeTruthy()
      expect(mocks.queue).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(20_000)
      expect(mocks.queue).toHaveBeenCalledTimes(1)
      expect(mocks.queue.mock.calls[0][0].correlationNonce).not.toBe(failedNonce)
      expect(state.record.peerInbox?.attempt?.outcome).toBe('submitted')
    }
  )

  it('does not recreate process-local no-write proof from an uncertain receipt on restart', async () => {
    const { owner, binding, state, store, create } = fixture()
    let failed = false
    store.replacePeerInbox.mockImplementation(async (change) => {
      state.record = replaceNativePeerInboxRecord(state.record, change)
      if (!failed && change.next.attempt?.outcome === 'uncertain') {
        failed = true
        throw new Error('intent acknowledgement lost')
      }
    })
    await owner.bind(binding)
    await vi.advanceTimersByTimeAsync(0)
    const nonce = state.record.peerInbox!.attempt!.nonce
    owner.stop(TERMINAL)
    const restarted = create()
    await restarted.bind(binding)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(mocks.queue).not.toHaveBeenCalled()
    expect(restarted.status(TERMINAL)).toMatchObject({ phase: 'uncertain', attemptNonce: nonce })
    expect(state.record.peerInbox?.attempt?.outcome).toBe('uncertain')
  })

  it('holds a pending hint when this binding has no wake consent', async () => {
    const { owner, binding } = fixture()
    await owner.bind({ ...binding, wakeConsent: false })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(owner.status(TERMINAL)?.phase).toBe('consent')
    expect(mocks.probe).not.toHaveBeenCalled()
    expect(mocks.queue).not.toHaveBeenCalled()
  })

  it('disposes and aborts the receiver when its exact PTY exits', async () => {
    const { owner, binding, state, exit, stopExit } = fixture()
    const proof = deferred<AgentSessionOwnerProbe>()
    mocks.probe.mockReturnValueOnce(proof.promise)
    await owner.bind(binding)
    await vi.advanceTimersByTimeAsync(0)
    const signal = mocks.pending.mock.calls[0][1].signal as AbortSignal
    exit()
    expect(signal.aborted).toBe(true)
    expect(stopExit).toHaveBeenCalledTimes(1)
    proof.resolve({ outcome: 'identity-matched', matchedOn: ['process-start-time'] })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(owner.status(TERMINAL)).toBeNull()
    expect(mocks.queue).not.toHaveBeenCalled()
    expect(state.record.peerInbox).toBeDefined()
  })
})
