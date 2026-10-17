// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scorecardDocument } from '../../../../shared/console-scorecard-contract'
import CompaniesPage from './CompaniesPage'
import { companiesApiMock, installCompaniesWindowApi, ok, refusal } from './companies-test-fixtures'

vi.mock('@/hooks/useWorkAgentCapabilities', () => ({
  useWorkAgentCapabilities: () => ({ usable: [], loading: false, refresh: vi.fn(async () => []) })
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, text: string, options?: Record<string, unknown>) =>
    options
      ? text.replace(/{{(\w+)}}/g, (_match, name: string) => String(options[name] ?? ''))
      : text,
  // Why: the agent catalog reads the active locale to cache its labels.
  i18n: { language: 'en' }
}))
vi.mock('@/store', () => ({
  useAppStore: (select: (state: unknown) => unknown) =>
    select({
      activeOrcaProfileId: 'profile-1',
      settings: {
        backofficeEnv: 'production',
        backofficeLocalUrl: '',
        backofficeProductionUrl: 'https://omnios.test'
      }
    })
}))

beforeEach(() => {
  installCompaniesWindowApi()
})
afterEach(cleanup)

describe('the companies list', () => {
  it('shows every company with its health, its work and its available cash', async () => {
    render(<CompaniesPage />)

    expect(await screen.findByText('OmniRogue')).toBeInTheDocument()
    expect(screen.getByText('BetaCorp')).toBeInTheDocument()
    // Rollup counts, the scorecard's summary and the bank's own cash, side by side.
    expect(screen.getByText('Revenue is ahead of plan.')).toBeInTheDocument()
    expect(await screen.findByText('$1,250.00')).toBeInTheDocument()
    expect(screen.getByText('2 healthy · 1 need attention · 0 incomplete')).toBeInTheDocument()
    // A company with no books shows the cash figure as unknown, never as zero.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })

  it('opens the company page for the company that was clicked', async () => {
    render(<CompaniesPage />)

    fireEvent.click(await screen.findByText('OmniRogue'))

    expect(await screen.findByTestId('company-page')).toBeInTheDocument()
    expect(companiesApiMock.company).toHaveBeenCalledWith({ companyId: 'omnirogue' })
  })

  it('asks the person to sign in to OmniOS instead of failing when there is no session', async () => {
    companiesApiMock.rollup.mockResolvedValue(
      refusal('signed_in_required', 'Sign in to OmniConsole before using workflows.')
    )
    render(<CompaniesPage />)

    expect(await screen.findByText('Sign in to OmniOS to see your companies')).toBeInTheDocument()
    expect(screen.getByText(/Check Settings → Backoffice/)).toBeInTheDocument()
  })

  it('keeps the list readable when only the scorecard is unavailable', async () => {
    companiesApiMock.health.mockResolvedValue(refusal('backoffice_refused', 'Scorecard is down.'))
    render(<CompaniesPage />)

    expect(await screen.findByText('OmniRogue')).toBeInTheDocument()
    expect(screen.getByText('Company health is unavailable right now.')).toBeInTheDocument()
  })

  it('shows the estate’s provider bills beside the logged API cost when the scorecard has them', async () => {
    // The main process decodes the document before it crosses IPC.
    companiesApiMock.scorecard.mockResolvedValue(
      ok(
        scorecardDocument.parse({
          generated_at: '2026-09-28T12:00:00Z',
          today: '2026-09-28',
          companies: [],
          ads_accounts: [],
          sources: [],
          provider_bills: {
            timezone: 'UTC',
            not_connected: ['google'],
            days: [
              {
                date: '2026-09-27',
                partial: false,
                billed_known_usd: 1485.68,
                logged: { total: 1866.42 },
                unlogged_known: { openrouter: 341.03, fal: 122.55 }
              }
            ]
          }
        })
      )
    )
    render(<CompaniesPage />)

    expect(
      await screen.findByRole('region', { name: 'API cost — provider bills vs logged' })
    ).toBeInTheDocument()
    expect(screen.getByText('No billing read yet: Google')).toBeInTheDocument()
  })

  it('shows only the companies inside the reader’s access, and says how many', async () => {
    companiesApiMock.me.mockResolvedValue(
      ok({ ok: true, companies: ['omnirogue'], company_scope: 'list' })
    )
    render(<CompaniesPage />)

    expect(await screen.findByText('OmniRogue')).toBeInTheDocument()
    expect(screen.queryByText('BetaCorp')).not.toBeInTheDocument()
    expect(await screen.findByText('Your access covers 1 company.')).toBeInTheDocument()
  })

  it('says the access covers every company when the scope is the whole estate', async () => {
    render(<CompaniesPage />)

    expect(await screen.findByText('Your access covers every company.')).toBeInTheDocument()
    expect(screen.getByText('BetaCorp')).toBeInTheDocument()
  })

  // Why: an unreadable scope is not evidence of wide access. This used to show every
  // company the folder tree returned, so one 500 from the console widened the page.
  it('lists no company when the access scope cannot be read, and says why', async () => {
    companiesApiMock.me.mockResolvedValue(refusal('backoffice_refused', 'Who am I is down.'))
    render(<CompaniesPage />)

    expect(
      await screen.findByText(
        'Your company access could not be read, so nothing is listed. Sign in again or retry.'
      )
    ).toBeInTheDocument()
    expect(screen.queryByText('OmniRogue')).not.toBeInTheDocument()
    expect(screen.queryByText('BetaCorp')).not.toBeInTheDocument()
  })

  it('renders the estate answer of no companies as a statement, not an empty page', async () => {
    // Why: the org tree is the list; the rollup only adds counts — both must be empty.
    companiesApiMock.org.mockResolvedValue(ok({ ok: true, companies: [] }))
    companiesApiMock.rollup.mockResolvedValue(ok({ ok: true, companies: [] }))
    render(<CompaniesPage />)

    expect(
      await screen.findByText('The estate returned no companies for this account.')
    ).toBeInTheDocument()
  })
})

describe('the companies the folder tree shows', () => {
  it('hides an org company that no work is filed under', async () => {
    companiesApiMock.folders.mockResolvedValue(
      ok({ ok: true, companies: [{ id: 'omnirogue', slug: 'omnirogue', name: 'OmniRogue' }] })
    )
    render(<CompaniesPage />)

    expect(await screen.findByText('OmniRogue')).toBeInTheDocument()
    expect(screen.queryByText('BetaCorp')).not.toBeInTheDocument()
    expect(screen.getByText('the 1 with work filed')).toBeInTheDocument()
  })

  // Why: the folder tree fails closed too. It used to match every company whenever the
  // read failed, which turned a transient error into "show the whole estate".
  it('shows no company when the folder tree cannot be read', async () => {
    companiesApiMock.folders.mockResolvedValue(refusal('backoffice_refused', 'Folders are down.'))
    render(<CompaniesPage />)

    expect(
      await screen.findByText('The estate returned no companies for this account.')
    ).toBeInTheDocument()
    expect(screen.queryByText('OmniRogue')).not.toBeInTheDocument()
    expect(screen.queryByText('BetaCorp')).not.toBeInTheDocument()
  })
})
