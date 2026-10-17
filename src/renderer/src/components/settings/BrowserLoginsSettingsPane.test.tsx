// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installCompaniesWindowApi, ok } from '../companies/companies-test-fixtures'
import type { BrowserLoginsApi } from '../../../../shared/browser-logins-contract'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

const browserLoginsMock: { [K in keyof BrowserLoginsApi]: ReturnType<typeof vi.fn> } = {
  list: vi.fn(),
  status: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
  verify: vi.fn(),
  add: vi.fn(),
  verifyAll: vi.fn()
}

const profiles = [
  {
    profile_id: 'stripe_omnirogue',
    service: 'Stripe',
    url: 'https://dashboard.stripe.com',
    company_id: 'omnirogue',
    company_slug: 'omnirogue',
    login_status: 'verified',
    verified_at: '2026-09-14T00:00:00Z',
    reason_code: null,
    revision: 2,
    operate_capability: null,
    identity_notice: null,
    // Why: this row has no `open` action — the person may verify it, never re-login it.
    actions: ['verify'],
    notes: null,
    aliases: []
  },
  {
    profile_id: 'freshdesk_acme',
    service: 'Freshdesk',
    url: 'https://acme.freshdesk.com',
    company_id: 'acme',
    company_slug: 'acme',
    login_status: 'sign_in_required',
    verified_at: null,
    reason_code: null,
    revision: 5,
    operate_capability: null,
    identity_notice: null,
    actions: ['open', 'verify'],
    notes: null,
    aliases: []
  }
]

import { BrowserLoginsSettingsPane } from './BrowserLoginsSettingsPane'

function rowFor(serviceName: string): HTMLElement {
  const cell = screen.getByText(serviceName)
  const row = cell.closest('tr')
  if (!row) {
    throw new Error(`no row for ${serviceName}`)
  }
  return row
}

describe('BrowserLoginsSettingsPane', () => {
  beforeEach(() => {
    installCompaniesWindowApi()
    for (const operation of Object.values(browserLoginsMock)) {
      operation.mockReset()
    }
    browserLoginsMock.list.mockResolvedValue(ok({ profiles }))
    Object.assign(window as unknown as { api: { consoleBrowserLogins: unknown } }, {
      api: {
        ...(window as unknown as { api: object }).api,
        consoleBrowserLogins: browserLoginsMock
      }
    })
  })

  // Why: the re-login flow renders a real `src` iframe (the AirTop live view is
  // cross-origin, never `srcDoc`); happy-dom tries to actually navigate it and
  // logs a harmless aborted-fetch error to stderr on unmount. It does not fail
  // the test — the fake `airtop.test` host never resolves.
  afterEach(cleanup)

  it('disables Re-login on a row whose actions do not include open', async () => {
    render(<BrowserLoginsSettingsPane />)

    const row = await screen.findByText('Stripe').then(() => rowFor('Stripe'))
    const reLoginButton = within(row).getByRole('button', { name: 'Re-login' })
    expect(reLoginButton).toBeDisabled()
    const verifyButton = within(row).getByRole('button', { name: 'Verify' })
    expect(verifyButton).not.toBeDisabled()
  })

  it('enables Re-login on a row whose actions include open, and "I\'ve logged in" saves at the opened revision', async () => {
    browserLoginsMock.open.mockResolvedValue(
      ok({
        profile_id: 'freshdesk_acme',
        service: 'Freshdesk',
        login_status: 'sign_in_required',
        revision: 5,
        verified_at: null,
        reason_code: null,
        live_view_url: 'https://airtop.test/live/freshdesk_acme'
      })
    )
    browserLoginsMock.save.mockResolvedValue(
      ok({
        profile_id: 'freshdesk_acme',
        service: 'Freshdesk',
        login_status: 'verified',
        revision: 6,
        verified_at: '2026-09-15T00:00:00Z',
        reason_code: null
      })
    )

    render(<BrowserLoginsSettingsPane />)

    const row = await screen.findByText('Freshdesk').then(() => rowFor('Freshdesk'))
    const reLoginButton = within(row).getByRole('button', { name: 'Re-login' })
    expect(reLoginButton).not.toBeDisabled()

    fireEvent.click(reLoginButton)

    expect(browserLoginsMock.open).toHaveBeenCalledWith({ profile_id: 'freshdesk_acme' })

    const loggedInButton = await screen.findByRole('button', { name: "I've logged in" })
    fireEvent.click(loggedInButton)

    expect(browserLoginsMock.save).toHaveBeenCalledWith({
      profile_id: 'freshdesk_acme',
      expected_revision: 5
    })
  })
})
