/** @vitest-environment happy-dom */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { companiesApiMock } from '@/components/companies/companies-test-fixtures'
import { WorkCompaniesSection } from './WorkCompaniesSection'

const openCompaniesPage = vi.fn()
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ openCompaniesPage })
}))

const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, data })
const refused = (code: string, status: number, message = code) =>
  Promise.resolve({ ok: false as const, error: { code, status, message } })

function scorecard(extra: Record<string, unknown> = {}) {
  return {
    generated_at: '2026-09-11T22:00:00Z',
    timezone: 'America/New_York',
    today: '2026-09-11',
    stale_s: 300,
    companies: [
      {
        slug: 'omnirogue',
        name: 'OmniRogue',
        today: {
          reported: ['revenue', 'ad_spend', 'api_cost', 'pnl'],
          revenue: 2096.88,
          ad_spend: 961.09,
          api_cost: 413.86,
          pnl: 721.93,
          api_cost_available: true
        },
        days: []
      },
      {
        slug: 'apexlabs',
        name: 'ApexLabs',
        today: {
          reported: ['revenue', 'pnl'],
          revenue: 0,
          ad_spend: 0,
          api_cost: null,
          pnl: 0,
          api_cost_available: false
        },
        days: []
      }
    ],
    totals: {
      today: {
        reported: ['revenue', 'ad_spend', 'pnl'],
        revenue: 6122.69,
        ad_spend: 1470.85,
        api_cost: 537.72,
        pnl: 526.35
      }
    },
    finance: {},
    ...extra
  }
}

beforeEach(() => {
  window.api = { consoleCompanies: companiesApiMock } as unknown as typeof window.api
  companiesApiMock.health.mockImplementation(() =>
    ok({
      ok: true,
      companies: [{ slug: 'omnirogue', status: 'warning', summary: 'Ad spend up', domains: [] }]
    })
  )
  companiesApiMock.me.mockImplementation(() =>
    ok({
      ok: true,
      user: { role: 'member' },
      sections: [],
      pages: [],
      companies: ['omnirogue', 'apexlabs'],
      company_scope: 'department'
    })
  )
  // Why: the folder tree is the second half of the gate and it fails closed, so a
  // section test has to name the companies it expects on screen.
  companiesApiMock.folders.mockImplementation(() =>
    ok({
      ok: true,
      companies: [
        { id: 'c-omnirogue', slug: 'omnirogue', name: 'OmniRogue', count: 1, domains: [] },
        { id: 'c-apexlabs', slug: 'apexlabs', name: 'ApexLabs', count: 1, domains: [] }
      ]
    })
  )
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function mount() {
  return render(
    <TooltipProvider>
      <WorkCompaniesSection revision={0} />
    </TooltipProvider>
  )
}

describe('WorkCompaniesSection', () => {
  it('shows today money per company, marks unreported figures unknown and never invents an API cost', async () => {
    companiesApiMock.scorecard.mockImplementation(() => ok(scorecard()))
    mount()
    await waitFor(() => expect(screen.getByText('OmniRogue')).toBeTruthy())
    const omnirogue = document.querySelector('[data-work-company="omnirogue"]') as HTMLElement
    expect(omnirogue.textContent).toContain('$2,097')
    expect(omnirogue.textContent).toContain('$414')
    const apexlabs = document.querySelector('[data-work-company="apexlabs"]') as HTMLElement
    // Why: ApexLabs has no API-cost tenant and reported no ad spend — both stay unknown, not $0.
    expect(
      apexlabs.querySelector('[data-money="API cost"][data-money-empty]')?.textContent
    ).toBe('n/a')
    expect(
      apexlabs.querySelector('[data-money="Ad spend"][data-money-empty]')?.textContent
    ).toBe('Unknown')
    expect(document.querySelector('[data-work-portfolio]')?.textContent).toContain('$6,123')
    expect(screen.getByText('Your access covers 2 companies.')).toBeTruthy()
    expect(screen.getByText(/updated 5 min ago/)).toBeTruthy()
  })

  it('omits the estate totals when the relay pruned the document', async () => {
    companiesApiMock.scorecard.mockImplementation(() =>
      ok(
        scorecard({ totals: undefined, scope: { companies: ['omnirogue'], totals_omitted: true } })
      )
    )
    mount()
    await waitFor(() => expect(screen.getByText('OmniRogue')).toBeTruthy())
    expect(document.querySelector('[data-work-portfolio]')).toBeNull()
    expect(screen.getByText('Estate totals are not shown for your access.')).toBeTruthy()
  })

  it('names a refused scorecard instead of blanking the section', async () => {
    companiesApiMock.scorecard.mockImplementation(() =>
      refused('forbidden', 403, 'company finance is limited')
    )
    mount()
    await waitFor(() =>
      expect(screen.getByText(/Company finance is limited to your access/)).toBeTruthy()
    )
    expect(document.querySelectorAll('[data-work-company]').length).toBe(0)
  })

  it('asks for a sign-in when the desktop has no omnios session', async () => {
    companiesApiMock.scorecard.mockImplementation(() => refused('signed_in_required', 401))
    mount()
    await waitFor(() => expect(screen.getByText(/Sign in/i)).toBeTruthy())
  })
})
