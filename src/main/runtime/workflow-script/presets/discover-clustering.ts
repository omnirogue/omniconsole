import type {
  SelectedFinding,
  FindingSeverity,
  selectDiscoverFindings
} from './discover-assessment'

export type DiscoverClusterVote = { groups: { ids: string[]; reason: string }[] }
type Selection = ReturnType<typeof selectDiscoverFindings>
const severity = { critical: 0, high: 1, medium: 2, low: 3 } satisfies Record<
  FindingSeverity,
  number
>

export function validateDiscoverClusters(
  value: unknown,
  candidates: SelectedFinding[]
): string | null {
  const groups = (value as DiscoverClusterVote | null)?.groups
  if (!Array.isArray(groups) || !groups.length) {
    return 'Missing root-cause groups'
  }
  const ids = groups.flatMap((group) => (Array.isArray(group?.ids) ? group.ids : []))
  const expected = new Set(candidates.map((candidate) => candidate.id))
  return groups.some((group) => !Array.isArray(group?.ids) || !group.ids.length) ||
    ids.length !== expected.size ||
    new Set(ids).size !== expected.size ||
    ids.some((id) => !expected.has(id))
    ? 'Root-cause groups must partition every candidate exactly once'
    : null
}

function sameLocus(left: SelectedFinding, right: SelectedFinding): boolean {
  const parse = (location: string) => {
    const match = location.match(/^(.+?):(\d+)(?:-(\d+))?/)
    return match
      ? { path: match[1], first: Number(match[2]), last: Number(match[3] ?? match[2]) }
      : null
  }
  const a = parse(left.location)
  const b = parse(right.location)
  return !!a && !!b && a.path === b.path && a.first <= b.last && b.first <= a.last
}

/** Only unanimous same-mechanism pairs at an overlapping source locus may merge. */
export function consensusDiscoverClusters(
  selection: Selection,
  votes: [DiscoverClusterVote, DiscoverClusterVote]
): Selection {
  const candidates = selection.selected
  for (const vote of votes) {
    const error = validateDiscoverClusters(vote, candidates)
    if (error) {
      throw new Error(error)
    }
  }
  const memberships = votes.map(
    (vote) =>
      new Map(vote.groups.flatMap((group, index) => group.ids.map((id) => [id, index] as const)))
  )
  const groups: SelectedFinding[][] = []
  for (const candidate of candidates) {
    const group = groups.find((members) =>
      members.every(
        (member) =>
          sameLocus(member, candidate) &&
          memberships.every(
            (membership) => membership.get(member.id) === membership.get(candidate.id)
          )
      )
    )
    if (group) {
      group.push(candidate)
    } else {
      groups.push([candidate])
    }
  }
  const selected = groups.map((group) => {
    const first = group[0]
    return {
      ...first,
      severity: group.reduce(
        (best, item) => (severity[item.severity] < severity[best] ? item.severity : best),
        first.severity
      ),
      evidence: [
        ...new Map(
          group.flatMap((item) => item.evidence).map((item) => [JSON.stringify(item), item])
        ).values()
      ],
      sources: group.flatMap((item) => item.sources)
    }
  })
  return {
    ...selection,
    selected,
    excluded: [
      ...selection.excluded,
      ...groups.flatMap((group) =>
        group.slice(1).flatMap((candidate) =>
          candidate.sources.map((source) => ({
            findingId: group[0].id,
            source,
            reason: 'duplicate' as const
          }))
        )
      )
    ]
  }
}

/** Revision five applies the user quota after root-cause consensus, freeing duplicate slots. */
export function limitDiscoverSelection(selection: Selection, maxCandidates: number): Selection {
  const ordered = [...selection.selected].sort(
    (a, b) => severity[a.severity] - severity[b.severity] || a.id.localeCompare(b.id)
  )
  return {
    ...selection,
    selected: ordered.slice(0, maxCandidates),
    excluded: [
      ...selection.excluded,
      ...ordered.slice(maxCandidates).map((finding) => ({
        findingId: finding.id,
        reason: 'over-limit' as const,
        source: finding.sources[0]
      }))
    ]
  }
}
