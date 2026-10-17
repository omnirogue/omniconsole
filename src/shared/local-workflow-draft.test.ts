import { describe, expect, it } from 'vitest'
import {
  createLocalWorkflowDraft,
  createLocalWorkflowGraphDraft,
  DISCOVER_MAX_FINDINGS_PER_JOB,
  DISCOVER_MIN_AGENTS,
  discoverRoundBudget,
  estimateDiscoverAgents
} from './local-workflow-draft'
import { localWorkflowAnchorSchema } from './local-workflow-session-schema'
import { workflowTemplate } from './workflow-graph-templates'

describe('Discover round budget', () => {
  it('runs every job while each can report one finding and spreads the rest as extra findings', () => {
    // 24 jobs and the repeat check leave 133 of 158 calls for votes: 44 findings, two for the
    // first twenty jobs.
    const { findingLimits, repeatCheck } = discoverRoundBudget(158, 24)
    expect(findingLimits).toHaveLength(24)
    expect(findingLimits.filter((limit) => limit === 2)).toHaveLength(20)
    expect(findingLimits.slice(20)).toEqual([1, 1, 1, 1])
    expect(repeatCheck).toBe(1)
    const total = findingLimits.reduce((sum, limit) => sum + limit, 0)
    expect(24 + total * 3 + repeatCheck).toBeLessThanOrEqual(158)
  })

  it('keeps a repeat check only for a round that can report two findings, never at a finder job', () => {
    // One finding cannot repeat another.
    expect(discoverRoundBudget(4, 6)).toEqual({ findingLimits: [1], repeatCheck: 0 })
    // Two jobs of one finding fill eight calls; the check would cost one of the jobs.
    expect(discoverRoundBudget(8, 4)).toEqual({ findingLimits: [1, 1], repeatCheck: 0 })
    // Nine calls fit both jobs, their votes and the check.
    expect(discoverRoundBudget(9, 4)).toEqual({ findingLimits: [1, 1], repeatCheck: 1 })
    expect(discoverRoundBudget(18, 2)).toEqual({ findingLimits: [3, 2], repeatCheck: 1 })
  })

  it('never lets a job report more than its schema allows', () => {
    expect(discoverRoundBudget(398, 6).findingLimits).toEqual(
      Array.from({ length: 6 }, () => DISCOVER_MAX_FINDINGS_PER_JOB)
    )
  })

  it('drops jobs only when the budget cannot give each one finding and its votes', () => {
    expect(discoverRoundBudget(12, 6)).toEqual({ findingLimits: [1, 1, 1], repeatCheck: 0 })
    expect(discoverRoundBudget(3, 6).findingLimits).toEqual([])
    expect(discoverRoundBudget(-1, 6).findingLimits).toEqual([])
  })
})

describe('Discover agent estimate', () => {
  it('ranges from a dry run with no map to the most any run can use', () => {
    // Quick with three lenses: without a map, the scout and three finder jobs at least. At most
    // 159 of 160: after the scout, 24 finder jobs, their repeat check, 44 findings' votes and
    // Rank, too little is left for one more.
    expect(estimateDiscoverAgents(3, 'quick', 160)).toEqual({ low: 4, high: 159, capped: true })
    // Exhaustive stops after two dry rounds.
    expect(estimateDiscoverAgents(3, 'exhaustive', 160).low).toBe(7)
    // One lens and a generous budget: 8 jobs of 8 findings, 1 + 8 + 1 + 192 + 1 calls.
    expect(estimateDiscoverAgents(1, 'quick', 400)).toEqual({ low: 2, high: 203, capped: false })
  })

  it('counts runs that fit another round by finding less, not only full ones', () => {
    // Filling round 1 leaves 1 call; finding two fewer leaves 7, room for a job with 2 findings.
    expect(estimateDiscoverAgents(3, 'thorough', 160).high).toBe(160)
    // Eight areas fit exactly: 1 + 16 + 1 (the repeat check) + 47 * 3 + 1.
    expect(estimateDiscoverAgents(2, 'quick', 160).high).toBe(160)
  })

  it('never exceeds the budget and treats out-of-range budgets as admission does', () => {
    for (const depth of ['quick', 'thorough', 'exhaustive'] as const) {
      for (const maxAgents of [DISCOVER_MIN_AGENTS, 20, 160, 400]) {
        const estimate = estimateDiscoverAgents(6, depth, maxAgents)
        expect(estimate.high).toBeLessThanOrEqual(maxAgents)
        expect(estimate.low).toBeLessThanOrEqual(estimate.high)
      }
    }
    expect(estimateDiscoverAgents(3, 'quick', 1)).toEqual(
      estimateDiscoverAgents(3, 'quick', DISCOVER_MIN_AGENTS)
    )
    expect(estimateDiscoverAgents(0, 'quick', 160)).toEqual(estimateDiscoverAgents(1, 'quick', 160))
  })
})

describe('where a draft runs', () => {
  it('defaults every preset and graph draft to the fleet, and keeps an explicit opt-in', () => {
    expect(createLocalWorkflowDraft('council').runsOn).toBe('fleet')
    expect(createLocalWorkflowDraft('discover').runsOn).toBe('fleet')
    const graph = { spec: workflowTemplate('council', ['claude', 'codex']), team: [] }
    expect(createLocalWorkflowGraphDraft({ prompt: 'x', graph }).runsOn).toBe('fleet')
    expect(createLocalWorkflowGraphDraft({ prompt: 'x', graph, runsOn: 'local' }).runsOn).toBe(
      'local'
    )
  })

  it('restores an anchor saved before the choice existed without inventing a placement', () => {
    // Older builds saved no `runsOn`; the host treats its absence as fleet for a new Start.
    const { runsOn: _dropped, ...legacy } = createLocalWorkflowDraft('council')
    const anchor = (draft: object) =>
      localWorkflowAnchorSchema.parse({ preset: 'council', prompt: 'x', draft }).draft
    expect(anchor(legacy)).not.toHaveProperty('runsOn')
    expect(anchor({ ...legacy, runsOn: 'local' })?.runsOn).toBe('local')
    expect(() => anchor({ ...legacy, runsOn: 'cloud' })).toThrow()
  })
})
