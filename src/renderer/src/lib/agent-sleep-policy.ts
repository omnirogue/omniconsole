import type { GlobalSettings } from '../../../shared/global-settings-types'
import {
  getEffectiveIdleAutoCloseMs,
  resolveIdleAutoCloseGate
} from '../../../shared/idle-auto-close-settings'
import { getEffectiveAgentHibernationIdleMs } from './agent-hibernation-planner'

/**
 * Which rule governs agent sleep this tick (see idle-auto-close-settings.ts). One planner, one
 * coordinator; `idleAutoCloseMode` decides whether a confirmed pane is slept or only logged, the
 * opt-in hibernation included, so the safe default (shadow) and the kill switch (off) cover it:
 * - `off`: plans nothing, hibernation or not.
 * - `shadow`: logs what it would do. `on`: acts only with the restore flood guard on (else it
 *   stays a shadow and logs why).
 * - The window is `idleAutoCloseMinutes`; with `experimentalAgentHibernation` on, the longer of
 *   that and `agentHibernationIdleMs` (and runtime-environment panes are planned too).
 */
export type AgentSleepPolicy = {
  source: 'hibernation' | 'idle-auto-close'
  idleMs: number
  act: boolean
  mode: 'shadow' | 'on'
  refused?: 'restore-flood-guard-off'
}

type AgentSleepSettings = Partial<
  Pick<
    GlobalSettings,
    | 'experimentalAgentHibernation'
    | 'agentHibernationIdleMs'
    | 'idleAutoCloseMode'
    | 'idleAutoCloseMinutes'
  >
> &
  object

export function resolveAgentSleepPolicy(
  settings: AgentSleepSettings | null | undefined
): AgentSleepPolicy | null {
  const gate = resolveIdleAutoCloseGate(settings)
  if (gate.mode === 'off') {
    return null
  }
  const idleAutoCloseMs = getEffectiveIdleAutoCloseMs(settings?.idleAutoCloseMinutes)
  const hibernation = settings?.experimentalAgentHibernation === true
  return {
    source: hibernation ? 'hibernation' : 'idle-auto-close',
    idleMs: hibernation
      ? Math.max(
          idleAutoCloseMs,
          getEffectiveAgentHibernationIdleMs(settings?.agentHibernationIdleMs)
        )
      : idleAutoCloseMs,
    act: gate.act,
    mode: gate.mode,
    ...(gate.mode === 'shadow' && gate.refused ? { refused: gate.refused } : {})
  }
}

/** The kill-switch check before each act: the settings must still resolve to this policy. */
export function isAgentSleepPolicyCurrent(
  policy: AgentSleepPolicy,
  settings: AgentSleepSettings | null | undefined
): boolean {
  const current = resolveAgentSleepPolicy(settings)
  return (
    current !== null &&
    current.source === policy.source &&
    current.act === policy.act &&
    current.idleMs === policy.idleMs
  )
}

/** The planner reads hibernation's own two settings; R1 hands it its window the same way. */
export function plannerSettingsFor(
  policy: AgentSleepPolicy
): Pick<GlobalSettings, 'experimentalAgentHibernation' | 'agentHibernationIdleMs'> {
  return { experimentalAgentHibernation: true, agentHibernationIdleMs: policy.idleMs }
}
