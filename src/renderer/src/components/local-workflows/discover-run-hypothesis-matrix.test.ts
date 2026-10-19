import { describe, expect, it } from 'vitest'
import { discoverRunHypothesisMatrix } from './discover-run-hypothesis-matrix'
import { discoverRunView } from './local-workflow-run.fixtures'

describe('discoverRunHypothesisMatrix', () => {
  it('turns voted findings into rows and verifying lenses into columns', () => {
    const run = discoverRunView().discoverRun!
    const matrix = discoverRunHypothesisMatrix(run)
    expect(matrix.lenses.map((lens) => lens.id)).toEqual([
      'correctness',
      'reachability',
      'reproduction'
    ])
    // f2 has no votes and f3 repeats f1, so only f1 is a row.
    expect(matrix.hypotheses).toEqual([
      {
        id: 'f1',
        statement: 'Retry drops the idempotency key',
        cells: {
          correctness: { verdict: 'supported', evidenceCount: 1 },
          reachability: { verdict: 'supported', evidenceCount: 1 },
          reproduction: { verdict: 'untested', evidenceCount: 0 }
        }
      }
    ])
  })

  it('marks a lens with real and refuted votes as mixed and ignores votes still running', () => {
    const run = discoverRunView().discoverRun!
    const [first] = run.findings
    const seat = first.votes[0].seat
    const matrix = discoverRunHypothesisMatrix({
      ...run,
      findings: [
        {
          ...first,
          votes: [
            { lens: 'security', seat, state: 'done', verdict: 'real' },
            { lens: 'security', seat, state: 'done', verdict: 'refuted' },
            { lens: 'security', seat, state: 'running', verdict: 'real' }
          ]
        }
      ]
    })
    expect(matrix.hypotheses[0].cells.security).toEqual({ verdict: 'mixed', evidenceCount: 2 })
  })
})
