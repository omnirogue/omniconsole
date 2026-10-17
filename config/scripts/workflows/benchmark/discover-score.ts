import { discoverOmniosOrderedTargets } from '../../../../src/shared/discover-omnios-page'
import type {
  WorkflowRunResult,
  WorkflowRunTarget
} from '../../../../src/shared/workflow-run-result'

export type Severity = 'critical' | 'high' | 'medium' | 'low'

export type AnswerEntry = {
  id: string
  kind: 'bug' | 'decoy'
  file: string
  lines: [number, number]
  /** Text the line range must contain; a fixture edit that moves it fails the key's test. */
  anchor: string
  severity: Severity | 'none'
  description: string
  /** Defect-specific terms; a target must contain one to be credited with this entry. */
  evidence: string[]
}

export type AnswerKey = { set: string; version: number; entries: AnswerEntry[] }

type Tally = WorkflowRunTarget['tally']

export type TargetMatch = {
  key: string
  title: string
  location: string
  tally: Tally
  severity: WorkflowRunTarget['severity']
  jevScore?: number
  jevVerify?: number
  confirmedBy?: 'jev'
  refutedBy?: 'jev'
  match?: { id: string; kind: AnswerEntry['kind'] }
  /** Not credited: the candidates a person should decide between, and why. */
  adjudicate?: { candidates: string[]; reason: 'ambiguous' | 'no-evidence' | 'no-lines' }
}

export type DiscoverScore = {
  targets: number
  byVerdict: Record<Tally, { targets: number; seeded: string[]; decoys: string[]; other: number }>
  /** Seeded bugs a confirmed target matched. */
  found: string[]
  /** Seeded bugs no confirmed target matched; `missedEntirely` no target at all. */
  missed: string[]
  missedEntirely: string[]
  decoysFlagged: string[]
  /** Confirmed targets that identify nothing in the key (they may be real; read them). */
  otherFindings: { title: string; location: string }[]
  /** Confirmed targets the scorer did not credit: ambiguous or weak fits, for a person to decide. */
  needsAdjudication: { title: string; location: string; candidates: string[]; reason: string }[]
  /** Confirmed targets that matched a bug an earlier confirmed target already matched. */
  duplicates: number
  /** Per target: confirmed targets crediting a seeded bug (duplicates count), of all confirmed. */
  precisionPerTarget: number | null
  /**
   * Per defect: unique seeded bugs found, of those plus every confirmed target that credits no
   * bug (decoys, other findings, adjudication). Duplicates count in neither.
   */
  precisionUnique: number | null
  precisionAdjudicated: number | null
  precisionAnyVerdict: number | null
  decoysAnyVerdict: string[]
  byJudge: {
    jev: Record<Tally, number>
    reviewers: Record<Tally, number>
    unreviewed: Record<Tally, number>
  }
  jevVerify: {
    n: number
    brier: number | null
    correct: number
    decided: number
  }
  recall: number
  /**
   * Seeded bugs any target matched, whatever its verdict, of all bugs. The only recall a
   * single-pass run (Quick Discover, every target unverified) can show.
   */
  recallAnyVerdict: number
  /** Matched confirmed targets whose severity equals the key's. */
  severityAgreement: number | null
  ranking: {
    /** The actionable order delivered to the page, including its remaining findings. */
    ranked: (string | null)[]
    /** Where each critical and high seeded bug first appears (1-based), null when absent. */
    highSeverity: { id: string; position: number | null }[]
    /** Of the K critical/high bugs, how many are in the top K places. */
    highInTopK: number
    k: number
    meanReciprocalRank: number
  }
  matches: TargetMatch[]
}

