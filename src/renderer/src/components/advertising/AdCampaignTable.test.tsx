// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AdCampaignTable } from './AdCampaignTable'
import { campaignGroups } from './advertising-model'
import { salesAdRow, type SalesAdRow } from '../../../../shared/console-advertising-contract'

let host: HTMLDivElement
let root: Root

function row(over: Record<string, unknown> = {}): SalesAdRow {
  return salesAdRow.parse({
    id: 'r',
    platform_id: 'p',
    level: 'campaign',
    name: 'Campaign',
    campaign_id: 'p',
    campaign_name: 'Campaign',
    parent_id: null,
    segment: 'dtc',
    status: 'ACTIVE',
    effective_status: 'ACTIVE',
    spend: 120,
    link_clicks: 60,
    cpc_link: null,
    checkouts: 4,
    add_to_carts: 8,
    impressions: 10_000,
    reach: 5000,
    revenue: 480,
    leads: 3,
    lead_event: 'Lead',
    registrations: 12,
    purchases: 2,
    daily_budget: 100,
    can_pause: true,
    pause_blocker: null,
    measured_at: '2026-09-12T12:00:00Z',
    ...over
  })
}

function render(node: React.ReactNode): void {
  act(() => {
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
})

describe('the campaign and ad-set table', () => {
  const campaign = row({ platform_id: 'c1', campaign_id: 'c1', name: 'Live campaign' })
  const adSet = row({
    id: 'a1',
    platform_id: 'as1',
    level: 'adset',
    campaign_id: 'c1',
    name: 'Live ad set',
    spend: 60,
    purchases: 1,
    registrations: 6
  })

  it('shows the campaign with its active and total ad-set counts', () => {
    const groups = campaignGroups([campaign], [adSet], { liveOnly: true })
    render(<AdCampaignTable groups={groups} liveOnly currency="USD" />)
    expect(host.textContent).toContain('Live campaign')
    expect(host.textContent).toContain('1 / 1 ad sets')
  })

  it('reveals the ad sets only once the campaign is expanded', () => {
    const groups = campaignGroups([campaign], [adSet], { liveOnly: true })
    render(<AdCampaignTable groups={groups} liveOnly currency="USD" />)
    expect(host.textContent).not.toContain('Live ad set')
    const toggle = host.querySelector('[aria-expanded="false"]') as HTMLButtonElement
    act(() => toggle.click())
    expect(host.textContent).toContain('Live ad set')
  })

  it('prints an em dash, not a zero, for a cost nobody could compute', () => {
    const noPurchases = row({
      platform_id: 'c2',
      campaign_id: 'c2',
      name: 'No purchases',
      purchases: 0
    })
    render(
      <AdCampaignTable
        groups={campaignGroups([noPurchases], [], { liveOnly: false })}
        liveOnly={false}
        currency="USD"
      />
    )
    // A zero-purchase campaign has no cost per purchase; it does not have a free one.
    const empties = host.querySelectorAll('[data-empty]')
    expect(empties.length).toBeGreaterThan(0)
    expect([...empties].every((cell) => cell.textContent?.includes('—'))).toBe(true)
  })

  it('withholds the cost per lead when the account maps no Lead event', () => {
    const unmapped = row({ platform_id: 'c3', campaign_id: 'c3', lead_event: null, leads: 9 })
    render(
      <AdCampaignTable
        groups={campaignGroups([unmapped], [], { liveOnly: false })}
        liveOnly={false}
        currency="USD"
      />
    )
    const explained = [...host.querySelectorAll('td[title]')].filter((cell) =>
      cell.getAttribute('title')?.includes('no Meta Lead event')
    )
    // Both the count and the cost say so, rather than showing a CPL that is not one.
    expect(explained).toHaveLength(2)
  })

  it('says the window was quiet rather than drawing an empty table', () => {
    render(<AdCampaignTable groups={[]} liveOnly currency="USD" />)
    expect(host.textContent).toContain('No live campaigns in this window')
    expect(host.textContent).toContain('include spend before any pause')
  })

  it('warns when the account does not report in dollars', () => {
    render(
      <AdCampaignTable
        groups={campaignGroups([campaign], [], { liveOnly: false })}
        liveOnly={false}
        currency="EUR"
      />
    )
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('EUR')
  })

  it('marks an ad set whose status the provider did not report', () => {
    const unknown = row({
      id: 'a2',
      platform_id: 'as2',
      level: 'adset',
      campaign_id: 'c1',
      name: 'Unknown status',
      status: null,
      effective_status: null
    })
    const groups = campaignGroups([campaign], [unknown], { liveOnly: false })
    render(<AdCampaignTable groups={groups} liveOnly={false} currency="USD" />)
    expect(host.textContent).toContain('1 status unknown')
    const toggle = host.querySelector('[aria-expanded="false"]') as HTMLButtonElement
    act(() => toggle.click())
    expect(host.textContent).toContain('Status unknown')
  })

  it('shows the daily budget beside the spend, as a separate column', () => {
    render(
      <AdCampaignTable
        groups={campaignGroups([campaign], [], { liveOnly: false })}
        liveOnly={false}
        currency="USD"
      />
    )
    const headers = [...host.querySelectorAll('th[scope="col"]')].map((cell) => cell.textContent)
    expect(headers).toContain('Spend')
    expect(headers).toContain('Daily budget')
    // The allowance and the money that moved are never the same column.
    expect(headers.indexOf('Spend')).not.toBe(headers.indexOf('Daily budget'))
  })
})
