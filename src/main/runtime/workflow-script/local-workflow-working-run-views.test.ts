import { describe, expect, it } from 'vitest'
import { createLocalWorkflowDraft } from '../../../shared/local-workflow-draft'
import type { ResolvedLocalWorkflowSeat } from '../../../shared/local-workflow-seats'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import { projectCouncilRun } from './local-workflow-council-projection'
import { projectDiscoverRun } from './local-workflow-discover-projection'
import { selectDiscoverFindings, type FindingBatch } from './presets/discover-assessment'

// Runs admitted by the working-agent release (Council revision 5, Discover revision 6) exist on
// installed apps; the current run views read them through the same councilRun/discoverRun shapes.

const seats: ResolvedLocalWorkflowSeat[] = (
  [
    ['claude', 'anthropic'],
    ['codex', 'openai'],
    ['grok', 'xai']
  ] as const
).map(([agent, lineage]) => ({
  id: agent,
  agent,
  lineage,
  accountId: `${agent}-account`,
  model: `${agent}-model`,
  effort: null,
  policyRevision: 'fixture-v1'
}))

const working: LocalWorkflowHostSnapshot = {
  version: 1,
  capability: { mode: 'working-agent', revision: 1 },
  task: { prompt: 'Build the landing page', evidence: 'Inspect the selected Git project.' },
  seats,
  synthesizerId: 'claude',
  discover: createLocalWorkflowDraft('discover').discover,
  host: {
    workspaceId: 'workspace',
    conversationId: 'conversation',
    requestDigest: 'digest',
    startedAt: 1,
    concurrency: 3,
    sources: [],
    coverage: []
  }
}

function ballot(labels: string[]) {
  return {
    ranking: labels,
    assessments: labels.map((label) => ({ label, strengths: 'Renders', weaknesses: 'Untested' }))
  }
}

describe('working Council (revision 5) in the current run view', () => {
  const council: LocalWorkflowHostSnapshot = {
    ...working,
    councilProgramRevision: 5,
    // Shuffled at admission: Claude wrote Response C, Codex Response A, Grok Response B.
    councilBlindLabels: ['Response C', 'Response A', 'Response B']
  }

  it('keeps the pinned blind labels and ranks blind peer ballots', () => {
    const results = new Map<string, unknown>([
      ['peer/claude', ballot(['Response A', 'Response B'])],
      ['peer/codex', ballot(['Response B', 'Response C'])],
      ['peer/grok', ballot(['Response A', 'Response C'])]
    ])
    const run = projectCouncilRun(council, results, [])!
    expect(run.members.map((member) => [member.seatId, member.label, member.answerCallId])).toEqual(
      [
        ['claude', 'Response C', 'answers/claude'],
        ['codex', 'Response A', 'answers/codex'],
        ['grok', 'Response B', 'answers/grok']
      ]
    )
    expect(run.chair?.seatId).toBe('claude')
    expect(run.ballots.map((entry) => entry.callId)).toEqual([
      'peer/claude',
      'peer/codex',
      'peer/grok'
    ])
    expect(run.standings.map((entry) => [entry.label, entry.seatId, entry.place])).toEqual([
      ['Response A', 'codex', 1],
      ['Response B', 'grok', 2],
      ['Response C', 'claude', 3]
    ])
  })

  it('skips a ballot that does not match the pinned labels instead of throwing', () => {
    const results = new Map<string, unknown>([
      // Claude reviewed Codex (A) and Grok (B); its own label C is not a valid choice.
      ['peer/claude', ballot(['Response C', 'Response A'])],
      ['peer/codex', ballot(['Response B', 'Response C'])]
    ])
    expect(() => projectCouncilRun(council, results, [])).not.toThrow()
    const run = projectCouncilRun(council, results, [])!
    expect(run.ballots.map((entry) => entry.reviewerSeatId)).toEqual(['codex'])
    expect(run.standings).toEqual([])
  })
})

describe('working Discover (revision 6) in the current run view', () => {
  const discover: LocalWorkflowHostSnapshot = { ...working, discoverProgramRevision: 6 }
  const config = discover.discover!
  const found: FindingBatch = {
    findings: [
      {
        issueKey: 'double-charge',
        title: 'Double charge',
        location: 'src/pay.ts:12',
        trigger: 'Retry',
        impact: 'Charged twice, and an unproved refund loss',
        severity: 'high',
        evidence: [{ ref: 'src/pay.ts:12', description: 'No idempotency key' }]
      }
    ],
    omittedCount: 0,
    omissionReason: ''
  }
  const empty: FindingBatch = { findings: [], omittedCount: 0, omissionReason: '' }
  const batches = [found, empty, empty]
  // The working projection selects with the post-cluster quota, like revision 5.
  const id = selectDiscoverFindings(batches, {
    ...config,
    maxCandidates: 12,
    revision: 5,
    finderId: 'claude'
  }).selected[0].id

  function results(severity: string): Map<string, unknown> {
    const map = new Map<string, unknown>(
      config.dimensions.map((dimension, index) => [`discover/${dimension}`, batches[index]])
    )
    for (const lens of config.lenses) {
      map.set(`refute/${id}/${lens}`, {
        refuted: false,
        uncertain: false,
        reason: 'Reproduced in a scratch worktree',
        evidence: []
      })
    }
    map.set('rank/final', {
      summary: 'One real double charge',
      ranking: [
        {
          findingId: id,
          reason: 'A retry charges twice',
          nextAction: 'Send an idempotency key',
          finding: {
            title: 'Double charge on retry',
            location: 'src/pay.ts:12',
            trigger: 'Retry',
            impact: 'Charged twice',
            severity,
            evidence: [{ ref: 'src/pay.ts:12', description: 'No idempotency key' }]
          }
        }
      ]
    })
    return map
  }

  it('shows the reviewed finding, its votes and the ranked report', () => {
    const run = projectDiscoverRun(discover, results('high'), [])!
    expect(run.findings).toHaveLength(1)
    expect(run.findings[0]).toMatchObject({
      id,
      title: 'Double charge on retry',
      location: 'src/pay.ts:12',
      severity: 'high',
      status: 'confirmed'
    })
    expect(run.findings[0].votes.map((vote) => vote.verdict)).toEqual(['real', 'real'])
    expect(run.report).toMatchObject({
      summary: 'One real double charge',
      items: [
        {
          rank: 1,
          title: 'Double charge on retry',
          scenario: 'A retry charges twice',
          fix: 'Send an idempotency key',
          findingIds: [id]
        }
      ]
    })
  })

  it('keeps the view when a reviewed ranking fails its own validation', () => {
    // A reviewed ranking may not change the survivor's severity; the evidence projection refuses it.
    expect(() => projectDiscoverRun(discover, results('low'), [])).not.toThrow()
    expect(projectDiscoverRun(discover, results('low'), [])).toMatchObject({
      findings: [],
      report: { summary: 'One real double charge' }
    })
  })
})
