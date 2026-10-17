import { describe, expect, it, vi } from 'vitest'
import {
  sessionChainStepRoleLabel,
  sessionChainStepRoundLabel,
  sessionChainTeamHeadline
} from './session-chain-team-labels'
import type { SessionChainTeamSummary } from '../../../../shared/session-chain-team'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    Object.entries(values ?? {}).reduce(
      (text, [name, value]) => text.replace(`{{${name}}}`, value),
      fallback
    )
}))

const summary: SessionChainTeamSummary = {
  planning: { source: 'agent-planned', consentedAt: '2026-09-15T18:00:00.000Z', committedAt: 1 },
  seats: [],
  counts: { producer: 1, worker: 2, reviewer: 2, repair: 1 },
  parallelGroups: ['parallel_ship_build'],
  maxRounds: 2
}

describe('session chain team labels', () => {
  it('names each role and the round a step belongs to', () => {
    expect(sessionChainStepRoleLabel('worker')).toBe('Implementer')
    expect(sessionChainStepRoleLabel('repair')).toBe('Repair')
    const review = {
      groupId: 'g',
      reviewerId: 'r',
      round: 2,
      maxRounds: 3,
      candidateVersion: 'v'
    }
    expect(
      sessionChainStepRoundLabel({ id: 's', agent: 'codex', prompt: 'x', status: 'queued', review })
    ).toMatch(/2\/3$/)
    expect(
      sessionChainStepRoundLabel({
        id: 's',
        agent: 'codex',
        prompt: 'x',
        status: 'queued',
        reviewRepair: { groupId: 'g', afterRound: 1, candidateVersion: 'v', consumptionKey: 'k' }
      })
    ).toBe('after round 1')
    expect(
      sessionChainStepRoundLabel({ id: 's', agent: 'codex', prompt: 'x', status: 'queued' })
    ).toBeNull()
  })

  it('says who planned the team and its shape', () => {
    expect(sessionChainTeamHeadline(summary)).toMatch(
      /^Team planned by the agent: 3 implementers · 2 reviewers × 2 rounds · .+ parallel$/
    )
    expect(
      sessionChainTeamHeadline({
        ...summary,
        planning: null,
        counts: { producer: 1, worker: 0, reviewer: 0, repair: 0 },
        parallelGroups: []
      })
    ).toBe('1 implementers')
    expect(sessionChainTeamHeadline(null)).toBeNull()
  })
})
