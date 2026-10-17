import type { AgentLaunchPreferences } from '../../../../shared/agent-session-host-authority'
import { checkAgentLaunchPreferences } from '../../../../shared/agent-launch-preference-check'
import {
  OMP_OPENROUTER_ROUTING_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { OrchestrationError } from '../../orchestration/orchestration-error'

export type OrchestrationWorkerLaunchSelection = {
  agent: TuiAgent | null
  model: string | null
  effort: string | null
  permissionMode?: 'yolo' | 'read-only'
  openrouterCandidates?: string[]
}

export type OrchestrationWorkerLaunchReceipt = {
  requested: OrchestrationWorkerLaunchSelection
  effective: OrchestrationWorkerLaunchSelection | null
  /** Older hosts omit provenance; effective has always acknowledged launch arguments. */
  effectiveSource?: 'resolved-launch-arguments' | 'legacy-acknowledgement'
}

export function createWorkerLaunchReceipt(args: {
  agent: TuiAgent | null
  model?: string
  effort?: string
  openrouterCandidates?: string[]
  permissionMode?: 'yolo' | 'read-only'
}): OrchestrationWorkerLaunchReceipt {
  const selection = {
    agent: args.agent,
    model: args.model ?? null,
    ...(args.openrouterCandidates !== undefined
      ? { openrouterCandidates: [...args.openrouterCandidates] }
      : {}),
    effort: args.effort ?? null,
    ...(args.permissionMode ? { permissionMode: args.permissionMode } : {})
  }
  return {
    requested: selection,
    effective: { ...selection },
    effectiveSource: 'resolved-launch-arguments'
  }
}

export function createPendingWorkerLaunchReceipt(args: {
  agent: TuiAgent | null
  model?: string
  effort?: string
  openrouterCandidates?: string[]
  permissionMode?: 'yolo' | 'read-only'
}): OrchestrationWorkerLaunchReceipt {
  return {
    requested: {
      agent: args.agent,
      model: args.model ?? null,
      ...(args.openrouterCandidates !== undefined
        ? { openrouterCandidates: [...args.openrouterCandidates] }
        : {}),
      effort: args.effort ?? null,
      ...(args.permissionMode ? { permissionMode: args.permissionMode } : {})
    },
    effective: null,
    effectiveSource: 'resolved-launch-arguments'
  }
}

export function resolveWorkerLaunchPreferences(args: {
  agent: TuiAgent
  model?: string
  effort?: string
  openrouterCandidates?: string[]
  permissionMode?: 'yolo' | 'read-only'
}): {
  preferences: AgentLaunchPreferences | undefined
  receipt: OrchestrationWorkerLaunchReceipt
} {
  if (args.effort?.trim() && !args.model?.trim()) {
    throw new OrchestrationError('invalid_argument', '--effort requires --model.')
  }
  const check = checkAgentLaunchPreferences(args.agent, {
    ...(args.model ? { model: args.model } : {}),
    ...(args.openrouterCandidates !== undefined
      ? { openrouterCandidates: args.openrouterCandidates }
      : {}),
    ...(args.effort ? { effort: args.effort } : {})
  })
  if (!check.ok) {
    throw new OrchestrationError(check.code, check.message)
  }
  if (args.permissionMode && !['claude', 'codex', 'grok'].includes(args.agent)) {
    throw new OrchestrationError(
      'invalid_argument',
      `Explicit worker permission mode is unsupported for ${args.agent}.`
    )
  }
  const preferences: AgentLaunchPreferences | undefined = args.permissionMode
    ? { ...check.preferences, permissionMode: args.permissionMode }
    : check.preferences
  if (!preferences) {
    return {
      preferences: undefined,
      receipt: createWorkerLaunchReceipt({ agent: args.agent, permissionMode: args.permissionMode })
    }
  }
  return {
    preferences,
    receipt: createWorkerLaunchReceipt({ agent: args.agent, ...preferences })
  }
}

export function assertWorkerLaunchPreferencesCreateTerminal(args: {
  terminal?: string
  model?: string
  effort?: string
  openrouterCandidates?: string[]
  permissionMode?: 'yolo' | 'read-only'
}): void {
  if (args.terminal && (args.model || args.effort || args.permissionMode)) {
    throw new OrchestrationError(
      'invalid_argument',
      '--model, --effort and --permission-mode cannot be applied when reusing an existing terminal.'
    )
  }
}

export function assertWorkerLaunchPreferencesRuntimeSupported(args: {
  model?: string
  effort?: string
  openrouterCandidates?: string[]
  capabilities?: readonly string[]
  serverName: string
  agent?: string
}): void {
  if (
    (args.openrouterCandidates !== undefined || (args.agent === 'omp' && args.model)) &&
    !args.capabilities?.includes(OMP_OPENROUTER_ROUTING_RUNTIME_CAPABILITY)
  ) {
    throw new OrchestrationError(
      'capability_unsupported',
      'The execution host cannot preserve the exact OMP route.'
    )
  }
  if (
    (args.model || args.effort) &&
    !args.capabilities?.includes(ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY)
  ) {
    throw new OrchestrationError(
      'capability_unsupported',
      `Connected server ${args.serverName} does not support worker model or effort overrides.`
    )
  }
}

export function resolveFederatedWorkerLaunchReceipt(
  remote: OrchestrationWorkerLaunchReceipt | undefined,
  requested: OrchestrationWorkerLaunchReceipt,
  remoteReady: boolean
): OrchestrationWorkerLaunchReceipt {
  if (
    requested.requested.agent === 'omp' &&
    (requested.requested.model || requested.requested.openrouterCandidates !== undefined) &&
    (!remote ||
      !sameOmpSelection(remote.requested, requested.requested) ||
      (remoteReady && !sameOmpSelection(remote.effective, requested.requested)))
  ) {
    throw new OrchestrationError(
      'capability_unsupported',
      'The execution host did not acknowledge the exact OMP launch route.'
    )
  }
  if (remote) {
    return { ...remote, effectiveSource: remote.effectiveSource ?? 'legacy-acknowledgement' }
  }
  return remoteReady
    ? {
        requested: requested.requested,
        effective: { ...requested.requested },
        effectiveSource: 'legacy-acknowledgement'
      }
    : requested
}

function sameOmpSelection(
  left: OrchestrationWorkerLaunchSelection | null,
  right: OrchestrationWorkerLaunchSelection
): boolean {
  return Boolean(
    left &&
    left.agent === right.agent &&
    left.model === right.model &&
    left.effort === right.effort &&
    JSON.stringify(left.openrouterCandidates) === JSON.stringify(right.openrouterCandidates)
  )
}
