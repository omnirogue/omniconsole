import { describe, expect, it } from 'vitest'
import type { OmniRogueGatewayHealthProbe } from '../../../../preload/api/omnirogue-api'
import type { GatewayHealthSummary } from './omnirogue-gateway-health-helpers'
import {
  DEFAULT_GATEWAY_REACHABILITY_LABELS as labels,
  withGatewayReachability
} from './omnirogue-gateway-reachability'

const healthy: GatewayHealthSummary = { status: 'healthy', checks: [], needsReconnect: false }

function probe(overrides: Partial<OmniRogueGatewayHealthProbe>): OmniRogueGatewayHealthProbe {
  return {
    state: 'healthy',
    checkedAt: 1,
    latencyMs: 12,
    modelCount: 3,
    missingProviders: [],
    ...overrides
  }
}

describe('withGatewayReachability', () => {
  it('adds a passing row for a healthy probe', () => {
    const summary = withGatewayReachability(healthy, probe({}), labels)
    expect(summary.status).toBe('healthy')
    expect(summary.checks).toEqual([
      {
        id: 'reachability',
        label: labels.reachabilityLabel,
        status: 'pass',
        detail: 'The gateway listed 3 models in 12 ms.'
      }
    ])
  })

  it('degrades a healthy session when providers are missing', () => {
    const summary = withGatewayReachability(
      healthy,
      probe({ state: 'degraded', missingProviders: ['google'] }),
      labels
    )
    expect(summary.status).toBe('degraded')
    expect(summary.checks[0]?.detail).toBe('No models from google in the gateway catalog.')
  })

  it('marks the gateway down and asks to reconnect when the token is rejected', () => {
    const summary = withGatewayReachability(healthy, probe({ state: 'unauthorized' }), labels)
    expect(summary.status).toBe('down')
    expect(summary.needsReconnect).toBe(true)
  })

  it('leaves off, unchecked and unprobed summaries unchanged', () => {
    const off: GatewayHealthSummary = { status: 'off', checks: [], needsReconnect: false }
    expect(withGatewayReachability(off, probe({ state: 'unreachable' }), labels)).toBe(off)
    expect(withGatewayReachability(healthy, null, labels)).toBe(healthy)
    expect(withGatewayReachability(healthy, probe({ state: 'unknown' }), labels)).toBe(healthy)
  })
})
