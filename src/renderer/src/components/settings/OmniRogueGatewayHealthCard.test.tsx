// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  OmniRogueGatewayModelOption,
  OmniRogueGatewaySession
} from '../../../../shared/omnirogue-account'
import {
  OmniRogueGatewayHealthCard,
  type OmniRogueGatewayHealthCardProps
} from './OmniRogueGatewayHealthCard'
import {
  DEFAULT_GATEWAY_HEALTH_LABELS,
  evaluateGatewayHealth,
  fillGatewayLabel,
  formatGatewayClock,
  gatewayModelName,
  gatewayStatusLine,
  resolveGatewayHealthLabels
} from './omnirogue-gateway-health-helpers'
import { DEFAULT_GATEWAY_REACHABILITY_LABELS } from './omnirogue-gateway-reachability'

const NOW = Date.UTC(2026, 9, 16, 15, 0, 0)
const labels = DEFAULT_GATEWAY_HEALTH_LABELS
const catalog: OmniRogueGatewayModelOption[] = [
  {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    provider: 'anthropic',
    recommendedAgents: ['claude']
  },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', provider: 'openai', recommendedAgents: ['codex'] }
]

function session(overrides: Partial<OmniRogueGatewaySession> = {}): OmniRogueGatewaySession {
  return {
    active: true,
    billing: 'omnirogue-credits',
    baseUrl: 'https://api.omnirogue.com',
    model: 'claude-opus-5-5',
    expiresAt: NOW + 3_600_000,
    tokenAvailable: true,
    availableModels: catalog,
    ...overrides
  }
}

function ticking(...times: number[]): () => number {
  const queue = [...times]
  return () => queue.shift() ?? times.at(-1) ?? NOW
}

function renderCard(props: OmniRogueGatewayHealthCardProps = {}): {
  push: (next: OmniRogueGatewaySession) => void
  unsubscribe: ReturnType<typeof vi.fn>
} {
  let listener: ((next: OmniRogueGatewaySession) => void) | null = null
  const unsubscribe = vi.fn()
  render(
    <OmniRogueGatewayHealthCard
      loadSession={vi.fn().mockResolvedValue(session())}
      subscribe={(next) => {
        listener = next
        return unsubscribe
      }}
      now={ticking(NOW, NOW + 42)}
      {...props}
    />
  )
  return {
    push: (next) => listener?.(next),
    unsubscribe
  }
}

afterEach(cleanup)

describe('evaluateGatewayHealth', () => {
  it('is unknown before a reading and off when agents use their own login', () => {
    expect(evaluateGatewayHealth(null, NOW, labels)).toEqual({
      status: 'unknown',
      checks: [],
      needsReconnect: false
    })
    const off = evaluateGatewayHealth(
      session({ billing: 'own-login', active: false, tokenAvailable: false }),
      NOW,
      labels
    )
    expect(off).toEqual({ status: 'off', checks: [], needsReconnect: false })
  })

  it('reports a healthy credits session with every check passing in order', () => {
    const summary = evaluateGatewayHealth(session(), NOW, labels)
    expect(summary.status).toBe('healthy')
    expect(summary.needsReconnect).toBe(false)
    expect(summary.checks.map((check) => [check.id, check.status])).toEqual([
      ['token', 'pass'],
      ['expiry', 'pass'],
      ['catalog', 'pass'],
      ['model', 'pass']
    ])
    expect(summary.checks[1].detail).toBe(`Valid until ${formatGatewayClock(NOW + 3_600_000)}.`)
    expect(summary.checks[2].detail).toBe('2 models available.')
    expect(summary.checks[3].detail).toBe('Claude Opus 5.5 is available.')
  })

  it.each([
    ['token expiring soon', { expiresAt: NOW + 60_000 }, 'expiry', true],
    ['unverifiable expiry', { expiresAt: undefined }, 'expiry', true],
    ['model missing from catalog', { model: 'retired-model' }, 'model', false],
    ['empty catalog', { availableModels: [] }, 'catalog', false],
    ['pending billing restart', { requiresRestartForBillingChange: true }, 'restart', false]
  ] as const)('degrades for %s', (_name, overrides, checkId, needsReconnect) => {
    const summary = evaluateGatewayHealth(session(overrides), NOW, labels)
    expect(summary.status).toBe('degraded')
    expect(summary.needsReconnect).toBe(needsReconnect)
    expect(summary.checks.find((check) => check.id === checkId)?.status).toBe('warn')
  })

  it('treats an empty catalog as unable to verify a selected model', () => {
    const model = evaluateGatewayHealth(session({ availableModels: [] }), NOW, labels).checks.find(
      (check) => check.id === 'model'
    )
    expect(model?.detail).toBe('claude-opus-5-5 could not be verified without a catalog.')
  })

  it('is down when the token is missing or expired', () => {
    const missing = evaluateGatewayHealth(
      session({ active: false, tokenAvailable: false }),
      NOW,
      labels
    )
    expect(missing.status).toBe('down')
    expect(missing.needsReconnect).toBe(true)
    expect(missing.checks[0]).toMatchObject({ id: 'token', status: 'fail' })

    const expired = evaluateGatewayHealth(session({ expiresAt: NOW }), NOW, labels)
    expect(expired.status).toBe('down')
    expect(expired.checks[1]).toMatchObject({ status: 'fail', detail: labels.expired })
  })
})

