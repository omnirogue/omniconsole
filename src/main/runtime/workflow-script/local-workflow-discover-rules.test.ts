import { describe, expect, it } from 'vitest'
import { createLocalWorkflowDraft } from '../../../shared/local-workflow-draft'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import {
  discoverResultMarkdown,
  projectDiscoverRun,
  workflowCallSeatId
} from './local-workflow-discover-projection'
import { discoverStageDefinitions } from './local-workflow-discover-stages'
import { DISCOVER_V7_RULES } from './presets/discover-v7-config'
import { DISCOVER_V7_VERIFY_LENSES } from './presets/discover-v7-plan'
import { areas, finding, seats, task, vote } from './presets/discover-v7.test-fixtures'

/**
 * A run admitted before rules 2 has no host.discoverRules. An earlier build made its records with
 * the plain finder rotation and with jobs that reported only their share, so its view must replay
 * those rules, not the current ones.
 */
const before: LocalWorkflowHostSnapshot = {
  version: 1,
  discoverProgramRevision: 7,
  access: 'workspace-read',
  task,
  seats,
  synthesizerId: 'claude',
  discover: {
    ...createLocalWorkflowDraft('discover').discover,
    finderIds: ['codex', 'grok', 'gemini'],
    lensIds: ['correctness', 'security'],
    depth: 'quick',
    focus: ['src'],
    maxAgents: 20
  },
  host: {
    workspaceId: 'w',
    conversationId: 'c',
    requestDigest: 'digest',
    startedAt: 1,
    concurrency: 2,
    sources: [],
    coverage: [],
    serializedSeats: ['codex']
  }
}
const current: LocalWorkflowHostSnapshot = {
  ...before,
  host: { ...before.host, discoverRules: DISCOVER_V7_RULES }
}
const real = (id: string) =>
  DISCOVER_V7_VERIFY_LENSES.map((lens) => [`verify/${id}/${lens}`, vote('real')] as const)
const item = (rank: number, id: string, location: string) => ({
  rank,
  title: id,
  location,
  severity: 'high',
  scenario: 'Charged twice',
  fix: 'Idempotency key',
  findingIds: [id],
  parallelSafe: true
})
/** What the earlier build recorded: twenty agents ran four finder jobs that kept one finding each. */
const results = new Map<string, unknown>([
  [
    'scout/map',
    { areas: [...areas.areas, { name: 'Refunds', files: ['src/c.ts'], why: 'Returns money' }] }
  ],
  [
    'find/r1/0/correctness',
    {
      findings: [
        finding('src/a.ts', 12, 'Double charge'),
        finding('src/a.ts', 60, 'Race on save'),
        finding('src/a.ts', 120, 'Lost update')
      ],
      omitted: 0
    }
  ],
  ['find/r1/0/security', { findings: [], omitted: 0 }],
  ['find/r1/1/correctness', { findings: [], omitted: 0 }],
  ['find/r1/2/correctness', { findings: [finding('src/c.ts', 9, 'Stale total')], omitted: 0 }],
  ...real('r1-a0-correctness-0'),
  ...real('r1-a2-correctness-0'),
  [
    'rank/final',
    {
      summary: 'Fix the double charge first.',
      items: [
        item(1, 'r1-a0-correctness-0', 'src/a.ts:12'),
        item(2, 'r1-a2-correctness-0', 'src/c.ts:9')
      ],
      refutedIds: [],
      unverifiedIds: []
    }
  ]
])

describe('Discover revision 7 runs admitted before rules 2', () => {
  it('replays the records of an earlier build by the rules it ran with', () => {
    const run = projectDiscoverRun(before, results, [], true)!
    expect(run.findings.map((entry) => [entry.id, entry.status, entry.foundBy.seatId])).toEqual([
      ['r1-a0-correctness-0', 'confirmed', 'grok'],
      ['r1-a2-correctness-0', 'confirmed', 'codex']
    ])
    expect(run.counts).toEqual({
      found: 2,
      duplicates: 0,
      verifying: 0,
      confirmed: 2,
      refuted: 0,
      unverified: 0
    })
    expect(run.report?.summary).toBe(
      '2 confirmed findings in 2 ranked items; 0 refuted, 0 unverified.\n\nFix the double charge first.'
    )
    expect(run.dropped).toEqual([
      'Round 1: skipped 2 of 6 finder jobs to stay within 20 agents (Payments · Security; Refunds · Security).',
      'Round 1: 4 new findings can get their 3 votes within 20 agents, so each finder job keeps votes for 1 finding.',
      'Round 1, Checkout · Correctness: the finder left out 2 more findings beyond its limit of 1.'
    ])
    expect(
      discoverStageDefinitions(before, results, undefined).map((stage) => stage.total)
    ).toEqual([1, 4, 6, 1])
    const markdown = discoverResultMarkdown(before, results)!
    expect(markdown).toContain('2 confirmed findings in 2 ranked items; 0 refuted, 0 unverified.')
    expect(markdown).not.toContain('## Unverified')
    // Codex ran that job; the current rules hand a serialized seat's second job to another finder.
    expect(workflowCallSeatId(before, 'find/r1/2/correctness')).toBe('codex')
    expect(workflowCallSeatId(current, 'find/r1/2/correctness')).toBe('gemini')
    // Read by the current rules, the same records would plan votes for findings nobody verified.
    const misread = projectDiscoverRun(current, results, [], true)!
    expect(misread.findings.map((entry) => entry.id)).toContain('r1-a0-correctness-1')
  })
})
