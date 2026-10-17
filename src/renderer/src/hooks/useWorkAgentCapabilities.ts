import { getAgentSessionOptionCatalog } from '../../../shared/agent-session-option-catalog'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useHandoffScope } from '@/components/handoffs/handoff-scope'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { useAgentDetectionTargetForWorktree } from './useAgentDetectionTarget'
import { useDetectedAgents } from './useDetectedAgents'
import { useTaskContinuationCapability } from './useTaskContinuationCapability'
import { refreshWorkProviderUsage, useWorkProviderUsage } from './useWorkProviderUsage'
import {
  isWorkAgentModelListingDue,
  probeWorkAgentModels,
  useWorkAgentModelProbes,
  workAgentModelListingPolicy
} from './work-agent-model-probes'
import type { ProviderRateLimits, RateLimitState } from '../../../shared/rate-limit-types'
import { assessWorkAgentAvailability, hasUsageFeed } from '../../../shared/work-agent-availability'
import type { TuiAgent } from '../../../shared/tui-agent'
import { workspaceLaunchTaskId } from '../../../shared/workspace-launch-task'
import type { GlobalSettings } from '../../../shared/global-settings-types'

/** `build-review`: a workspace launch whose setup keeps agents with unchecked usage selectable. */
export type WorkAgentCapabilityMode = 'workspace-launch' | 'task-continuation' | 'build-review'

export function workAgentModelProbeOwner(
  scope: string,
  host: string,
  settings: GlobalSettings | null | undefined
) {
  return JSON.stringify([
    scope,
    host,
    settings?.agentCmdOverrides,
    settings?.activeClaudeManagedAccountId,
    settings?.activeCodexManagedAccountId,
    settings?.agentAccountProfiles
  ])
}

/** One agent's provider snapshot out of the whole rate-limit state. */
export function workAgentProviderUsage(
  state: RateLimitState,
  agent: TuiAgent
): ProviderRateLimits | null {
  if (agent === 'claude-agent-teams') {
    return state.claude
  }

  return state[agent as keyof RateLimitState] &&
    typeof state[agent as keyof RateLimitState] === 'object' &&
    'provider' in (state[agent as keyof RateLimitState] as object)
    ? (state[agent as keyof RateLimitState] as ProviderRateLimits)
    : null
}

/**
 * Canonical employee picker source, shared by Start Work, Add Next, and model/effort fields.
 * `launcherOpen`: a surface that stays mounted (the sidebar new-conversation menu) says when it is
 * open; mounting lists only agents never listed, and each opening asks the host again, which
 * answers from its own record unless the CLI changed. A surface without it opens by mounting.
 * Nothing lists on a timer: a surface shows its last good listing until a new one replaces it,
 * while a click (`readCurrent`, `refresh`) still re-checks the listing's age.
 */
