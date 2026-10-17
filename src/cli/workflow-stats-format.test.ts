import { describe, expect, it } from 'vitest'
import type { WorkflowJudgingStats } from '../shared/workflow-judging-stats'
import { formatWorkflowJudgingStats } from './workflow-stats-format'

const stats: WorkflowJudgingStats = {
  note: "Wins are the judges' view of the answers, not real results.",
  source: { file: '/r/judging.jsonl', lines: 0, skipped: 0, duplicates: 0, matched: 0, joined: 0 },
  tariff: { model: 'm', inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
  groups: [],
  seats: [],
  gates: []
}

describe('workflow stats text', () => {
  it('adds the Discover decisions section only when stats carry it', () => {
    expect(formatWorkflowJudgingStats(stats)).not.toContain('Discover decisions')
    const text = formatWorkflowJudgingStats({
      ...stats,
      decisions: {
        runs: 2,
        picks: { start: 2, dig: 1, notNow: 2 },
        launched: 2,
        actedOnRate: 0.6
      }
    })
    expect(text).toContain('Discover decisions')
    expect(text).toContain('2 answered pages: 2 Start, 1 Dig deeper, 2 Not now.')
    expect(text).toContain('Acted on: 60% of picks; 2 with a launch receipt.')
    expect(
      formatWorkflowJudgingStats({
        ...stats,
        decisions: {
          runs: 0,
          picks: { start: 0, dig: 0, notNow: 0 },
          launched: 0,
          actedOnRate: 'unknown'
        }
      })
    ).toContain('No answered Discover pages recorded.')
  })
})
