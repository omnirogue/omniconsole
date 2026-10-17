import { graphEvidenceForEach, type GraphEvidencePlan } from './graph-evidence-plan'
import { graphSeverityRank, type GraphItem } from './graph-items'
import { graphPreVerifies } from './graph-pre-verify'
import { graphUsesLegacyVerification, type GraphScope } from './graph-scope'

/** Spend pre-verify searches in impact order and use the best checked quote in each group. */
export function graphCheckedOrder(
  scope: GraphScope,
  input: Parameters<typeof graphEvidenceForEach>[1],
  ordered: GraphItem[],
  candidates: readonly GraphItem[] = [],
  priorityKeys?: ReadonlySet<string>,
  legacyEvidence?: GraphEvidencePlan
): { evidence: GraphEvidencePlan; sorted: GraphItem[] } {
  if (graphUsesLegacyVerification(scope)) {
    const evidence = legacyEvidence ?? graphEvidenceForEach(scope, input)
    return { evidence, sorted: evidence.keep(ordered.map(evidence.attach)) }
  }
  const all = [...candidates, ...input.source]
  const members = (item: GraphItem) => [
    item,
    ...(item.alsoMerged ?? []).flatMap((key) => all.find((member) => member.key === key) ?? [])
  ]
  const source = [
    ...ordered.flatMap(members),
    ...input.source.filter(
      (item) =>
        !ordered.some((kept) => kept.key === item.key || kept.alsoMerged?.includes(item.key))
    )
  ]
  const evidence = graphEvidenceForEach(scope, {
    ...input,
    source: graphPreVerifies(scope.config) ? source : [...candidates, ...input.source]
  })
  const attached = ordered.map((item) => {
    const checked = members(item).map(evidence.attach)
    const best =
      checked.find((member) => ['found', 'moved'].includes(member.evidence?.status ?? '')) ??
      checked[0]!
    return {
      ...item,
      evidence: best.evidence && {
        ...best.evidence,
        ...(best.key !== item.key
          ? {
              location: best.evidence.location ?? best.location,
              excerpt: best.evidence.excerpt ?? best.excerpt
            }
          : {})
      }
    }
  })
  const priority = (item: GraphItem) =>
    Number([item.key, ...(item.alsoMerged ?? [])].some((key) => priorityKeys?.has(key)))
  const badQuote = (item: GraphItem) => Number(item.evidence?.status === 'missing')
  const sorted = evidence
    .keep(attached)
    .sort((a, b) => priority(b) - priority(a) || badQuote(a) - badQuote(b))
  return { evidence, sorted }
}

/** Highest severity first; otherwise the order the items were reported in. */
export function graphSortForEach(items: readonly GraphItem[]): GraphItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (left, right) =>
        graphSeverityRank(left.item.severity) - graphSeverityRank(right.item.severity) ||
        left.index - right.index
    )
    .map((entry) => entry.item)
}
