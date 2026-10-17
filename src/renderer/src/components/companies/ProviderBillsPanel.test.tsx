// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { scorecardDocument } from '../../../../shared/console-scorecard-contract'
import { ProviderBillsPanel } from './ProviderBillsPanel'
import { billMoney, providerBillsView, vendorName } from './provider-bills-view'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, text: string, options?: Record<string, unknown>) =>
    options
      ? text.replace(/{{(\w+)}}/g, (_match, name: string) => String(options[name] ?? ''))
      : text
}))

afterEach(cleanup)

const BASIS =
  'vendor meters for UTC days; logged = OmniRogue + BetaCorp api_cost_log with failed/refunded rows excluded'

function day(date: string, partial: boolean, scale = 1) {
  return {
    date,
    partial,
    billed: {
      openrouter_app: 1032.16 * scale,
      openrouter_other: 201.23 * scale,
      fal: 453.52 * scale,
      byteplus: null,
      google: null,
      openai: null,
      anthropic: null
    },
    piapi_topups: 0,
    billed_known_usd: 1485.68 * scale,
    logged: {
      openrouter: 691.13 * scale,
      fal: 330.97 * scale,
      byteplus: 818.2 * scale,
      piapi: 13.44,
      other: 12.68,
      total: 1866.42 * scale
    },
    unlogged_known: { openrouter: 341.03 * scale, fal: 122.55 * scale }
  }
}

const FULL = {
  basis: BASIS,
  timezone: 'UTC',
  not_connected: ['byteplus', 'google', 'openai', 'anthropic'],
  days: [
    ...['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27'].map(
      (date) => day(date, false)
    ),
    day('2026-09-28', true, 0.5)
  ]
}

function scorecard(extra: Record<string, unknown> = {}) {
  return scorecardDocument.parse({
    generated_at: '2026-09-28T12:00:00Z',
    today: '2026-09-28',
    timezone: 'America/New_York',
    companies: [],
    sources: [
      { name: 'provider-bills', ok: true },
      { name: 'provider-bills-logged', ok: false, error: 'supabase timeout' }
    ],
    ...extra
  })
}

describe('the provider bills view', () => {
  it('headlines the latest complete day and today so far, with the per-vendor gap', () => {
    const document = scorecard({ provider_bills: FULL })
    const view = providerBillsView(document.provider_bills, document.sources, document.timezone)!
    expect(view.headline.map((row) => [row.label, row.date])).toEqual([
      ['Latest complete day', '2026-09-27'],
      ['Today so far, UTC', '2026-09-28']
    ])
    expect(view.headline[0].notLogged).toBeCloseTo(463.58)
    expect(view.headline[0].notLoggedDetail).toBe('OpenRouter $341.03 · fal $122.55')
    expect(view.headline[0].billedDetail).toContain('BytePlus not read')
    expect(view.days).toHaveLength(7)
    expect(view.notConnected).toBe('No billing read yet: BytePlus, Google, OpenAI, Anthropic')
    expect(view.clockNote).toBe('Days are UTC; the rest of the scorecard is America/New_York.')
    expect(view.failures.map((source) => source.name)).toEqual(['provider-bills-logged'])
    expect(vendorName('new_vendor')).toBe('New vendor')
  })

  it('keeps unknowns as "—", never $0.00', () => {
    const document = scorecard({
      provider_bills: {
        days: [
          {
            date: '2026-09-27',
            partial: false,
            billed_known_usd: null,
            logged: null,
            unlogged_known: { openrouter: null, fal: null }
          }
        ]
      }
    })
    const view = providerBillsView(document.provider_bills)!
    expect(view.headline).toHaveLength(1)
    expect(view.headline[0]).toMatchObject({
      billed: null,
      logged: null,
      notLogged: null,
      notLoggedDetail: 'OpenRouter — · fal —'
    })
    expect(view.notConnected).toBeNull()
    expect(billMoney(null)).toBe('—')
    expect(billMoney(0)).toBe('$0.00')
  })

  it('is null without the block', () => {
    expect(providerBillsView(scorecard().provider_bills)).toBeNull()
    expect(providerBillsView(scorecard({ provider_bills: 'broken' }).provider_bills)).toBeNull()
  })
})

describe('the provider bills panel', () => {
  it('is not drawn without the block or without a scorecard', () => {
    const { container, rerender } = render(<ProviderBillsPanel scorecard={scorecard()} />)
    expect(container.querySelector('[data-provider-bills]')).toBeNull()
    rerender(<ProviderBillsPanel scorecard={null} />)
    expect(container.querySelector('[data-provider-bills]')).toBeNull()
  })

  it('draws billed, logged and not logged by UTC day, with the basis and unknowns as "—"', () => {
    const payload = {
      ...FULL,
      days: [...FULL.days.slice(0, 6), { ...day('2026-09-28', true), billed_known_usd: null }]
    }
    const { container } = render(
      <ProviderBillsPanel scorecard={scorecard({ provider_bills: payload })} />
    )
    expect(
      screen.getByRole('region', { name: 'API cost — provider bills vs logged' })
    ).toBeInTheDocument()
    const complete = container.querySelector('[data-provider-bills-day="complete"]')!
    expect(complete.textContent).toContain('$1,485.68')
    expect(complete.textContent).toContain('$1,866.42')
    expect(complete.textContent).toContain('$463.58')
    const today = container.querySelector('[data-provider-bills-day="today"]')!
    expect(today.textContent).toContain('Today so far, UTC')
    expect(today.querySelector('dd')?.textContent).toBe('—')
    expect(container.querySelectorAll('[data-provider-bills-days] tbody tr')).toHaveLength(7)
    expect(
      screen.getByText('No billing read yet: BytePlus, Google, OpenAI, Anthropic')
    ).toBeInTheDocument()
    expect(screen.getByText(/Days are UTC; the rest of the scorecard is/)).toBeInTheDocument()
    const basis = container.querySelector('[data-provider-bills-basis]')?.textContent
    expect(basis).toContain(BASIS)
    expect(basis).toContain('supabase timeout')
    expect(container.textContent).not.toContain('$0.00')
  })
})
