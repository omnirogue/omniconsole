import { describe, expect, it } from 'vitest'
import {
  hasNextOutcomeDiscovery,
  NEXT_OUTCOME_AGENT_INSTRUCTIONS,
  prependNextOutcomeDiscovery
} from './next-outcome-intent-instructions'
import {
  NEXT_OUTCOME_TEAM_PLAN_AGENT_INSTRUCTIONS,
  nextOutcomeTeamPlanConsent,
  prependNextOutcomeTeamPlan
} from './next-outcome-team-plan-instructions'
import { buildAgentStartupPlan } from './tui-agent-startup'

const consentedAt = '2026-09-15T18:00:00.000Z'

describe('team planning instruction selection', () => {
  it('keeps the no-fan-out rule for ordinary binding and grants a team only in the planning variant', () => {
    expect(NEXT_OUTCOME_AGENT_INSTRUCTIONS).toContain(
      'Multiple outcomes do not authorize fan-out or additional agents.'
    )
    expect(NEXT_OUTCOME_AGENT_INSTRUCTIONS).not.toContain('Team plan:')
    expect(NEXT_OUTCOME_TEAM_PLAN_AGENT_INSTRUCTIONS).not.toContain('do not authorize fan-out')
    expect(NEXT_OUTCOME_TEAM_PLAN_AGENT_INSTRUCTIONS).toContain('Team plan:')
    expect(NEXT_OUTCOME_TEAM_PLAN_AGENT_INSTRUCTIONS).toContain('at most 8 agents')
    expect(NEXT_OUTCOME_TEAM_PLAN_AGENT_INSTRUCTIONS).toContain('different agent family')
  })

  it('reads consent only from a well-formed launch marker', () => {
    const prompt = prependNextOutcomeTeamPlan('Ship the export', 'omni', consentedAt)
    expect(nextOutcomeTeamPlanConsent(prompt)).toEqual({ consentedAt })
    expect(nextOutcomeTeamPlanConsent(prependNextOutcomeDiscovery('Ship it', 'omni'))).toBeNull()
    expect(
      nextOutcomeTeamPlanConsent('<!-- omni-team-plan-v1 consented-at=2026-13-45T99:00:00Z -->')
    ).toBeNull()
    expect(nextOutcomeTeamPlanConsent(undefined)).toBeNull()
  })

  it('selects the planning launch variant only with consent and never doubles the discovery prefix', () => {
    const base = { agent: 'claude' as const, cmdOverrides: {}, platform: 'darwin' as const }
    const planned = buildAgentStartupPlan({
      ...base,
      prompt: 'Ship the export',
      teamPlanConsentedAt: consentedAt
    })
    const bound = buildAgentStartupPlan({ ...base, prompt: 'Ship the export' })
    expect(planned?.launchCommand).toContain('Plan the team')
    expect(planned?.launchCommand).toContain(`consented-at=${consentedAt}`)
    expect(bound?.launchCommand).not.toContain('Plan the team')
    expect(bound?.launchCommand).not.toContain('omni-outcome-source-v1')
    const once = prependNextOutcomeTeamPlan('Ship the export', 'omni', consentedAt)
    expect(hasNextOutcomeDiscovery(once)).toBe(true)
    expect(prependNextOutcomeTeamPlan(once, 'omni', consentedAt)).toBe(once)
    expect(prependNextOutcomeDiscovery(once, 'omni')).toBe(once)
    expect(prependNextOutcomeTeamPlan('', 'omni', consentedAt)).toBe('')
  })
})
