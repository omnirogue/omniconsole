import { parseExecutionHostId, toRuntimeExecutionHostId } from './execution-host'
import type { SessionChain } from './session-chain-types'
import type { SessionFollowUpTranscriptSource } from './session-follow-up-transcript'

export type SessionOutcomeRuntimeTarget =
  | { kind: 'local' }
  | { kind: 'environment'; environmentId: string }
export type SessionOutcomeHostCapabilities = {
  sessionFinish?: 1
  handoffFolders?: 1
  /** Complete history and exact file/folder capture, with explicit message-only support. */
  handoffAttachments?: 1
  handoffAgents?: 1
  sourceReviewRepairs?: 1
  version: number
  durableContinuation: boolean
  /**
   * WP-4b: this host can run a step that continues the original conversation instead of briefing
   * a new agent. Absent on a host that predates the route, which reads as false everywhere.
   */
  sameConversationRoute?: boolean
  executionRuntimeId?: string
  remoteRuntimeOwnership?: 1
  upNextRemoteOwnership?: 1
  ompSessionExit?: 1
  placementScope?: 'runtime-local'
  relaySshContinuation?: false
  reason?: string
}
export const SESSION_OUTCOME_RELAY_REFUSAL =
  'Relay-only SSH has no unattended orchestration owner. Connect to the headless Orca runtime on that host through a paired SSH-tunnel environment; this job will not run locally.'

/** A paired host receives its own transcript identity, never a client-side host alias. */
export function sessionOutcomeTranscriptForHost(
  source: SessionFollowUpTranscriptSource,
  target: SessionOutcomeRuntimeTarget
): SessionFollowUpTranscriptSource {
  const sourceHost = parseExecutionHostId(source.hostId)
  const environmentId =
    source.runtimeEnvironmentId ??
    (sourceHost?.kind === 'runtime' ? sourceHost.environmentId : null)
  if (
    sourceHost?.kind === 'ssh' ||
    (target.kind === 'environment'
      ? environmentId !== target.environmentId
      : sourceHost?.kind !== 'local' || environmentId !== null)
  ) {
    throw new Error('The outcome route does not own the selected transcript.')
  }
  const { runtimeEnvironmentId: _alias, ...owned } = source
  return { ...owned, hostId: 'local' }
}

/** Environment IDs are client aliases; only the selected peer may translate its alias to local execution. */
export function sessionOutcomeChainForHost(
  chain: SessionChain,
  target: SessionOutcomeRuntimeTarget
): SessionChain {
  const placement = parseExecutionHostId(chain.placement ?? chain.hostId)
  if (placement?.kind === 'ssh') {
    throw new Error(SESSION_OUTCOME_RELAY_REFUSAL)
  }
  if (
    placement?.kind === 'runtime' &&
    (target.kind !== 'environment' || placement.environmentId !== target.environmentId)
  ) {
    throw new Error('The outcome route does not own the selected execution host.')
  }
  if (target.kind === 'environment') {
    return {
      ...chain,
      hostId: 'local',
      placement: 'local',
      steps: chain.steps.map((step) => {
        if (step.kind !== 'handoff' || !step.handoff.transcriptSource) {
          return step
        }
        return {
          ...step,
          handoff: {
            ...step.handoff,
            transcriptSource: sessionOutcomeTranscriptForHost(step.handoff.transcriptSource, target)
          }
        }
      }),
      sourceRowKey: outcomeRowKey(chain, 'local')
    }
  }
  return chain
}

export function sessionOutcomeChainForClient(
  chain: SessionChain,
  target: SessionOutcomeRuntimeTarget
): SessionChain {
  return target.kind === 'environment'
    ? {
        ...chain,
        hostId: toRuntimeExecutionHostId(target.environmentId),
        placement: toRuntimeExecutionHostId(target.environmentId),
        steps: chain.steps.map((step) =>
          step.kind === 'handoff' && step.handoff.transcriptSource?.hostId === 'local'
            ? {
                ...step,
                handoff: {
                  ...step.handoff,
                  transcriptSource: {
                    ...step.handoff.transcriptSource,
                    hostId: toRuntimeExecutionHostId(target.environmentId)
                  }
                }
              }
            : step
        ),
        sourceRowKey: outcomeRowKey(chain, toRuntimeExecutionHostId(target.environmentId))
      }
    : chain
}

export function requireSessionOutcomeHost(
  capabilities: SessionOutcomeHostCapabilities,
  target: SessionOutcomeRuntimeTarget
): string | undefined {
  if (
    capabilities.version !== 1 ||
    !capabilities.durableContinuation ||
    (target.kind === 'environment' &&
      (capabilities.remoteRuntimeOwnership !== 1 ||
        !capabilities.executionRuntimeId ||
        capabilities.placementScope !== 'runtime-local'))
  ) {
    throw new Error(
      capabilities.reason ??
        'This execution host does not support durable outcome ownership. Update the host; no local fallback is permitted.'
    )
  }
  return capabilities.executionRuntimeId
}

/** Client-only outage projection; never persist it to the execution host or infer process exit. */
export function sessionOutcomeUnverifiableChain(chain: SessionChain): SessionChain {
  return chain.outcomeSet
    ? {
        ...chain,
        outcomeSet: {
          ...chain.outcomeSet,
          continuation: { ...chain.outcomeSet.continuation, state: 'unverifiable' }
        }
      }
    : chain
}

function outcomeRowKey(chain: SessionChain, hostId: string): string {
  try {
    const row = JSON.parse(chain.sourceRowKey)
    if (Array.isArray(row) && row.length === 2) {
      return JSON.stringify([hostId, chain.sourcePaneKey])
    }
  } catch {
    /* Older inferred records stored a bare pane key. */
  }
  return JSON.stringify([hostId, chain.sourceWorktreeId ?? chain.worktreeId, chain.sourcePaneKey])
}
