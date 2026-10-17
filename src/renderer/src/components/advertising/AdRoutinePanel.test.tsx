// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AdRoutinePanel } from './AdRoutinePanel'
import { routineContext } from './advertising-model'
import type { AdvertisingDecisionRow } from '../../../../shared/console-advertising-contract'

let host: HTMLDivElement
let root: Root

function render(node: React.ReactNode): void {
  act(() => {
    root.render(node)
  })
}

const decision = {
  operation: {
    mode: 'auto' as const,
    status: 'armed',
    account_state: 'ARMED',
    interval_minutes: 15,
    last_evaluated_at: '2026-09-12T15:40:00Z',
    last_successful_evaluation_at: '2026-09-12T15:30:00Z',
    next_due_at: null,
    insights_age_seconds: 1800,
    insights_observed_at: '2026-09-12T15:00:00Z',
    spend_observed_at: null,
    fact_coverage_complete: true,
    coverage: { evaluated: 12, active: 4, paused: 8, campaigns: 4, adsets: 12, ads: 20 },
    errors: []
  },
  money: {
    spend_today: 120,
    active_daily_budget: 300,
    spending_limit_remaining: 900,
    currency: 'USD'
  },
  policy: { probability_model_calibrated: true }
}

function proposal(over: Partial<AdvertisingDecisionRow> = {}): AdvertisingDecisionRow {
  return {
    id: 'd1',
    object_id: 'as1',
    name: 'DTC ad set',
    level: 'adset',
    segment: 'dtc',
    campaign_id: 'c1',
    campaign_name: 'Campaign',
    adset_id: 'as1',
    adset_name: 'DTC ad set',
    action: 'pause',
    reason: 'Spend with no link clicks',
    basis: 'calibrated_model',
    uncertainty: [],
    status: 'proposed',
    probability: 0.82,
    credible_interval: [0.7, 0.9],
    calibration_status: 'calibrated',
    expected_benefit: null,
    expected_additional_contribution: null,
    downside_exposure: null,
    blockers: [],
    observed_at: '2026-09-12T15:00:00Z',
    evidence_revision: 'abc',
    today: null,
    seven: null,
    ...over
  } as AdvertisingDecisionRow
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

describe('the routine behind the figures', () => {
  it('keeps the active budget and the spend as two separate figures', () => {
    render(
      <AdRoutinePanel context={routineContext(decision as never)} decisions={[]} note={null} />
    )
    expect(host.textContent).toContain('Active daily budget')
    expect(host.textContent).toContain('$300')
    expect(host.textContent).toContain('Spend today')
    expect(host.textContent).toContain('$120')
  })

  it('states how old the provider observation is, separately from when it ran', () => {
    render(
      <AdRoutinePanel context={routineContext(decision as never)} decisions={[]} note={null} />
    )
    // Its last run is not a live read, so both times are on screen.
    expect(host.textContent).toContain('Last evaluated')
    expect(host.textContent).toContain('provider observation')
    expect(host.textContent).toContain('30 min old')
  })

  it('shows a probability only beside its interval and its calibration', () => {
    render(
      <AdRoutinePanel
        context={routineContext(decision as never)}
        decisions={[proposal()]}
        note={null}
      />
    )
    expect(host.textContent).toContain('Estimated probability 82%')
    expect(host.textContent).toContain('credible 70% to 90%')
    expect(host.textContent).toContain('calibrated')
  })

  it('calls an uncalibrated estimate a guess, in those words', () => {
    render(
      <AdRoutinePanel
        context={routineContext(decision as never)}
        decisions={[proposal({ calibration_status: 'uncalibrated' })]}
        note={null}
      />
    )
    expect(host.textContent).toContain('not calibrated')
    expect(host.textContent).toContain('treat as a guess')
  })

  it('says the evidence was insufficient rather than drawing a bare number', () => {
    render(
      <AdRoutinePanel
        context={routineContext(decision as never)}
        decisions={[proposal({ credible_interval: null })]}
        note={null}
      />
    )
    expect(host.textContent).toContain('no interval: evidence insufficient')
  })

  it('shows no probability line at all when none was estimated', () => {
    render(
      <AdRoutinePanel
        context={routineContext(decision as never)}
        decisions={[proposal({ probability: null })]}
        note={null}
      />
    )
    expect(host.textContent).not.toContain('Estimated probability')
    // The decision itself still reads, with its basis.
    expect(host.textContent).toContain('Spend with no link clicks')
    expect(host.textContent).toContain('calibrated_model')
  })

  it('warns once, at the top, when the model is not calibrated for the account', () => {
    render(
      <AdRoutinePanel
        context={routineContext({
          ...decision,
          policy: { probability_model_calibrated: false }
        } as never)}
        decisions={[]}
        note={null}
      />
    )
    expect(host.textContent).toContain('probability model is not calibrated')
  })

  it('names its uncertainty and its blockers rather than hiding them', () => {
    render(
      <AdRoutinePanel
        context={routineContext(decision as never)}
        decisions={[
          proposal({ uncertainty: ['delayed conversions'], blockers: ['awaiting approval'] })
        ]}
        note={null}
      />
    )
    expect(host.textContent).toContain('Uncertainty: delayed conversions')
    expect(host.textContent).toContain('Blocked by: awaiting approval')
  })

  it('says the figures came straight from the provider when no coordinator answered', () => {
    render(<AdRoutinePanel context={null} decisions={[]} note={null} />)
    expect(host.textContent).toContain('No single account coordinator answered')
    expect(host.textContent).toContain('straight from the provider report')
  })

  it('says on its face that it reads only', () => {
    render(
      <AdRoutinePanel context={routineContext(decision as never)} decisions={[]} note={null} />
    )
    expect(host.textContent).toContain('This view reads only')
    expect(host.textContent).toContain('stay in OmniOS')
  })

  it('flags an observation that is hours old rather than letting it read as current', () => {
    render(
      <AdRoutinePanel
        context={routineContext({
          ...decision,
          operation: { ...decision.operation, insights_age_seconds: 4 * 3600 }
        } as never)}
        decisions={[]}
        note={null}
      />
    )
    const stale = [...host.querySelectorAll('span')].some(
      (element) =>
        element.className.includes('amber') && element.textContent?.includes('provider observation')
    )
    expect(stale).toBe(true)
  })
})
