import { validateDiscoverRanking, type Finding, type SelectedFinding } from './discover-assessment'

export type ReviewedFinding = Pick<
  Finding,
  'title' | 'location' | 'trigger' | 'impact' | 'severity' | 'evidence'
>
export type DiscoverReviewedRanking = {
  summary: string
  ranking: {
    findingId: string
    reason: string
    nextAction: string
    finding: ReviewedFinding
  }[]
}

/** A ranker may narrow wording, but cannot change the verified mechanism's locus or severity. */
export function validateDiscoverReviewedRanking(
  value: unknown,
  survivors: SelectedFinding[]
): string | null {
  const baseError = validateDiscoverRanking(value, survivors)
  if (baseError) {
    return baseError
  }
  const ranking = (value as DiscoverReviewedRanking).ranking
  for (const item of ranking) {
    const original = survivors.find((finding) => finding.id === item.findingId)!
    const reviewed = item.finding
    if (
      !reviewed ||
      ![reviewed.title, reviewed.location, reviewed.trigger, reviewed.impact].every(
        (part) => typeof part === 'string' && part.trim().length > 0
      ) ||
      reviewed.location !== original.location ||
      reviewed.severity !== original.severity
    ) {
      return 'Reviewed finding must preserve the survivor location and severity'
    }
    if (!Array.isArray(reviewed.evidence) || !reviewed.evidence.length) {
      return 'Reviewed finding needs concrete evidence'
    }
    const allowedRefs = new Set(original.evidence.map((entry) => entry.ref))
    const refs = reviewed.evidence.map((entry) => entry?.ref)
    if (
      new Set(refs).size !== refs.length ||
      reviewed.evidence.some(
        (entry) =>
          !entry ||
          !allowedRefs.has(entry.ref) ||
          typeof entry.description !== 'string' ||
          !entry.description.trim()
      )
    ) {
      return 'Reviewed evidence must cite each survivor packet reference at most once'
    }
  }
  return null
}

export function applyDiscoverReviewedRanking<T extends SelectedFinding>(
  findings: T[],
  ranking: DiscoverReviewedRanking
): T[] {
  const revisions = new Map(ranking.ranking.map((item) => [item.findingId, item.finding]))
  return findings.map((finding) => {
    const reviewed = revisions.get(finding.id)
    return reviewed ? { ...finding, ...reviewed } : finding
  })
}
