import { createHash } from 'node:crypto'

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low'
export type Finding = {
  issueKey: string
  title: string
  location: string
  trigger: string
  impact: string
  severity: FindingSeverity
  evidence: { ref: string; description: string }[]
}
export type FindingBatch = { findings: Finding[]; omittedCount: number; omissionReason: string }
export type FindingSource = { dimension: string; index: number; producer: string }
export type SelectedFinding = Finding & { id: string; sources: FindingSource[] }
export type FindingVote = {
  refuted: boolean
  uncertain: boolean
  reason: string
  evidence: Finding['evidence']
}
const severity = { critical: 0, high: 1, medium: 2, low: 3 }
const normalized = (text: string): string => text.trim().replace(/\s+/g, ' ')
const perspectivePrefixes = new Set([
  'cross',
  'tenant',
  'security',
  'reliability',
  'correctness',
  'actual',
  'path',
  'user'
])

function locationSpan(location: string): { path: string; first: number; last: number } | null {
  const match = normalized(location).match(/^(.+?):(\d+)(?:-(\d+))?/)
  return match
    ? { path: match[1], first: Number(match[2]), last: Number(match[3] ?? match[2]) }
    : null
}

function issueTokens(issueKey: string): string[] {
  return issueKey.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

function rootCauseMatch(left: Finding, right: Finding): boolean {
  const a = locationSpan(left.location)
  const b = locationSpan(right.location)
  if (a && b) {
    if (a.path !== b.path || a.last < b.first || b.last < a.first) {
      return false
    }
  } else if (normalized(left.location) !== normalized(right.location)) {
    return false
  }
  const leftKey = issueTokens(left.issueKey)
  const rightKey = issueTokens(right.issueKey)
  if (leftKey.join('-') === rightKey.join('-')) {
    return leftKey.length >= 3 || normalized(left.trigger) === normalized(right.trigger)
  }
  const withoutPerspective = (parts: string[]): string[] => {
    const firstCore = parts.findIndex((part) => !perspectivePrefixes.has(part))
    return firstCore === -1 ? parts : parts.slice(firstCore)
  }
  const first = withoutPerspective(leftKey)
  const second = withoutPerspective(rightKey)
  const shorter = first.length <= second.length ? first : second
  const longer = first.length > second.length ? first : second
  return (
    shorter.length >= 4 &&
    shorter.every((part, index) => part === longer[longer.length - shorter.length + index])
  )
}

function semanticRootCauseMatch(left: Finding, right: Finding): boolean {
  if (rootCauseMatch(left, right)) {
    return true
  }
  const a = locationSpan(left.location)
  const b = locationSpan(right.location)
  if (!a || !b || a.path !== b.path || a.last < b.first || b.last < a.first) {
    return false
  }
  const noise = new Set(['missing', 'check', 'lack', 'no', 'without', 'bug', 'issue', 'defect'])
  const tokens = (key: string) => {
    const words =
      key
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .toLowerCase()
        .match(/[a-z0-9]+/g) ?? []
    const core = words.slice(words.findIndex((word) => !perspectivePrefixes.has(word)))
    return [...new Set(core.filter((word) => !noise.has(word)))]
  }
  const first = tokens(left.issueKey)
  const second = tokens(right.issueKey)
  if (!first.length || first[0] !== second[0]) {
    return false
  }
  const shared = first.filter((word) => second.includes(word)).length
  return shared >= 2 && shared / Math.min(first.length, second.length) >= 0.6
}

export function selectDiscoverFindings(
  batches: FindingBatch[],
  config: {
    dimensions: string[]
    finderId: string
    minimumSeverity: FindingSeverity
    maxCandidates: number
    revision?: 1 | 2 | 3 | 4 | 5 | 6
  }
) {
  const unique: SelectedFinding[] = []
  const excluded: {
    findingId: string
    reason: 'duplicate' | 'below-threshold' | 'over-limit'
    source?: FindingSource
  }[] = []
  batches.forEach((batch, dimension) =>
    batch.findings.forEach((finding, index) => {
      const key =
        config.revision === 5 || config.revision === 6
          ? // Only identical complete findings collapse before the two reviewers.
            // Explicit field order makes model JSON property order irrelevant.
            [
              finding.issueKey,
              finding.title,
              finding.location,
              finding.trigger,
              finding.impact,
              finding.severity,
              finding.evidence.map((item) => [item.ref, item.description])
            ]
          : [
              normalized(finding.location),
              normalized(finding.trigger).toLowerCase(),
              normalized(finding.issueKey).toLowerCase()
            ]
      const id = `finding-${createHash('sha256').update(JSON.stringify(key)).digest('hex')}`
      const source = { dimension: config.dimensions[dimension], index, producer: config.finderId }
      const prior = unique.find((candidate) =>
        config.revision === 1 || config.revision === 5 || config.revision === 6
          ? candidate.id === id
          : rootCauseMatch(candidate, finding)
      )
      if (prior) {
        prior.sources.push(source)
        if (severity[finding.severity] < severity[prior.severity]) {
          prior.severity = finding.severity
        }
        prior.evidence = [
          ...new Map(
            [...prior.evidence, ...finding.evidence].map((item) => [JSON.stringify(item), item])
          ).values()
        ]
        excluded.push({ findingId: prior.id, source, reason: 'duplicate' })
      } else {
        unique.push({ ...finding, evidence: [...finding.evidence], id, sources: [source] })
      }
    })
  )
  if (config.revision === 3) {
    const raw = batches.flatMap((batch, dimension) =>
      batch.findings.map((finding, index) => ({
        finding,
        source: { dimension: config.dimensions[dimension], index, producer: config.finderId }
      }))
    )
    const parent = raw.map((_, index) => index)
    const root = (index: number): number => {
      while (parent[index] !== index) {
        index = parent[index]
      }
      return index
    }
    for (let left = 0; left < raw.length; left += 1) {
      for (let right = left + 1; right < raw.length; right += 1) {
        if (semanticRootCauseMatch(raw[left].finding, raw[right].finding)) {
          parent[root(right)] = root(left)
        }
      }
    }
    unique.length = 0
    excluded.length = 0
    const groups = new Map<number, typeof raw>()
    raw.forEach((item, index) => {
      const key = root(index)
      const group = groups.get(key) ?? []
      group.push(item)
      groups.set(key, group)
    })
    for (const group of groups.values()) {
      const first = group[0].finding
      const key = [
        normalized(first.location),
        normalized(first.trigger).toLowerCase(),
        normalized(first.issueKey).toLowerCase()
      ]
      const id = `finding-${createHash('sha256').update(JSON.stringify(key)).digest('hex')}`
      const selected = {
        ...first,
        id,
        severity: group.reduce(
          (best, item) =>
            severity[item.finding.severity] < severity[best] ? item.finding.severity : best,
          first.severity
        ),
        evidence: [
          ...new Map(
            group
              .flatMap((item) => item.finding.evidence)
              .map((item) => [JSON.stringify(item), item])
          ).values()
        ],
        sources: group.map((item) => item.source)
      }
      unique.push(selected)
      group
        .slice(1)
        .forEach((item) =>
          excluded.push({ findingId: id, source: item.source, reason: 'duplicate' })
        )
    }
  }
  const selected: SelectedFinding[] = []
  const ordered = unique.sort(
    (a, b) => severity[a.severity] - severity[b.severity] || a.id.localeCompare(b.id)
  )
  for (const finding of ordered) {
    const reason =
      severity[finding.severity] > severity[config.minimumSeverity]
        ? 'below-threshold'
        : selected.length >= config.maxCandidates
          ? 'over-limit'
          : null
    if (reason) {
      excluded.push({ findingId: finding.id, reason, source: finding.sources[0] })
    } else {
      selected.push(finding)
    }
  }
  return {
    selected,
    excluded,
    found: batches.reduce((sum, batch) => sum + batch.findings.length, 0),
    omitted: batches.reduce((sum, batch) => sum + batch.omittedCount, 0)
  }
}

export function validateFindingVote(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return 'Missing skeptical verdict'
  }
  const vote = value as FindingVote
  if (typeof vote.refuted !== 'boolean' || typeof vote.uncertain !== 'boolean') {
    return 'Invalid skeptical verdict'
  }
  return vote.uncertain && !vote.refuted ? 'Uncertainty cannot confirm a finding' : null
}