describe('gateway health labels', () => {
  it('merges overrides without mutating the defaults', () => {
    const merged = resolveGatewayHealthLabels({ title: 'Gateway' })
    expect(merged.title).toBe('Gateway')
    expect(merged.refresh).toBe(DEFAULT_GATEWAY_HEALTH_LABELS.refresh)
    expect(DEFAULT_GATEWAY_HEALTH_LABELS.title).toBe('Model gateway health')
    expect(Object.isFrozen(DEFAULT_GATEWAY_HEALTH_LABELS)).toBe(true)
  })

  it('fills known placeholders and leaves unknown ones visible', () => {
    expect(fillGatewayLabel('{{count}} of {{total}}', { count: 2 })).toBe('2 of {{total}}')
  })

  it('names the model from the catalog, its id, or the gateway default', () => {
    expect(gatewayModelName(session(), labels)).toBe('Claude Opus 5.5')
    expect(gatewayModelName(session({ model: 'custom' }), labels)).toBe('custom')
    expect(gatewayModelName(session({ model: '  ' }), labels)).toBe(labels.modelDefault)
  })

  it('orders the status line by activity, link hint, then last reading', () => {
    const base = {
      busy: null,
      linkOpened: false,
      status: 'healthy',
      checkedAt: NOW,
      latencyMs: 12
    } as const
    expect(gatewayStatusLine({ ...base, busy: 'refresh' }, labels)).toBe(labels.loading)
    expect(gatewayStatusLine({ ...base, busy: 'reconnect' }, labels)).toBe(labels.reconnecting)
    expect(gatewayStatusLine({ ...base, linkOpened: true }, labels)).toBe(labels.reconnectHint)
    expect(gatewayStatusLine({ ...base, checkedAt: null }, labels)).toBe(labels.notChecked)
    expect(gatewayStatusLine(base, labels)).toBe(
      `Healthy · Checked ${formatGatewayClock(NOW)} · 12 ms`
    )
    expect(gatewayStatusLine({ ...base, latencyMs: null }, labels)).toBe(
      `Healthy · Updated ${formatGatewayClock(NOW)}`
    )
  })
})

