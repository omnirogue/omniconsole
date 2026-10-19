import type { LocalWorkflowDiscoverRun } from '../../../../shared/local-workflow-view'
import type {
  DiscoverHypothesis,
  DiscoverHypothesisCell,
  DiscoverHypothesisLens
} from '../discover/discover-hypothesis-matrix-helpers'

/** Each finding is a hypothesis and each verifying lens a column; done votes decide the cell. */
export function discoverRunHypothesisMatrix(run: LocalWorkflowDiscoverRun): {
  hypotheses: DiscoverHypothesis[]
  lenses: DiscoverHypothesisLens[]
} {
  const findings = run.findings.filter((finding) => !finding.duplicateOf && finding.votes.length)
  const lensIds = [
    ...new Set([...run.lenses, ...findings.flatMap((f) => f.votes.map((v) => v.lens))])
  ]
  const voted = new Set(findings.flatMap((finding) => finding.votes.map((vote) => vote.lens)))
  const lenses = lensIds.filter((id) => voted.has(id)).map((id) => ({ id, name: id }))
  const hypotheses = findings.map((finding) => {
    const cells: Record<string, DiscoverHypothesisCell> = {}
    for (const lens of lenses) {
      const verdicts = finding.votes
        .filter((vote) => vote.lens === lens.id && vote.state === 'done')
        .map((vote) => vote.verdict)
      const real = verdicts.includes('real')
      const refuted = verdicts.includes('refuted')
      cells[lens.id] = {
        verdict: real && refuted ? 'mixed' : real ? 'supported' : refuted ? 'refuted' : 'untested',
        evidenceCount: verdicts.filter((verdict) => verdict === 'real' || verdict === 'refuted')
          .length
      }
    }
    return { id: finding.id, statement: finding.title, cells }
  })
  return { hypotheses, lenses }
}
