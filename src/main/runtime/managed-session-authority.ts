import { isPtyLaunchGateReceipt } from '../../shared/pty-launch-gate'
import type {
  CreateInput,
  PrivateAuthority,
  ManagedSessionAuthority,
  ManagedSessionAuthorityInspection,
  ManagedSessionAuthorityReaders,
  ManagedSessionHook,
  ManagedSessionTerminal
} from './managed-session-authority-contract'
export type {
  ManagedSessionPrincipal,
  ManagedSessionAuthority,
  ManagedSessionAuthorityInspection,
  ManagedSessionAuthorityReaders,
  ManagedSessionHook,
  ManagedSessionTerminal
} from './managed-session-authority-contract'
const authorities = new WeakMap<ManagedSessionAuthority, PrivateAuthority>()
const STARTUP_MS = 60_000

export function createManagedSessionAuthority(input: CreateInput): ManagedSessionAuthority {
  if (
    !isPtyLaunchGateReceipt(input.gate) ||
    input.gate.exitObserver !== 'macos-kqueue' ||
    input.gate.startupCommandMode !== 'exec' ||
    !input.gate.reportsChildExitStatus ||
    !input.nativeOperationId ||
    !input.externalOperationId ||
    !input.runtimeId ||
    !input.principal.clerk_user_id ||
    !input.principal.employee_id ||
    !input.startAcknowledgement ||
    !input.terminal.launchToken ||
    !input.terminal.handle ||
    !input.terminal.paneKey ||
    input.terminal.ptyId !== input.gate.ptyId ||
    input.terminal.incarnationId !== input.gate.incarnationId ||
    !Number.isSafeInteger(input.createdAtMs) ||
    input.createdAtMs < input.gate.processStartTimeMs ||
    !['claude', 'codex'].includes(input.provider)
  ) {
    throw new Error('managed_session_authority_unverifiable')
  }
  const authority = Object.freeze({ nativeOperationId: input.nativeOperationId })
  authorities.set(authority, {
    input: {
      ...input,
      principal: { ...input.principal },
      terminal: { ...input.terminal },
      gate: { ...input.gate }
    },
    bound: null,
    revoked: null,
    exited: false,
    pending: Promise.resolve()
  })
  return authority
}

function receipt(
  state: PrivateAuthority,
  verified: boolean,
  reason: string
): ManagedSessionAuthorityInspection {
  const { input, bound } = state
  return {
    authority_verified: verified,
    agent_live: state.exited ? false : verified ? true : null,
    operation_id: input.nativeOperationId,
    managed_operation_id: input.externalOperationId,
    principal: { ...input.principal },
    provider: input.provider,
    terminal_handle: input.terminal.handle,
    pane_key: input.terminal.paneKey,
    pty_incarnation: `${input.gate.ptyId}:${input.gate.incarnationId}`,
    provider_session_id: bound?.hook.providerSessionId ?? null,
    state: state.exited ? 'exited' : verified ? 'live' : 'unverifiable',
    phase: bound ? 'bound' : 'startup',
    reason
  }
}

function terminalMatches(input: CreateInput, current: ManagedSessionTerminal | null): boolean {
  return (
    current !== null &&
    (Object.keys(input.terminal) as (keyof ManagedSessionTerminal)[]).every(
      (key) => current[key] === input.terminal[key]
    )
  )
}

async function originalLive(
  state: PrivateAuthority,
  readers: ManagedSessionAuthorityReaders
): Promise<boolean> {
  const { input } = state
  if (
    readers.runtimeId !== input.runtimeId ||
    !terminalMatches(input, readers.readTerminal(input.terminal.handle))
  ) {
    state.revoked = 'original_terminal_changed'
    return false
  }
  const observed = await readers.readGate(input.gate)
  if (!observed) {
    return false
  }
  if (
    observed.gateId !== input.gate.gateId ||
    observed.ptyId !== input.gate.ptyId ||
    observed.incarnationId !== input.gate.incarnationId ||
    observed.pid !== input.gate.pid ||
    observed.processStartTimeMs !== input.gate.processStartTimeMs
  ) {
    state.revoked = 'original_process_changed'
    return false
  }
  if (
    observed.state === 'unverifiable' ||
    observed.source !== 'macos-kqueue' ||
    observed.startAcknowledgement !== input.startAcknowledgement
  ) {
    return false
  }
  if (observed.state === 'exited') {
    state.exited = true
    return false
  }
  if (!terminalMatches(input, readers.readTerminal(input.terminal.handle))) {
    state.revoked = 'original_terminal_changed'
    return false
  }
  return true
}

function freshHook(input: CreateInput, hook: ManagedSessionHook, now: number): boolean {
  const observation = hook.observation
  return (
    hook.provider === input.provider &&
    Boolean(hook.providerSessionId) &&
    Number.isSafeInteger(hook.agentPid) &&
    hook.agentPid > 0 &&
    hook.onAttachedPty === true &&
    observation?.origin === 'hook' &&
    observation.kind !== 'snapshot' &&
    Boolean(observation.authorityId) &&
    Number.isSafeInteger(observation.incarnation) &&
    observation.incarnation >= 0 &&
    Number.isSafeInteger(observation.revision) &&
    observation.revision >= 0 &&
    Number.isFinite(observation.observedAt) &&
    observation.observedAt >= input.createdAtMs &&
    observation.observedAt <= now &&
    Number.isFinite(hook.updatedAt) &&
    hook.updatedAt >= input.createdAtMs &&
    hook.updatedAt <= now
  )
}