const LINE_TOLERANCE = 3
const LOCATION =
  /([\w.@/\\-]+\.(?:[cm]?[jt]sx?|json|py|go|rs|java|rb|cs|kt|swift|php|sql|ya?ml|md))\b(?:(?::|#L|\s+lines?\s+)(\d+)(?:\s*[-–]\s*L?(\d+))?)?/gi

type Place = { file: string; lines?: [number, number] }

/** Every "path:line", "path:start-end" or bare path in a target's location, then its text. */
export function parseLocations(text: string): Place[] {
  const places: Place[] = []
  for (const match of text.matchAll(LOCATION)) {
    const file = match[1]!.replaceAll('\\', '/')
    const start = match[2] ? Number(match[2]) : undefined
    const end = match[3] ? Number(match[3]) : start
    places.push(start === undefined ? { file } : { file, lines: [start, Math.max(start, end!)] })
  }
  return places
}

function sameFile(found: string, key: string): boolean {
  const left = found.toLowerCase()
  const right = key.toLowerCase()
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`)
}

function overlaps(lines: [number, number], key: [number, number]): boolean {
  return lines[0] <= key[1] + LINE_TOLERANCE && lines[1] >= key[0] - LINE_TOLERANCE
}

function evidenceHits(text: string, entry: AnswerEntry): number {
  const lower = text.toLowerCase()
  return entry.evidence.filter((term) => lower.includes(term.toLowerCase())).length
}

export type TargetVerdict = Pick<TargetMatch, 'match' | 'adjudicate'>

/**
 * The key entry a target identifies: same file, overlapping lines and at least one of the
 * entry's evidence terms. Equal candidates are ambiguous and a partial fit is weak: both are
 * left for adjudication, never credited.
 */
export function matchTarget(
  target: Pick<WorkflowRunTarget, 'title' | 'location' | 'detail'>,
  key: AnswerKey
): TargetVerdict {
  const text = `${target.title}\n${target.detail}`
  const places = parseLocations(target.location)
  const where = places.length ? places : parseLocations(text)
  const inFile = key.entries.filter((entry) =>
    where.some((place) => sameFile(place.file, entry.file))
  )
  const lined = inFile.filter((entry) =>
    where.some(
      (place) =>
        sameFile(place.file, entry.file) && place.lines && overlaps(place.lines, entry.lines)
    )
  )
  const withEvidence = (entries: AnswerEntry[]) =>
    entries
      .map((entry) => ({ entry, hits: evidenceHits(text, entry) }))
      .filter((row) => row.hits > 0)
      .sort((left, right) => right.hits - left.hits)
  const strong = withEvidence(lined)
  if (strong.length) {
    const top = strong.filter((row) => row.hits === strong[0]!.hits)
    return top.length === 1
      ? { match: { id: top[0]!.entry.id, kind: top[0]!.entry.kind } }
      : { adjudicate: { candidates: top.map((row) => row.entry.id), reason: 'ambiguous' } }
  }
  if (lined.length) {
    return { adjudicate: { candidates: lined.map((entry) => entry.id), reason: 'no-evidence' } }
  }
  const unlined = withEvidence(inFile)
  return unlined.length
    ? { adjudicate: { candidates: unlined.map((row) => row.entry.id), reason: 'no-lines' } }
    : {}
}

/** Later rounds restate a target under the same key; the last word on it counts. */
function latestByKey(targets: readonly WorkflowRunTarget[]): WorkflowRunTarget[] {
  const byKey = new Map<string, WorkflowRunTarget>()
  for (const target of targets) {
    byKey.delete(target.key)
    byKey.set(target.key, target)
  }
  return [...byKey.values()]
}

export function scoreDiscoverRun(
  result: Pick<WorkflowRunResult, 'results'>,
  key: AnswerKey,
  adjudications: Readonly<Record<string, 'real' | 'false'>> = {}
): DiscoverScore {
  const targets = latestByKey(result.results.targets)
  const matches: TargetMatch[] = targets.map((target) => {
    const { match, adjudicate } = matchTarget(target, key)
    return {
      key: target.key,
      title: target.title,
      location: target.location,
      tally: target.tally,
      severity: target.severity,
      ...(target.jevScore !== undefined ? { jevScore: target.jevScore } : {}),
      ...(target.jevVerify !== undefined ? { jevVerify: target.jevVerify } : {}),
      ...(target.confirmedBy ? { confirmedBy: target.confirmedBy } : {}),
      ...(target.refutedBy ? { refutedBy: target.refutedBy } : {}),
      ...(match ? { match } : {}),
      ...(adjudicate ? { adjudicate } : {})
    }
  })
  const bugs = key.entries.filter((entry) => entry.kind === 'bug')
  const verdict = (tally: Tally) => {
    const rows = matches.filter((row) => row.tally === tally)
    const ids = (kind: AnswerEntry['kind']) => [
      ...new Set(rows.flatMap((row) => (row.match?.kind === kind ? [row.match.id] : [])))
    ]
    return {
      targets: rows.length,
      seeded: ids('bug'),
      decoys: ids('decoy'),
      other: rows.filter((row) => !row.match).length
    }
  }
  const byVerdict = {
    confirmed: verdict('confirmed'),
    refuted: verdict('refuted'),
    unverified: verdict('unverified')
  }
  const confirmed = matches.filter((row) => row.tally === 'confirmed')
  const confirmedBugs = confirmed.filter((row) => row.match?.kind === 'bug')
  const anyMatched = new Set(matches.flatMap((row) => (row.match ? [row.match.id] : [])))
  const found = byVerdict.confirmed.seeded
  const missedEntirely = bugs.filter((entry) => !anyMatched.has(entry.id)).map((entry) => entry.id)
  const entryOf = (id: string) => key.entries.find((entry) => entry.id === id)!
  const ranked = discoverOmniosOrderedTargets(result).map(({ target }) => {
    const match = matches.find((row) => row.key === target.key)?.match
    return match?.kind === 'bug' ? match.id : null
  })
  const byJudge = {
    jev: { confirmed: 0, refuted: 0, unverified: 0 },
    reviewers: { confirmed: 0, refuted: 0, unverified: 0 },
    unreviewed: { confirmed: 0, refuted: 0, unverified: 0 }
  }
  for (const row of matches) {
    const reviewed = targets
      .find((target) => target.key === row.key)
      ?.votes.some((vote) => vote !== null)
    byJudge[row.confirmedBy || row.refutedBy ? 'jev' : reviewed ? 'reviewers' : 'unreviewed'][
      row.tally
    ]++
  }
  const jev = matches.filter((row) => row.match && row.jevVerify !== undefined)
  const jevDecided = jev.filter((row) => row.confirmedBy || row.refutedBy)
  const labeled = confirmed.filter((row) => row.match || adjudications[row.key] !== undefined)
  const real = labeled.filter(
    (row) => row.match?.kind === 'bug' || (!row.match && adjudications[row.key] === 'real')
  )
  const high = bugs.filter((entry) => entry.severity === 'critical' || entry.severity === 'high')
  const highSeverity = high.map((entry) => {
    const index = ranked.indexOf(entry.id)
    return { id: entry.id, position: index === -1 ? null : index + 1 }
  })
  return {
    targets: matches.length,
    byVerdict,
    found,
    missed: bugs.filter((entry) => !found.includes(entry.id)).map((entry) => entry.id),
    missedEntirely,
    decoysFlagged: byVerdict.confirmed.decoys,
    otherFindings: confirmed
      .filter((row) => !row.match && !row.adjudicate)
      .map((row) => ({ title: row.title, location: row.location })),
    needsAdjudication: confirmed.flatMap((row) =>
      row.adjudicate ? [{ title: row.title, location: row.location, ...row.adjudicate }] : []
    ),
    duplicates: confirmedBugs.length - found.length,
    precisionPerTarget: confirmed.length ? confirmedBugs.length / confirmed.length : null,
    precisionUnique: confirmed.length
      ? found.length / (found.length + confirmed.length - confirmedBugs.length)
      : null,
    precisionAdjudicated: labeled.length ? real.length / labeled.length : null,
    precisionAnyVerdict: matches.length
      ? matches.filter((row) => row.match?.kind === 'bug').length / matches.length
      : null,
    decoysAnyVerdict: [
      ...new Set(matches.flatMap((row) => (row.match?.kind === 'decoy' ? [row.match.id] : [])))
    ],
    byJudge,
    jevVerify: {
      n: jev.length,
      brier: jev.length
        ? jev.reduce(
            (sum, row) => sum + (row.jevVerify! - (row.match!.kind === 'bug' ? 1 : 0)) ** 2,
            0
          ) / jev.length
        : null,
      decided: jevDecided.length,
      correct: jevDecided.filter((row) =>
        row.match!.kind === 'bug' ? row.confirmedBy === 'jev' : row.refutedBy === 'jev'
      ).length
    },
    recall: bugs.length ? found.length / bugs.length : 0,
    recallAnyVerdict: bugs.length ? (bugs.length - missedEntirely.length) / bugs.length : 0,
    severityAgreement: confirmedBugs.length
      ? confirmedBugs.filter((row) => entryOf(row.match!.id).severity === row.severity).length /
        confirmedBugs.length
      : null,
    ranking: {
      ranked,
      highSeverity,
      highInTopK: highSeverity.filter((row) => row.position !== null && row.position <= high.length)
        .length,
      k: high.length,
      meanReciprocalRank: high.length
        ? highSeverity.reduce((sum, row) => sum + (row.position ? 1 / row.position : 0), 0) /
          high.length
        : 0
    },
    matches
  }
}
