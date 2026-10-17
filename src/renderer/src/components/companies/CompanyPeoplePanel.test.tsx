// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { companiesApiMock, installCompaniesWindowApi, refusal } from './companies-test-fixtures'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, text: string) => text,
  i18n: { language: 'en' }
}))

import { CompanyPeoplePanel } from './CompanyPeoplePanel'

beforeEach(() => {
  installCompaniesWindowApi()
})
afterEach(cleanup)

describe('People', () => {
  it('lists each unit with its lead and members, and everyone else below', async () => {
    render(<CompanyPeoplePanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Show the org chart' }))

    expect(await screen.findByText('Advertising')).toBeInTheDocument()
    const chart = screen.getByTestId('company-people')
    expect(chart.textContent).toContain('Sal')
    expect(chart.textContent).toContain('· Ads')
    expect(chart.textContent).toContain('iris@example.com')
    expect(screen.getByText('Everyone else')).toBeInTheDocument()
    expect(chart.textContent).toContain('Uma')
  })

  it('does not read the org chart until it is opened', () => {
    render(<CompanyPeoplePanel />)

    expect(companiesApiMock.orgChart).not.toHaveBeenCalled()
  })

  it('shows the notice when the org chart is refused', async () => {
    companiesApiMock.orgChart.mockResolvedValue(refusal('backoffice_refused', 'Org chart is down.'))
    render(<CompanyPeoplePanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Show the org chart' }))

    expect(await screen.findByText('Org chart is down.')).toBeInTheDocument()
  })
})
