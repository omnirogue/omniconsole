import type { OmniRogueGatewayHealthProbe } from '../../../../preload/api/omnirogue-api'
import {
  fillGatewayLabel,
  type GatewayHealthCheck,
  type GatewayHealthSummary
} from './omnirogue-gateway-health-helpers'

export const DEFAULT_GATEWAY_REACHABILITY_LABELS = Object.freeze({
  reachabilityLabel: 'Gateway response',
  reachabilityReady: 'The gateway listed {{count}} models in {{milliseconds}} ms.',
  reachabilityMissing: 'No models from {{providers}} in the gateway catalog.',
  reachabilityUnauthorized: 'The gateway rejected the account token. Reconnect your account.',
  reachabilityUnreachable: 'The gateway did not answer. Refresh to retry.'
})

export type GatewayReachabilityLabels = Record<
  keyof typeof DEFAULT_GATEWAY_REACHABILITY_LABELS,
  string
>

function reachabilityCheck(
  probe: OmniRogueGatewayHealthProbe,
  labels: GatewayReachabilityLabels
): GatewayHealthCheck | null {
  const base = { id: 'reachability' as const, label: labels.reachabilityLabel }
  switch (probe.state) {
    case 'healthy':
      return {
        ...base,
        status: 'pass',
        detail: fillGatewayLabel(labels.reachabilityReady, {
          count: probe.modelCount,
          milliseconds: probe.latencyMs ?? 0
        })
      }
    case 'degraded':
      return {
        ...base,
        status: 'warn',
        detail: fillGatewayLabel(labels.reachabilityMissing, {
          providers: probe.missingProviders.join(', ')
        })
      }
    case 'unauthorized':
      return { ...base, status: 'fail', detail: labels.reachabilityUnauthorized }
    case 'unreachable':
      return { ...base, status: 'fail', detail: labels.reachabilityUnreachable }
    case 'unknown':
      return null
  }
}

/** Adds the W5-42 catalog probe to a credits-billing summary; it never revives an off gateway. */
export function withGatewayReachability(
  summary: GatewayHealthSummary,
  probe: OmniRogueGatewayHealthProbe | null,
  labels: GatewayReachabilityLabels
): GatewayHealthSummary {
  if (!probe || summary.status === 'off' || summary.status === 'unknown') {
    return summary
  }
  const check = reachabilityCheck(probe, labels)
  if (!check) {
    return summary
  }
  const status =
    check.status === 'fail'
      ? 'down'
      : check.status === 'warn' && summary.status === 'healthy'
        ? 'degraded'
        : summary.status
  return {
    status,
    checks: [...summary.checks, check],
    needsReconnect: summary.needsReconnect || probe.state === 'unauthorized'
  }
}
