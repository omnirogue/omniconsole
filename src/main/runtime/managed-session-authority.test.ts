import { describe, expect, it, vi } from 'vitest'
import type { PtyLaunchGateObservation, PtyLaunchGateReceipt } from '../../shared/pty-launch-gate'
import {
  createManagedSessionAuthority,
  inspectManagedSessionAuthority,
  type ManagedSessionAuthorityReaders,
  type ManagedSessionHook,
  type ManagedSessionTerminal
} from './managed-session-authority'
import type { ManagedSessionProcess } from './managed-session-process'

function fixture() {
  let now = 100_500
  const gate: PtyLaunchGateReceipt = {
    version: 1,
    state: 'closed',
    launchId: '00000000-0000-4000-8000-000000000001',
    gateId: '00000000-0000-4000-8000-000000000002',
    ptyId: 'pty-original',
    incarnationId: '00000000-0000-4000-8000-000000000003',
    pid: 401,
    processStartTimeMs: 99_000,
    processKind: 'pty-root',
    reportsChildExitStatus: true,
    exitObserver: 'macos-kqueue',
    startupCommandMode: 'exec'
  }
  const terminal: ManagedSessionTerminal = {
    handle: 'term-original',
    paneKey: 'pane-original',
    ptyId: gate.ptyId,
    incarnationId: gate.incarnationId,
    launchToken: 'private-launch-token'
  }
  let currentTerminal: ManagedSessionTerminal | null = { ...terminal }
  let observation: PtyLaunchGateObservation | null = {
    gateId: gate.gateId,
    ptyId: gate.ptyId,
    incarnationId: gate.incarnationId,
    pid: gate.pid,
    processStartTimeMs: gate.processStartTimeMs,
    startAcknowledgement: 'durable-original-release',
    state: 'live',
    source: 'macos-kqueue'
  }
  let hook: ManagedSessionHook | null = {
    provider: 'codex',
    providerSessionId: 'original-conversation',
    agentPid: 401,
    onAttachedPty: true,
    updatedAt: 100_100,
    observation: {
      origin: 'hook',
      authorityId: 'hook-authority',
      incarnation: 4,
      revision: 12,
      observedAt: 100_100,
      kind: 'transition'
    }
  }
  const process: ManagedSessionProcess = {
    pid: 401,
    startTimeMs: 99_000,
    rootPid: gate.pid,
    rootStartTimeMs: gate.processStartTimeMs,
    provider: 'codex',
    live: true
  }
  const input = {
    nativeOperationId: 'native-op',
    externalOperationId: 'managed-op',
    runtimeId: 'original-runtime',
    principal: { clerk_user_id: 'clerk-eve', employee_id: 'emp_eve' },
    provider: 'codex' as const,
    terminal,
    gate,
    createdAtMs: 100_000,
    startAcknowledgement: 'durable-original-release'
  }
  const authority = createManagedSessionAuthority(input)
  const readers: ManagedSessionAuthorityReaders = {
    runtimeId: 'original-runtime',
    now: () => now,
    readGate: vi.fn(async () => observation),
    readTerminal: () => currentTerminal,
    readHook: () => hook,
    readProcess: vi.fn(async (pid) =>
      pid === gate.pid
        ? { ...process, pid, startTimeMs: gate.processStartTimeMs }
        : { ...process, pid }
    )
  }
  return {
    authority,
    readers,
    gate,
    terminal,
    process,
    input,
    inspect: () => inspectManagedSessionAuthority(authority, readers),
    setNow: (value: number) => {
      now = value
    },
    setHook: (value: ManagedSessionHook | null) => {
      hook = value
    },
    getHook: () => hook!,
    setTerminal: (value: ManagedSessionTerminal | null) => {
      currentTerminal = value
    },
    setObservation: (value: PtyLaunchGateObservation | null) => {
      observation = value
    },
    getObservation: () => observation!
  }
}

