// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CompanyDetail } from './CompanyDetail'
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

beforeEach(() => {
  installCompaniesWindowApi()
})
afterEach(cleanup)

describe('one company', () => {
  it('shows the goals, the hub cockpit, the scorecard and the money together', async () => {
    render(<CompanyDetail companyId="omnirogue" />)

    expect(await screen.findByText('Double enterprise revenue')).toBeInTheDocument()
    expect(screen.getByText('Ship the new onboarding')).toBeInTheDocument()
    expect(screen.getByTestId('company-cockpit-summary')).toBeInTheDocument()
    // Cockpit figures are the hub's own numbers, each under its own label.
    const cockpit = screen.getByTestId('company-cockpit-summary')
    expect(cockpit.textContent).toContain('Human work')
    expect(cockpit.textContent).toContain('active 2 · planned 1')
    expect(cockpit.textContent).toContain('running')
    expect(await screen.findByText('Revenue is ahead of plan.')).toBeInTheDocument()
    expect(await screen.findByText('Cost per lead is rising.')).toBeInTheDocument()
    expect(await screen.findByText('Stripe payout')).toBeInTheDocument()
    expect(screen.getAllByText('$1,250.00').length).toBeGreaterThan(0)
  })

  it('narrows the goals and the scorecard to the department that was chosen', async () => {
    render(<CompanyDetail companyId="omnirogue" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Advertising (2)' }))

    expect(screen.getByText('Double enterprise revenue')).toBeInTheDocument()
    expect(screen.queryByText('Ship the new onboarding')).not.toBeInTheDocument()
    expect(screen.getByTestId('company-page').textContent).toContain('workstreams: meta, creative')
    // The scorecard follows the same department, down to its own measurements.
    expect(await screen.findByText('Above the $30 ceiling.')).toBeInTheDocument()
  })

  it('asks the bank to refresh and confirms it without touching the saved data', async () => {
    render(<CompanyDetail companyId="omnirogue" />)

    fireEvent.click(await screen.findByRole('button', { name: /Refresh bank data/ }))

    await waitFor(() =>
      expect(companiesApiMock.syncAccounting).toHaveBeenCalledWith({ company: 'omnirogue' })
    )
    expect(
      await screen.findByText(
        'Bank refresh requested. This view updates when the new data arrives.'
      )
    ).toBeInTheDocument()
  })

  it('downloads the bank export through the signed transport', async () => {
    const createObjectURL = vi.fn(() => 'blob:export')
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() })
    render(<CompanyDetail companyId="omnirogue" />)

    fireEvent.click(await screen.findByRole('button', { name: /Download CSV/ }))

    await waitFor(() =>
      expect(companiesApiMock.transactionsCsv).toHaveBeenCalledWith({ company: 'omnirogue' })
    )
    expect(createObjectURL).toHaveBeenCalled()
  })

  it('shows the sign-in notice rather than a blank company when there is no session', async () => {
    companiesApiMock.company.mockResolvedValue(
      refusal('signed_in_required', 'Sign in to OmniConsole before using workflows.')
    )
    render(<CompanyDetail companyId="omnirogue" />)

    expect(await screen.findByText('Sign in to OmniOS to see your companies')).toBeInTheDocument()
  })

  it('refuses a company outside the reader’s access instead of reading it', async () => {
    companiesApiMock.me.mockResolvedValue(
      ok({ ok: true, companies: ['apexlabs'], company_scope: 'list' })
    )
    render(<CompanyDetail companyId="omnirogue" />)

    expect(await screen.findByText('This company is outside your access.')).toBeInTheDocument()
    expect(screen.queryByTestId('company-page')).not.toBeInTheDocument()
  })

  it('offers a session for the company and for each department', async () => {
    render(<CompanyDetail companyId="omnirogue" />)

    expect(await screen.findByRole('button', { name: /Start Work/ })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Start' })).toHaveLength(2)
  })

  it('keeps the page up when the accounting read is refused', async () => {
    companiesApiMock.accounting.mockResolvedValue(refusal('backoffice_refused', 'Books are down.'))
    render(<CompanyDetail companyId="omnirogue" />)

    expect(await screen.findByText('Double enterprise revenue')).toBeInTheDocument()
    expect(await screen.findByText('Books are down.')).toBeInTheDocument()
  })
})