function sameConversation(left: ManagedSessionHook, right: ManagedSessionHook): boolean {
  return (
    left.provider === right.provider &&
    left.providerSessionId === right.providerSessionId &&
    left.agentPid === right.agentPid &&
    left.observation.authorityId === right.observation.authorityId &&
    left.observation.incarnation === right.observation.incarnation &&
    right.observation.revision >= left.observation.revision
  )
}

async function inspectOnce(
  state: PrivateAuthority,
  readers: ManagedSessionAuthorityReaders
): Promise<ManagedSessionAuthorityInspection> {
  if (state.revoked || state.exited) {
    return receipt(state, false, state.revoked ?? 'original_process_exited')
  }
  const { input } = state
  const now = (readers.now ?? Date.now)()
  if (!Number.isFinite(now) || now < input.createdAtMs || !(await originalLive(state, readers))) {
    return receipt(state, false, state.revoked ?? 'original_process_unverifiable')
  }
  const reported = readers.readHook(input.terminal.handle)
  const hook = reported
    ? { ...reported, observation: { ...reported.observation } }
    : (state.bound?.hook ?? null)
  if (!hook) {
    if (state.bound || now - input.createdAtMs > STARTUP_MS) {
      return receipt(state, false, 'provider_identity_unverifiable')
    }
    // Before hooks initialize, only the original exec process has the short startup grant.
    const process = await readers.readProcess(input.gate.pid)
    const live =
      process?.pid === input.gate.pid &&
      process.startTimeMs > 0 &&
      process.rootPid === input.gate.pid &&
      process.rootStartTimeMs === input.gate.processStartTimeMs &&
      process.provider === input.provider &&
      process.live === true
    if (
      !live ||
      !(await originalLive(state, readers)) ||
      (readers.now ?? Date.now)() - input.createdAtMs > STARTUP_MS ||
      readers.readHook(input.terminal.handle)
    ) {
      return receipt(state, false, 'startup_process_unverifiable')
    }
    return receipt(state, true, 'original_process_startup')
  }
  if (!freshHook(input, hook, now)) {
    return receipt(state, false, 'provider_hook_unverifiable')
  }
  if (!state.bound && now - hook.observation.observedAt > STARTUP_MS) {
    return receipt(state, false, 'initial_provider_hook_stale')
  }
  if (
    (input.seededProviderSessionId && hook.providerSessionId !== input.seededProviderSessionId) ||
    (state.bound && !sameConversation(state.bound.hook, hook))
  ) {
    state.revoked = 'original_conversation_changed'
    return receipt(state, false, state.revoked)
  }
  const process = await readers.readProcess(hook.agentPid)
  if (
    !process ||
    process.live !== true ||
    process.pid !== hook.agentPid ||
    hook.agentPid !== input.gate.pid ||
    process.provider !== input.provider ||
    process.rootPid !== input.gate.pid ||
    process.rootStartTimeMs !== input.gate.processStartTimeMs ||
    !Number.isSafeInteger(process.startTimeMs) ||
    process.startTimeMs <= 0
  ) {
    return receipt(state, false, 'provider_process_unverifiable')
  }
  if (state.bound && process.startTimeMs !== state.bound.process.startTimeMs) {
    state.revoked = 'original_provider_process_changed'
    return receipt(state, false, state.revoked)
  }
  // Freeze proven identity before the final async fence; uncertainty must not permit rebinding.
  state.bound ??= {
    hook: { ...hook, observation: { ...hook.observation } },
    process: { ...process }
  }
  if (!(await originalLive(state, readers))) {
    return receipt(state, false, state.revoked ?? 'original_process_unverifiable')
  }
  const after = readers.readHook(input.terminal.handle) ?? state.bound.hook
  if (after && !sameConversation(hook, after)) {
    state.revoked = 'original_conversation_changed'
    return receipt(state, false, state.revoked)
  }
  if (
    !after ||
    !freshHook(input, after, (readers.now ?? Date.now)()) ||
    !sameConversation(hook, after)
  ) {
    return receipt(state, false, 'provider_hook_changed_during_inspection')
  }
  state.bound = {
    hook: { ...after, observation: { ...after.observation } },
    process: { ...process }
  }
  return receipt(state, true, 'original_conversation_live')
}

export function inspectManagedSessionAuthority(
  authority: ManagedSessionAuthority,
  readers: ManagedSessionAuthorityReaders
): Promise<ManagedSessionAuthorityInspection> {
  const state = authorities.get(authority)
  if (!state) {
    return Promise.reject(new Error('managed_session_authority_missing'))
  }
  const inspection = state.pending.then(async () => {
    try {
      return await inspectOnce(state, readers)
    } catch {
      return receipt(state, false, 'authority_evidence_unavailable')
    }
  })
  state.pending = inspection.then(
    () => undefined,
    () => undefined
  )
  return inspection
}
