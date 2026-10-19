import { describe, expect, it } from 'vitest'
import { evolveJudgmentsFromAuditBundle, evolveParetoCandidates } from './evolve-run-preview-data'
import { evolveRunFixture } from './evolve-run.fixtures'

describe('evolveParetoCandidates', () => {
  it('keeps each candidate best score and leaves cost unknown', () => {
    const run = evolveRunFixture({
      hostedProgress: {
        recent: [
          { id: '1', at: 'a', kind: 'evaluated', candidateId: 'c1', score: 0.4 },
          { id: '2', at: 'b', kind: 'evaluated', candidateId: 'c1', score: 0.7 },
          { id: '3', at: 'c', kind: 'eliminated', candidateId: 'c2', score: 0.9 },
          { id: '4', at: 'd', kind: 'evaluated', candidateId: 'c3' }
        ]
      } as never,
      ledger: undefined
    })
    expect(evolveParetoCandidates(run)).toEqual([
      { id: 'c1', label: 'c1', score: 0.7, costUsd: null }
    ])
  })
})

describe('evolveJudgmentsFromAuditBundle', () => {
  it('reads only well-formed per-judge rows', () => {
    const row = {
      id: 'j1',
      judgeLabel: 'Gemini',
      judgeFamily: 'google',
      candidateFamily: 'anthropic',
      shownFirst: 'baseline',
      verdict: 'tie',
      swappedVerdict: 'sideways',
      confidence: 0.8
    }
    expect(
      evolveJudgmentsFromAuditBundle({ judgments: [row, { ...row, id: 'j2', judgeFamily: 'x' }] })
    ).toEqual([{ ...row, swappedVerdict: null, rationale: null }])
  })

  it('returns no judgments for the omnisi-evolve section format', () => {
    expect(
      evolveJudgmentsFromAuditBundle({ format: 'omnisi-evolve/audit-bundle', sections: {} })
    ).toEqual([])
    expect(evolveJudgmentsFromAuditBundle(null)).toEqual([])
  })
})
