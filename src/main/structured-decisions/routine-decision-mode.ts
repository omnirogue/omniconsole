import type { DecisionConfiguration } from './decision-configuration'

export function isLiveRoutineDecisionEnabled(
  configuration: DecisionConfiguration,
  routineId: string,
  capability: string
): boolean {
  const routineMode = configuration.routines[routineId]?.mode
  return (
    configuration.valid &&
    configuration.enabled &&
    !configuration.killSwitch &&
    configuration.capabilities[capability]?.mode === 'live' &&
    (routineMode === undefined || routineMode === 'live')
  )
}
