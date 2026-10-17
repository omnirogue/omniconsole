import { attemptLaunchProvenance } from '../../../launch-ledger/launch-provenance-guard'
// Launch descriptions never control admission. The durable cause is independent of latency traces.

import {
  normalizeLaunchTrigger,
  resolveLaunchTrigger,
  type LaunchTrigger
} from '../../../../shared/launch-trigger'
import { isLatencyTelemetryEnabled } from '../../../observability/latency-probe-switch'
import { normalizeLaunchCause, type LaunchCause } from '../../../../shared/launch-cause'
import type { Store } from '../../../persistence'
import type {
  AutomationLaunchProvenanceRequest,
  AutomationOutputBindingRequest
} from '../../../../shared/automations-types'
import { matchesAutomationLaunchDispatch } from '../../../automations/dispatch-tokens'
import { matchesAutomationOutputDispatch } from '../../../automations/automation-output-binding'
import { callerLaunchClaims } from '../../../launch-ledger/launch-caller-claims'
import { takeLaunchCauseHints } from '../../../observability/launch-trigger-hints'
import type { PtySpawnIpcDeps } from './spawn-types'

export type SpawnLaunchAttribution = {
  launchTrigger?: LaunchTrigger
  launchVisible?: boolean
}

type IpcLaunchCauseArgs = {
  hasLaunchCommand: boolean
  interruptedAutoContinue?: boolean
  launchTrigger?: unknown
  launchVisible?: unknown
  automationLaunchProvenance?: AutomationLaunchProvenanceRequest
  automationOutputBinding?: AutomationOutputBindingRequest
  launchAgent?: string
  launchReference?: unknown
  launchParentPaneKey?: unknown
  worktreeId?: string
  tabId?: string
  leafId?: string
}

export function resolveIpcSpawnLaunchCause(
  args: IpcLaunchCauseArgs,
  store?: Pick<Store, 'listAutomationRuns'>
): LaunchCause {
  return attemptLaunchProvenance(
    'renderer-ipc',
    () => {
      const { tabCause, worktreeCause } = takeLaunchCauseHints(args, Date.now(), false)
      const claims = callerLaunchClaims({
        trigger: args.launchTrigger,
        reference: args.launchReference
      })
      const declared = normalizeLaunchCause({
        trigger: args.launchTrigger,
        reference: args.launchReference
      })
      const grant = args.automationLaunchProvenance ?? args.automationOutputBinding
      const matchesGrant = args.automationLaunchProvenance
        ? matchesAutomationLaunchDispatch
        : matchesAutomationOutputDispatch
      let owned: LaunchCause | null = null
      try {
        if (
          declared.trigger === 'automation' &&
          declared.reference?.automationId &&
          declared.reference.automationRunId
        ) {
          if (
            store &&
            grant?.automationId === declared.reference.automationId &&
            grant.runId === declared.reference.automationRunId &&
            matchesGrant(store, grant, args.worktreeId, args.launchAgent)
          ) {
            owned = {
              trigger: 'automation',
              reference: {
                automationId: declared.reference.automationId,
                automationRunId: declared.reference.automationRunId
              }
            }
          }
        }
      } catch {
        /* Unavailable host evidence cannot promote a claim. */
      }
      const trigger = resolveLaunchTrigger({
        interruptedAutoContinue: args.interruptedAutoContinue === true,
        rendererTrigger: args.launchTrigger,
        tabHint: tabCause?.trigger,
        worktreeHint: worktreeCause?.trigger
      })
      const hint = tabCause ?? (trigger === worktreeCause?.trigger ? worktreeCause : null)
      const authority: LaunchCause =
        args.interruptedAutoContinue === true
          ? { ...hint, trigger: 'restore-interrupted' as const }
          : (hint ??
            owned ?? {
              trigger:
                args.launchTrigger === undefined
                  ? ('unknown' as const)
                  : ('renderer-spawn' as const),
              actor: { kind: 'renderer' as const }
            })
      return normalizeLaunchCause({
        ...authority,
        actor: authority.actor ?? { kind: 'renderer' },
        ...claims
      })
    },
    { trigger: 'unknown' as const }
  )
}

export function resolveIpcSpawnLaunchAttribution(
  args: IpcLaunchCauseArgs & { resolvedCause?: LaunchCause }
): SpawnLaunchAttribution {
  return attemptLaunchProvenance(
    'renderer-ipc',
    () => {
      if (!args.hasLaunchCommand || !isLatencyTelemetryEnabled()) {
        return {}
      }
      return {
        launchTrigger: (args.resolvedCause ?? resolveIpcSpawnLaunchCause(args)).trigger,
        ...(typeof args.launchVisible === 'boolean' ? { launchVisible: args.launchVisible } : {})
      }
    },
    {}
  )
}

/**
 * Whether this spawn is the interrupted-restore auto-continue: prepareInterruptedResume
 * armed a continuation (the pane was mid-turn) and the setting lets it send. The
 * renderer's `interruptedRestore` flag alone is not proof: fresh-spawn-start sets it on
 * nearly every cold-restore resume (hibernation wakes, reveals, background mounts).
 */
export function isInterruptedAutoContinueLaunch(
  continuationArmed: boolean,
  deps: Pick<PtySpawnIpcDeps, 'getSettings' | 'store'>
): boolean {
  if (!continuationArmed) {
    return false
  }
  try {
    // Why the same read as interrupted-resume.ts: a disabled auto-continue never sends.
    return (
      (deps.getSettings?.() ?? deps.store?.getSettings())?.autoContinueInterruptedSessions !== false
    )
  } catch {
    // Why false: diagnostics must never fail a launch, and an unreadable setting proves nothing.
    return false
  }
}

/** Traces use the same fixed cause as the ledger; they remain optional latency telemetry. */
export function resolveRuntimeSpawnLaunchAttribution(
  launchTrigger?: unknown
): SpawnLaunchAttribution {
  return attemptLaunchProvenance(
    'runtime-controller',
    () => {
      if (!isLatencyTelemetryEnabled()) {
        return {}
      }
      const trigger = normalizeLaunchTrigger(launchTrigger)
      // Why: only main arms the auto-continue, and no runtime caller does; a claim of it here
      // is no evidence (same rule as resolveLaunchTrigger for renderer claims).
      return {
        launchTrigger: trigger === 'restore-interrupted' ? 'unknown' : trigger,
        launchVisible: false
      }
    },
    {}
  )
}
