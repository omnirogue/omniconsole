// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QuickBooksPanel } from './QuickBooksPanel'

let host: HTMLDivElement
let root: Root
let answer: unknown

function install(value: unknown): void {
  answer = value
  ;(globalThis as { window?: unknown }).window = Object.assign(globalThis.window ?? {}, {
    api: { consoleQuickBooks: { status: () => Promise.resolve(answer) } }
  })
}

async function render(node: React.ReactNode): Promise<void> {
  await act(async () => {
    root.render(node)
  })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  act(() => {
    root = createRoot(host)
  })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

const connected = {
  ok: true,
  data: {
    provider: 'quickbooks',
    oauth: { configured: true, connect_supported: true, missing_requirements: [] },
    companies: [
      {
        company_id: 'c1',
        company_slug: 'omnirogue',
        company_name: 'OmniRogue Inc',
        realm_id: '9341',
        mapped_company_name: null,
        status: 'connected_enabled',
        reason_code: null,
        checked_at: '2026-09-12T12:00:00Z',
        reviewed_by: null,
        mappings: [
          { ledger_kind: 'cash', account_id: 'a1', expected_type: 'Bank', source_account_id: 's1' }
        ]
      }
    ],
    sync_health: 'ready'
  }
}

describe('the books connection panel', () => {
  it('names the company, its state and what it has mapped', async () => {
    install(connected)
    await render(<QuickBooksPanel slug="omnirogue" revision={0} />)
    expect(host.textContent).toContain('OmniRogue Inc')
    expect(host.textContent).toContain('Feed enabled')
    expect(host.textContent).toContain('1 ledger accounts mapped')
    expect(host.textContent).toContain('realm 9341')
  })

  it('says what a stuck connection is waiting on, in words', async () => {
    install({
      ok: true,
      data: {
        ...connected.data,
        companies: [
          {
            ...connected.data.companies[0],
            status: 'waiting_for_access',
            reason_code: 'access_missing',
            checked_at: null,
            mappings: []
          }
        ]
      }
    })
    await render(<QuickBooksPanel slug="omnirogue" revision={0} />)
    expect(host.textContent).toContain('Access needed')
    expect(host.textContent).toContain('Authorize access to this QuickBooks company')
    expect(host.textContent).toContain('no ledger accounts mapped')
    expect(host.textContent).toContain('Never checked')
  })

  it('distinguishes a failed read from books that are not connected', async () => {
    // The important one. One is this app's problem; the other is a fact about the
    // company's accounting, and showing the first as the second would be a lie.
    install({ ok: false, error: { code: 'backoffice_unavailable', message: 'unreachable' } })
    await render(<QuickBooksPanel slug="omnirogue" revision={0} />)
    expect(host.textContent).toContain('could not be read')
    expect(host.textContent).toContain('state is unknown')
    expect(host.textContent).not.toContain('Feed not enabled')
    expect(host.textContent).not.toContain('No QuickBooks company is tracked')
  })

  it('says the app connection is unconfigured and what it still needs', async () => {
    install({
      ok: true,
      data: {
        ...connected.data,
        oauth: {
          configured: false,
          connect_supported: false,
          missing_requirements: ['client_secret']
        },
        companies: []
      }
    })
    await render(<QuickBooksPanel slug="omnirogue" revision={0} />)
    expect(host.textContent).toContain('not configured yet')
    expect(host.textContent).toContain('client_secret')
  })

  it('shows only the selected company’s connection', async () => {
    install({
      ok: true,
      data: {
        ...connected.data,
        companies: [
          connected.data.companies[0],
          { ...connected.data.companies[0], company_slug: 'acme', company_name: 'ACME' }
        ]
      }
    })
    await render(<QuickBooksPanel slug="acme" revision={0} />)
    expect(host.textContent).toContain('ACME')
    expect(host.textContent).not.toContain('OmniRogue Inc')
  })

  it('says on its face that it reads only', async () => {
    install(connected)
    await render(<QuickBooksPanel slug="omnirogue" revision={0} />)
    expect(host.textContent).toContain('reads only')
    expect(host.textContent).toContain('stay in OmniOS')
  })
})