describe('managed original-launch authority', () => {
  it('binds the exact principal, process and conversation without returning private state', async () => {
    const f = fixture()
    const result = await f.inspect()
    expect(result).toMatchObject({
      authority_verified: true,
      agent_live: true,
      state: 'live',
      phase: 'bound',
      provider_session_id: 'original-conversation',
      operation_id: 'native-op',
      managed_operation_id: 'managed-op',
      principal: f.input.principal
    })
    expect(JSON.stringify(result)).not.toContain(f.terminal.launchToken)
    f.input.principal.employee_id = 'emp_sal'
    f.input.gate.pid = 999
    expect(await f.inspect()).toMatchObject({
      authority_verified: true,
      principal: { employee_id: 'emp_eve' }
    })
  })

  it('allows only a short original-process startup grant before the first hook', async () => {
    const f = fixture()
    f.setHook(null)
    expect(await f.inspect()).toMatchObject({
      authority_verified: true,
      phase: 'startup',
      provider_session_id: null
    })
    f.setNow(160_001)
    expect(await f.inspect()).toMatchObject({ authority_verified: false, state: 'unverifiable' })
  })

  it('retains bound identity through a long wait without a new hook, then refuses a conflict', async () => {
    const f = fixture()
    const original = structuredClone(f.getHook())
    await f.inspect()
    f.setNow(2_500_000)
    f.setHook(null)
    expect(await f.inspect()).toMatchObject({
      authority_verified: true,
      phase: 'bound',
      provider_session_id: 'original-conversation'
    })
    f.setHook({
      ...original,
      providerSessionId: 'replacement',
      updatedAt: 2_500_000,
      observation: {
        ...original.observation,
        revision: original.observation.revision + 1,
        observedAt: 2_500_000
      }
    })
    expect(await f.inspect()).toMatchObject({
      authority_verified: false,
      reason: 'original_conversation_changed'
    })
    f.setHook(null)
    expect(await f.inspect()).toMatchObject({ authority_verified: false })
  })

  it('requires a recent initial hook even when an attached done row survives indefinitely', async () => {
    const f = fixture()
    f.setNow(200_000)
    expect(await f.inspect()).toMatchObject({
      authority_verified: false,
      reason: 'initial_provider_hook_stale'
    })
  })

  it('refuses a provider child even before the first conversation binding', async () => {
    const f = fixture()
    f.setHook({ ...f.getHook(), agentPid: 402 })
    expect(await f.inspect()).toMatchObject({
      authority_verified: false,
      provider_session_id: null
    })
  })

  it.each(['providerSessionId', 'agentPid', 'authorityId', 'incarnation', 'revision'] as const)(
    'permanently refuses a changed %s instead of retargeting',
    async (field) => {
      const f = fixture()
      const original = structuredClone(f.getHook())
      await f.inspect()
      const changed = structuredClone(original)
      if (field === 'providerSessionId') {
        changed.providerSessionId = 'replacement'
      } else if (field === 'agentPid') {
        changed.agentPid = 900
      } else if (field === 'authorityId') {
        changed.observation.authorityId = 'new-authority'
      } else if (field === 'incarnation') {
        changed.observation.incarnation++
      } else {
        changed.observation.revision--
      }
      f.setHook(changed)
      expect(await f.inspect()).toMatchObject({
        authority_verified: false,
        provider_session_id: 'original-conversation'
      })
      f.setHook(original)
      expect(await f.inspect()).toMatchObject({ authority_verified: false })
    }
  )

  it('accepts later observations only for the same frozen conversation', async () => {
    const f = fixture()
    await f.inspect()
    const hook = structuredClone(f.getHook())
    hook.observation.revision++
    f.setHook(hook)
    expect(await f.inspect()).toMatchObject({ authority_verified: true })
  })

  it('refuses PID reuse with a changed process birth', async () => {
    const f = fixture()
    await f.inspect()
    f.readers.readProcess = async () => ({ ...f.process, startTimeMs: 101_000 })
    expect(await f.inspect()).toMatchObject({
      authority_verified: false,
      reason: 'original_provider_process_changed'
    })
  })

  it.each(['launchToken', 'incarnationId', 'ptyId', 'paneKey', 'handle'] as const)(
    'refuses a changed terminal %s',
    async (field) => {
      const f = fixture()
      f.setTerminal({ ...f.terminal, [field]: 'replacement' })
      expect(await f.inspect()).toMatchObject({ authority_verified: false })
      expect(f.readers.readProcess).not.toHaveBeenCalled()
    }
  )

  it.each(['gateId', 'ptyId', 'incarnationId', 'pid', 'processStartTimeMs'] as const)(
    'refuses a gate observation for a different %s',
    async (field) => {
      const f = fixture()
      f.setObservation({
        ...f.getObservation(),
        [field]: typeof f.getObservation()[field] === 'number' ? 999 : 'replacement'
      } as PtyLaunchGateObservation)
      expect(await f.inspect()).toMatchObject({ authority_verified: false })
    }
  )

  it.each(['missing', 'unreleased', 'wrong-ack', 'unverifiable'] as const)(
    'does not infer live authority from %s gate evidence',
    async (kind) => {
      const f = fixture()
      if (kind === 'missing') {
        f.setObservation(null)
      } else if (kind === 'unverifiable') {
        f.setObservation({ ...f.getObservation(), state: 'unverifiable', reason: 'lost contact' })
      } else {
        f.setObservation({
          ...f.getObservation(),
          startAcknowledgement: kind === 'unreleased' ? null : 'other-release'
        })
      }
      expect(await f.inspect()).toMatchObject({
        authority_verified: false,
        agent_live: null,
        state: 'unverifiable'
      })
    }
  )

  it('keeps physical exit final even if the pane later has a live agent', async () => {
    const f = fixture()
    const live = f.getObservation()
    f.setObservation({
      ...live,
      state: 'exited',
      source: 'macos-kqueue',
      waitStatus: 0,
      exitCode: 0,
      signal: null,
      observedAtMs: 100_400
    })
    expect(await f.inspect()).toMatchObject({
      authority_verified: false,
      agent_live: false,
      state: 'exited'
    })
    f.setObservation(live)
    expect(await f.inspect()).toMatchObject({ authority_verified: false, state: 'exited' })
  })

  it.each(['osc', 'snapshot', 'prelaunch', 'future', 'detached', 'wrong-provider'] as const)(
    'refuses %s hook evidence',
    async (kind) => {
      const f = fixture()
      const hook = structuredClone(f.getHook())
      if (kind === 'osc') {
        hook.observation.origin = 'osc'
      }
      if (kind === 'snapshot') {
        hook.observation.kind = 'snapshot'
      }
      if (kind === 'prelaunch') {
        hook.observation.observedAt = 99_000
      }
      if (kind === 'future') {
        hook.observation.observedAt = 200_000
      }
      if (kind === 'detached') {
        hook.onAttachedPty = false
      }
      if (kind === 'wrong-provider') {
        hook.provider = 'claude'
      }
      f.setHook(hook)
      expect(await f.inspect()).toMatchObject({
        authority_verified: false,
        provider_session_id: null
      })
    }
  )

  it('refuses a hook session different from the host-seeded Claude session', async () => {
    const f = fixture()
    const authority = createManagedSessionAuthority({
      ...f.input,
      seededProviderSessionId: 'expected-session'
    })
    expect(await inspectManagedSessionAuthority(authority, f.readers)).toMatchObject({
      authority_verified: false
    })
  })

  it('refuses a replaced pane during asynchronous process inspection', async () => {
    const f = fixture()
    f.readers.readProcess = async () => {
      f.setTerminal({ ...f.terminal, incarnationId: 'replacement' })
      return f.process
    }
    expect(await f.inspect()).toMatchObject({
      authority_verified: false,
      provider_session_id: 'original-conversation'
    })
  })

  it('freezes the proven first hook and never retargets a replacement during inspection', async () => {
    const f = fixture()
    f.readers.readProcess = async () => {
      f.setHook({ ...f.getHook(), providerSessionId: 'replacement' })
      return f.process
    }
    expect(await f.inspect()).toMatchObject({
      authority_verified: false,
      provider_session_id: 'original-conversation'
    })
    expect(await f.inspect()).toMatchObject({
      authority_verified: false,
      provider_session_id: 'original-conversation'
    })
  })

  it('serializes concurrent inspections so they cannot bind two different sessions', async () => {
    const f = fixture()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    f.readers.readProcess = vi.fn(async () => {
      await held
      return f.process
    })
    const first = f.inspect()
    const second = f.inspect()
    release()
    expect((await Promise.all([first, second])).every((r) => r.authority_verified)).toBe(true)
    expect(f.readers.readProcess).toHaveBeenCalledTimes(2)
  })

  it('fails closed on reader errors, runtime restart and forged authority objects', async () => {
    const f = fixture()
    f.readers.readGate = async () => {
      throw new Error('private error details')
    }
    expect(await f.inspect()).toMatchObject({
      authority_verified: false,
      reason: 'authority_evidence_unavailable'
    })
    f.readers.runtimeId = 'restarted-runtime'
    expect(await f.inspect()).toMatchObject({ authority_verified: false })
    await expect(
      inspectManagedSessionAuthority({ nativeOperationId: 'native-op' }, f.readers)
    ).rejects.toThrow('managed_session_authority_missing')
  })
})
