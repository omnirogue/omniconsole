import {
  DecisionProviderError,
  type DecisionFailureCode,
  type DecisionMode,
  type DecisionRequest,
  type StructuredDecisionProvider
} from '../../shared/structured-decisions'
import {
  decisionEnvironmentKilled,
  disabledDecisionConfiguration,
  type DecisionConfiguration,
  type DecisionConfigurationSource,
  type DecisionRoutineModeSource
} from './decision-configuration'

export type DecisionPolicySources = {
  provider?: Pick<StructuredDecisionProvider, 'shadowOnly'>
  configuration: DecisionConfigurationSource
  routineMode?: DecisionRoutineModeSource
  environment?: () => Record<string, string | undefined>
}
const LIVE_CAPABILITIES = new Set(['advertising.routine', 'routine.structured'])

export function decisionFailureStatus(
  reason: DecisionFailureCode
): 'cancelled' | 'disabled' | 'unavailable' {
  if (reason === 'cancelled') {
    return 'cancelled'
  }
  return [
    'disabled',
    'disposed',
    'invalid_configuration',
    'not_live',
    'shadow_only',
    'routine_not_enabled'
  ].includes(reason)
    ? 'disabled'
    : 'unavailable'
}

export async function requireDecisionMode(
  request: DecisionRequest,
  mode: 'live' | 'shadow',
  sources: DecisionPolicySources
): Promise<DecisionConfiguration> {
  if (mode === 'live' && sources.provider?.shadowOnly) {
    throw new DecisionProviderError('shadow_only')
  }
  if (decisionEnvironmentKilled(sources.environment?.() ?? process.env)) {
    throw new DecisionProviderError('disabled')
  }
  let config: DecisionConfiguration
  try {
    config = await sources.configuration()
  } catch {
    config = disabledDecisionConfiguration()
  }
  if (!config.valid) {
    throw new DecisionProviderError('invalid_configuration')
  }
  if (!config.enabled || config.killSwitch) {
    throw new DecisionProviderError('disabled')
  }
  const capabilityMode = config.capabilities[request.capability]?.mode ?? 'off'
  if (capabilityMode === 'off') {
    throw new DecisionProviderError('disabled')
  }
  if (mode === 'live' && !LIVE_CAPABILITIES.has(request.capability)) {
    throw new DecisionProviderError('shadow_only')
  }
  if (mode === 'live' && capabilityMode !== 'live') {
    throw new DecisionProviderError('not_live')
  }
  if (LIVE_CAPABILITIES.has(request.capability) && !request.routineId) {
    throw new DecisionProviderError('routine_not_enabled')
  }
  if (request.routineId) {
    let routineMode: DecisionMode = config.routines[request.routineId]?.mode ?? 'off'
    if (sources.routineMode) {
      try {
        routineMode = await sources.routineMode(request.routineId)
      } catch {
        routineMode = 'off'
      }
      // A profile override can always reduce a persisted routine preference.
      const override = config.routines[request.routineId]?.mode
      if (override === 'off' || (override === 'shadow' && routineMode === 'live')) {
        routineMode = override
      }
    }
    if (routineMode === 'off' || (mode === 'live' && routineMode !== 'live')) {
      throw new DecisionProviderError('routine_not_enabled')
    }
  }
  if (decisionEnvironmentKilled(sources.environment?.() ?? process.env)) {
    throw new DecisionProviderError('disabled')
  }
  return config
}
