import { describe, expect, it } from 'vitest'
import { advertisingDecision } from './console-ad-decision-contract'

/**
 * Fidelity to the console's own decision contract, on the two points where this port
 * had drifted looser. Both were found by comparing field-by-field against the original
 * rather than by reading this file, which is the only way a drift like this surfaces.
 */

function decision(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    company: 'omnirogue',
    account_id: 'act_2337',
    operation: {
      mode: 'auto',
      status: 'armed',
      coverage: { evaluated: 4, active: 2, paused: 2 },
      errors: []
    },
    windows: {
      timezone: 'America/New_York',
      today: { start: '2026-09-12T00:00:00-04:00', end: '2026-09-12T12:00:00-04:00' },
      seven: { start: '2026-09-05', end: '2026-09-11' }
    },
    money: { spend_today: 120, active_daily_budget: 300, currency: 'USD' },
    decisions: [],
    policy: { probability_model_calibrated: true },
    ...over
  }
}
const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'd1',
  action: 'pause',
  ...over
})

describe('a figure that cannot be negative is refused when it is', () => {
  it('refuses a negative spend rather than rendering one', () => {
    // The original guards these with a non-negative leaf. Collapsing the two leaves let
    // a negative spend parse, and a negative spend shown as a fact is worse than a
    // refused payload.
    const parsed = advertisingDecision.safeParse(
      decision({ decisions: [row({ today: { spend: -12.5 } })] })
    )
    expect(parsed.success).toBe(false)
  })

  it('refuses a negative cost per result, exposure or CPM', () => {
    for (const field of [
      'cpm',
      'link_ctr',
      'link_cpc',
      'lead_cpl',
      'registration_cpl',
      'purchase_cpa',
      'active_budget_exposure'
    ]) {
      const parsed = advertisingDecision.safeParse(
        decision({ decisions: [row({ today: { [field]: -1 } })] })
      )
      expect(parsed.success, field).toBe(false)
    }
    expect(
      advertisingDecision.safeParse(decision({ decisions: [row({ downside_exposure: -1 })] }))
        .success
    ).toBe(false)
  })

  it('still allows a negative where the original allows one', () => {
    // A contribution, a P&L-shaped figure and a ROAS may legitimately be negative.
    for (const field of ['attributed_revenue', 'matched_revenue', 'roas', 'contribution_profit']) {
      const parsed = advertisingDecision.safeParse(
        decision({ decisions: [row({ today: { [field]: -5 } })] })
      )
      expect(parsed.success, field).toBe(true)
    }
  })

  it('accepts the same figures when they are not negative', () => {
    const parsed = advertisingDecision.safeParse(
      decision({ decisions: [row({ today: { spend: 12.5, purchase_cpa: 60 } })] })
    )
    expect(parsed.success).toBe(true)
  })
})

describe('an absent list is not an empty one', () => {
  it('refuses a payload with no decisions key, as the original does', () => {
    const without = decision()
    delete (without as Record<string, unknown>).decisions
    // Defaulting this to [] made a malformed payload indistinguishable from a cycle
    // that decided nothing.
    expect(advertisingDecision.safeParse(without).success).toBe(false)
  })

  it('accepts an explicitly empty decisions list', () => {
    expect(advertisingDecision.safeParse(decision({ decisions: [] })).success).toBe(true)
  })

  it('leaves next actions undefined when absent, rather than empty', () => {
    const parsed = advertisingDecision.parse(decision())
    expect(parsed.next_actions).toBeUndefined()
    const sent = advertisingDecision.parse(decision({ next_actions: [] }))
    expect(sent.next_actions).toEqual([])
  })
})