describe('OmniRogueGatewayHealthCard', () => {
  it('reads the session on mount and renders status, facts and checks', async () => {
    renderCard()
    expect(
      await screen.findByText(`Healthy · Checked ${formatGatewayClock(NOW + 42)} · 42 ms`)
    ).toBeTruthy()
    expect(screen.getByRole('region', { name: labels.title }).getAttribute('aria-busy')).toBe(
      'false'
    )
    expect(screen.getByText('Healthy', { selector: '[data-slot="badge"]' })).toBeTruthy()
    expect(screen.getByText('https://api.omnirogue.com')).toBeTruthy()
    expect(screen.getByText(labels.billingCredits)).toBeTruthy()
    expect(screen.getByText(labels.tokenReady)).toBeTruthy()
    expect(screen.getAllByText(labels.checkPass)).toHaveLength(4)
    expect(screen.queryByRole('button', { name: labels.reconnect })).toBeNull()
  })

  it('shows a load failure and clears it after a successful refresh', async () => {
    const loadSession = vi
      .fn()
      .mockRejectedValueOnce(new Error('ipc closed'))
      .mockResolvedValueOnce(session())
    renderCard({ loadSession, now: () => NOW })
    expect((await screen.findByRole('alert')).textContent).toBe(labels.loadFailed)
    expect(screen.getByRole('status').textContent).toBe(labels.notChecked)

    fireEvent.click(screen.getByRole('button', { name: labels.refresh }))
    expect(await screen.findByText(labels.tokenReady)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(loadSession).toHaveBeenCalledTimes(2)
  })

  it('renders caller-supplied labels in place of the defaults', async () => {
    renderCard({ labels: { title: 'Gateway', statusHealthy: 'All good', refresh: 'Recheck' } })
    expect(await screen.findByText('All good', { selector: '[data-slot="badge"]' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Gateway' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Recheck' })).toBeTruthy()
    expect(screen.queryByText(labels.title)).toBeNull()
  })

  it('offers reconnect when the token is missing and reports the outcome', async () => {
    const onReconnect = vi.fn().mockResolvedValue(undefined)
    renderCard({
      loadSession: vi.fn().mockResolvedValue(session({ active: false, tokenAvailable: false })),
      onReconnect
    })
    fireEvent.click(await screen.findByRole('button', { name: labels.reconnect }))
    expect(await screen.findByText(labels.reconnectHint)).toBeTruthy()
    expect(onReconnect).toHaveBeenCalledTimes(1)
    expect(screen.getByText(labels.statusDown, { selector: '[data-slot="badge"]' })).toBeTruthy()
  })

  it('shows an alert when account linking cannot open', async () => {
    renderCard({
      loadSession: vi.fn().mockResolvedValue(session({ expiresAt: NOW })),
      onReconnect: vi.fn().mockRejectedValue(new Error('no window'))
    })
    fireEvent.click(await screen.findByRole('button', { name: labels.reconnect }))
    expect((await screen.findByRole('alert')).textContent).toBe(labels.reconnectFailed)
  })

  it('explains the off state when agents use their own login', async () => {
    renderCard({
      loadSession: vi.fn().mockResolvedValue(session({ billing: 'own-login', active: false }))
    })
    expect(await screen.findByText(labels.offDetail)).toBeTruthy()
    expect(screen.getByText(labels.billingOwnLogin)).toBeTruthy()
    expect(screen.queryByText(labels.tokenLabel)).toBeNull()
  })

  it('applies pushed session changes and unsubscribes on unmount', async () => {
    const { push, unsubscribe } = renderCard()
    await screen.findByText(labels.tokenReady)
    act(() => push(session({ model: 'gpt-6-astra', requiresRestartForBillingChange: true })))
    expect(screen.getByText('GPT-6 Astra is available.')).toBeTruthy()
    expect(screen.getByText(labels.restartRequired)).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe(
      `${labels.statusDegraded} · Updated ${formatGatewayClock(NOW + 42)}`
    )
    cleanup()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})

describe('OmniRogueGatewayHealthCard gateway probe', () => {
  it('shows the probe result and marks a rejected token as unavailable', async () => {
    const checkHealth = vi.fn().mockResolvedValue({
      state: 'unauthorized',
      checkedAt: NOW,
      latencyMs: 30,
      modelCount: 0,
      missingProviders: []
    })
    renderCard({ checkHealth })
    expect(
      await screen.findByText(DEFAULT_GATEWAY_REACHABILITY_LABELS.reachabilityUnauthorized)
    ).toBeTruthy()
    expect(checkHealth).toHaveBeenCalledTimes(1)
    expect(screen.getByText(labels.statusDown, { selector: '[data-slot="badge"]' })).toBeTruthy()
  })

  it('keeps the session checks when the probe fails', async () => {
    renderCard({ checkHealth: vi.fn().mockRejectedValue(new Error('offline')) })
    expect(await screen.findByText(labels.tokenReady)).toBeTruthy()
    expect(screen.queryByText(DEFAULT_GATEWAY_REACHABILITY_LABELS.reachabilityLabel)).toBeNull()
  })
})