export function useWorkAgentCapabilities(
  worktreeId: string | null,
  taskId?: string,
  mode: WorkAgentCapabilityMode = 'workspace-launch',
  skipUsageGating = false,
  launcherOpen?: boolean
) {
  const scope = useHandoffScope()
  const target = useAgentDetectionTargetForWorktree(worktreeId)
  const detection = useDetectedAgents(target)
  const remoteUsage = useWorkProviderUsage(target, scope)
  const settings = useAppStore((state) => state.settings)
  const linkedTaskId = useAppStore((state) =>
    worktreeId
      ? workspaceLaunchTaskId(
          worktreeId,
          state.getKnownWorktreeById(worktreeId)?.linkedWorkItem?.hubTaskId,
          state.folderWorkspaces
        )
      : undefined
  )
  const localRates = useAppStore((state) => state.rateLimits)
  const probes = useWorkAgentModelProbes((state) => state.probes)
  const { dueMs, openDueMs, quiet } = workAgentModelListingPolicy(settings)
  // Why a clock: usage readings age on screen, and the kill switch re-lists on the minute tick.
  const [now, setNow] = useState(Date.now)
  const [mountedAt] = useState(Date.now)
  const host = JSON.stringify(target)
  const keyPrefix = workAgentModelProbeOwner(scope, host, settings)
  const detected = detection.detectedIds
  const resolvedTaskId = taskId?.trim() || linkedTaskId?.trim()
  const taskBound = Boolean(resolvedTaskId)
  const continuation = useTaskContinuationCapability(
    scope,
    taskBound && mode === 'task-continuation',
    resolvedTaskId
  )
  const continuationSupported = continuation.available
  const planRequired = taskBound && !continuationSupported
  const refreshDetection = detection.refresh
  const refreshRemoteUsage = remoteUsage.refresh
  // Why judged at mount, not on the clock: a listing that expires while this stays mounted (the
  // sidebar "+", the Attention strip) stays on screen until an opening, an engagement or a launch
  // lists it again, so no CLI runs on a timer. A surface that tracks its own opening lists only
  // agents never listed; the kill switch keeps the earlier minute re-check.
  const dueAt = !quiet ? now : launcherOpen === undefined ? mountedAt : null
  const dueAgents = (detected ?? [])
    .filter((agent) => {
      const probe = probes[`${keyPrefix}:${agent}`]
      return dueAt === null ? !probe : isWorkAgentModelListingDue(probe, dueMs, dueAt)
    })
    .join(',')
  useEffect(() => {
    if (!dueAgents || planRequired) {
      return
    }
    for (const agent of dueAgents.split(',') as TuiAgent[]) {
      void probeWorkAgentModels(`${keyPrefix}:${agent}`, agent, worktreeId, { dueMs, quiet })
    }
  }, [dueAgents, keyPrefix, worktreeId, planRequired, dueMs, quiet])
  useEffect(() => {
    if (!skipUsageGating && target?.kind === 'local') {
      void refreshWorkProviderUsage(keyPrefix)
    }
    const timer = setInterval(() => {
      if (!skipUsageGating && target?.kind === 'local') {
        void refreshWorkProviderUsage(keyPrefix)
      }
      setNow(Date.now())
    }, 60_000)
    return () => clearInterval(timer)
  }, [scope, host, keyPrefix, target?.kind, skipUsageGating])
  // `onScreen`: what a surface shows, which keeps the last good listing; a click reads its age.
  const readCapabilities = useCallback(
    (
      onScreen: boolean,
      ids = detected,
      remoteRates = remoteUsage.rates,
      verifiedContinuation = continuationSupported,
      verifiedOpenRouter = continuation.openrouterRouting
    ) => {
      const currentProbes = useWorkAgentModelProbes.getState().probes
      const state = useAppStore.getState()
      const { settings: currentSettings, rateLimits: currentRates } = state
      const currentOwner = workAgentModelProbeOwner(scope, host, currentSettings)
      const currentTaskId =
        taskId?.trim() ||
        (worktreeId
          ? workspaceLaunchTaskId(
              worktreeId,
              state.getKnownWorktreeById(worktreeId)?.linkedWorkItem?.hubTaskId,
              state.folderWorkspaces
            )?.trim()
          : undefined)
      const checkedNow = Date.now()
      const current = workAgentModelListingPolicy(currentSettings)
      const currentLifetimeMs = onScreen ? current.displayMs : current.lifetimeMs
      const targetRates = target?.kind === 'local' ? currentRates : remoteRates
      return getAgentCatalog().map((entry) => {
        const evidence = currentProbes[`${currentOwner}:${entry.id}`]
        const probedModels =
          evidence && checkedNow - evidence.checkedAt < currentLifetimeMs ? evidence.models : null
        return {
          ...entry,
          // Why: `models` is [] both when the probe listed nothing and when there is
          // no fresh probe at all; a surface that may fall back to a static catalog
          // while the probe is unavailable needs to tell those apart.
          modelsProbed: probedModels !== null,
          ...assessWorkAgentAvailability({
            requiresWorkPlan:
              Boolean(currentTaskId) &&
              (!verifiedContinuation ||
                currentTaskId !== resolvedTaskId ||
                (entry.id === 'omp'
                  ? !verifiedOpenRouter
                  : !['claude', 'codex', 'grok', 'gemini'].includes(entry.id))),
            skipUsageGating,
            admitUncheckedUsage: mode === 'build-review' && hasUsageFeed(entry.id),
            openrouterRouting: entry.id === 'omp',
            installed: ids?.includes(entry.id) ?? false,
            disabled: currentSettings?.disabledTuiAgents?.includes(entry.id) ?? false,
            models: skipUsageGating
              ? (probedModels ?? getAgentSessionOptionCatalog(entry.id)?.models ?? [])
              : probedModels,
            // Local credentials say nothing about an SSH or paired execution host.
            usage: targetRates ? workAgentProviderUsage(targetRates, entry.id) : null,
            signedIn: entry.id === 'kimi' ? (targetRates?.kimiAuthConfigured ?? null) : undefined,
            now: checkedNow
          })
        }
      })
    },
    [
      skipUsageGating,
      mode,
      detected,
      scope,
      host,
      taskId,
      worktreeId,
      resolvedTaskId,
      target?.kind,
      remoteUsage.rates,
      continuationSupported,
      continuation.openrouterRouting
    ]
  )
  const capabilities = readCapabilities(true)
  // Recheck cache age and current account state on click without repeating host probes.
  const readCurrent = useCallback(() => readCapabilities(false), [readCapabilities])
  const refreshContinuation = continuation.refresh
  // `agents`: the ones a launch is about to start; only they are listed again, ahead of any
  // queued listing, and the answer waits for their own listing rather than the placeholder.
  const refresh = useCallback(
    async (agents?: readonly string[]) => {
      const verified =
        taskBound && mode === 'task-continuation' ? await refreshContinuation() : null
      const verifiedContinuation = verified?.available === true
      if (taskBound && !verifiedContinuation) {
        return readCapabilities(false, [], null, false)
      }
      const ids = await refreshDetection().catch(() => [] as TuiAgent[])
      const [usageResult] = await Promise.allSettled([
        skipUsageGating
          ? Promise.resolve(null)
          : target?.kind === 'local'
            ? refreshWorkProviderUsage(keyPrefix, 'explicit').then(() => null)
            : refreshRemoteUsage(),
        ...ids
          .filter((agent) => !agents || agents.includes(agent))
          .map((agent) =>
            probeWorkAgentModels(`${keyPrefix}:${agent}`, agent, worktreeId, {
              dueMs,
              quiet,
              force:
                !agents ||
                useWorkAgentModelProbes.getState().probes[`${keyPrefix}:${agent}`]?.models === null,
              awaitListing: Boolean(agents)
            })
          )
      ])
      setNow(Date.now())
      return readCapabilities(
        false,
        ids,
        usageResult.status === 'fulfilled' ? usageResult.value : null,
        verifiedContinuation,
        verified?.openrouterRouting === true
      )
    },
    [
      skipUsageGating,
      taskBound,
      mode,
      refreshContinuation,
      refreshDetection,
      keyPrefix,
      target?.kind,
      worktreeId,
      readCapabilities,
      refreshRemoteUsage,
      dueMs,
      quiet
    ]
  )
  // Lists every agent whose listing is at least `age` old (or failed), one CLI at a time.
  const listModels = useCallback(
    async (age: number) => {
      if (!detected || planRequired) {
        return
      }
      await Promise.allSettled(
        detected.map((agent) =>
          probeWorkAgentModels(`${keyPrefix}:${agent}`, agent, worktreeId, { dueMs: age, quiet })
        )
      )
    },
    [detected, planRequired, keyPrefix, worktreeId, quiet]
  )
  // Someone engaging with a surface that stays open (the Attention strip): list expired agents.
  const refreshModels = useCallback(() => listModels(dueMs), [listModels, dueMs])
  // A launcher (new-conversation menu, composer) opening asks the host again past a hover-flicker
  // floor. Why every opening: a CLI update shows at once, and the host answers from its record
  // (a failing CLI too) unless the binary changed, so an opening never runs a CLI on every hover.
  const refreshedThisOpening = useRef(false)
  useEffect(() => {
    if (!launcherOpen) {
      refreshedThisOpening.current = false
      return
    }
    if (refreshedThisOpening.current || !detected || planRequired) {
      return
    }
    refreshedThisOpening.current = true
    void listModels(openDueMs)
  }, [launcherOpen, detected, planRequired, listModels, openDueMs])
  return {
    capabilities,
    // Why: one usage read for every employee surface — a second watcher would double the stream.
    rates: target?.kind === 'local' ? localRates : remoteUsage.rates,
    usable: capabilities.filter((entry) => entry.status === 'usable'),
    loading:
      continuation.loading ||
      (!planRequired &&
        (detection.isLoading ||
          detected === null ||
          Boolean(detected?.some((agent) => !probes[`${keyPrefix}:${agent}`])))),
    continuationUnavailableReason:
      taskBound && mode === 'task-continuation' && !continuation.loading && !continuationSupported
        ? continuation.reason ||
          translate(
            'nextStep.continuationServerUnavailable',
            'Continuing this task with an agent is unavailable right now.'
          )
        : undefined,
    readCurrent,
    refresh,
    refreshModels
  }
}