export function assessDiscoverVotes(votes: unknown[]) {
  const uncertain = votes.some(
    (vote) => !!vote && typeof vote === 'object' && (vote as FindingVote).uncertain === true
  )
  const refutations = votes.filter((vote) => (vote as FindingVote | null)?.refuted === true).length
  const outcome =
    votes.length !== 2 || votes.some((vote) => validateFindingVote(vote) !== null)
      ? 'unresolved'
      : refutations === 2
        ? 'refuted'
        : refutations === 1
          ? 'contested'
          : 'survives'
  return {
    outcome,
    assessmentBasis: uncertain ? 'includes-uncertainty' : 'evidence-based',
    disposition: outcome === 'refuted' && uncertain ? 'insufficient-evidence' : outcome
  }
}

export function validateDiscoverRanking(
  value: unknown,
  survivors: { id: string }[]
): string | null {
  const ranking = (value as { ranking?: { findingId: string }[] } | null)?.ranking
  if (!Array.isArray(ranking)) {
    return 'Missing ranking'
  }
  const ids = ranking.map((item) => item?.findingId)
  return ids.length === survivors.length &&
    new Set(ids).size === survivors.length &&
    ids.every((id) => survivors.some((finding) => finding.id === id))
    ? null
    : 'Ranking must include exactly the surviving findings'
}
