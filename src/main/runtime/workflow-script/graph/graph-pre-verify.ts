import type { WorkflowSpec } from '../../../../shared/workflow-graph'
import {
  graphExcerptFragments,
  graphEvidenceLocation,
  type GraphEvidenceFields
} from './graph-evidence-check'

/**
 * Evidence rules 2: before any reviewer reads a result, the app checks every path and line it
 * cites and re-runs the search behind any absence it claims. Absent before rules 2: quotes only.
 */
export const EVIDENCE_RULES = 2

/** A list with quotes (`list.evidence`) that a review for-each checks: only its finders are asked. */
export const graphPreVerifiedList = (spec: WorkflowSpec, stepId: string): boolean =>
  !!spec.steps.find((step) => step.id === stepId)?.list?.evidence &&
  spec.steps.some((step) => step.kind === 'review' && step.forEach?.step === stepId)

/**
 * What admission freezes: rules 2 for Discover only, whose Verify reviews its finders' quoted
 * results, and only when the run reads its workspace: Knowledge only has no files to check and
 * no searches to give. Quick Discover has no review, and Investigate is out of this check's scope.
 */
export function graphEvidenceAdmission(
  spec: WorkflowSpec,
  readsWorkspace: boolean
): GraphEvidenceFields {
  return readsWorkspace &&
    spec.template === 'discover' &&
    spec.steps.some((step) => graphPreVerifiedList(spec, step.id))
    ? { evidenceRules: EVIDENCE_RULES }
    : {}
}

/** The frozen rules, read defensively; rules from a newer build are refused, never guessed. */
export function graphEvidenceRules(snapshot: object): GraphEvidenceFields {
  const rules = (snapshot as { host?: { evidenceRules?: unknown } }).host?.evidenceRules
  if (typeof rules === 'number' && rules > EVIDENCE_RULES) {
    throw new Error(`Unsupported evidence rules: ${rules}`)
  }
  return typeof rules === 'number' ? { evidenceRules: rules } : {}
}

export const graphPreVerifies = (config: GraphEvidenceFields): boolean =>
  (config.evidenceRules ?? 0) >= EVIDENCE_RULES

export type GraphCitation = { file: string; line?: number; end?: number }

/** One result's facts to check: frozen in the request, so a replay asks the same. */
export type GraphPreVerifyItem = {
  key: string
  /** The location's own citation first; at most MAX_CITATIONS. */
  citations: GraphCitation[]
  /** The location is a path:line: only such a result is ever dropped. */
  code: boolean
  /** The absence it claims, as matched ("never called"). */
  absence?: string
  /** The searches it gave for that absence, as written. */
  searches: string[]
  /** One line of its quote, looked for across the workspace before a drop. */
  probe?: string
  /** Other useful quote fragments, so an ellipsis cannot prevent bad-path rescue. */
  probes?: string[]
}

export type GraphCitationCheck = GraphCitation & {
  status: 'ok' | 'past-end' | 'absent' | 'unknown'
  /** Where the file really is, when not at the path cited (a context folder, a shortened path). */
  at?: string
  lines?: number
  /** Why it could not be checked (`unknown`). */
  why?: string
}

export type GraphSearchCheck = { search: string; hits?: string[]; more?: true; error?: string }

/** The app's pre-verify of one result, kept in the evidence record. */
export type GraphPreVerify = {
  citations: GraphCitationCheck[]
  absence?: string
  searches: GraphSearchCheck[]
  /** Each problem found, in plain words; any one makes the result flagged. */
  flags: string[]
  /** Why it goes to no reviewer: no citation resolves at all. */
  dropped?: string
}

const MAX_CITATIONS = 8
const MAX_SEARCHES = 3
const SEARCH_CHARS = 300
const PROBE_MIN_CHARS = 12
const PROBE_MAX_CHARS = 200

const CODE_FILE =
  /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|swift|rb|php|c|h|cc|cpp|hpp|cs|json|ya?ml|toml|md|sh|sql|vue|svelte|css|scss|html)$/i
const CITED =
  /(?<![\w/.@-])((?:\.{0,2}[\\/])?(?:[\w.@+-]+[\\/])*[\w@+-][\w.@+-]*\.[A-Za-z]\w{0,7})(?::(\d+)(?::\d+)?(?:[-–](\d+))?|#L(\d+)(?:-L?(\d+))?)/g
const ABSENCE =
  /\b(?:not (?:wired|called|used|referenced|invoked|registered|imported|exported|handled|implemented|defined)|is(?:n't| not) (?:wired|called|used|referenced)|never (?:called|used|wired|invoked|referenced|read|set|registered|imported|handled)|nothing (?:calls|uses|references|reads|imports)|missing|do(?:es)?(?:n't| not) exist|no (?:callers?|call sites?|references?|usages?|matches|hits)|unused|dead code|(?:returns|finds|found|gives) (?:nothing|no (?:matches|results|hits))|zero (?:matches|hits|results))\b/i
const SEARCH = /`(rg\s[^`\n]+)`|^[ \t]*(?:\$[ \t]*)?(rg[ \t][^\n]+)$/gm

const toPosix = (file: string) => file.replace(/\\/g, '/')

/** `path:line[-end]` (also `path#Lline-Lend`) from a location: the range graphEvidenceLocation drops. */
export function graphCitedRange(location: string): GraphCitation | undefined {
  const cited = graphEvidenceLocation(location)
  if (!cited) {
    return undefined
  }
  const first = location
    .trim()
    .split(/[\s,;]+/)[0]
    ?.replace(/^[`'"(]+|[`'".,)]+$/g, '')
  const end = Number(/[-–]L?(\d+)$/.exec(first ?? '')?.[1])
  return { ...cited, ...(Number.isInteger(end) && end > cited.line ? { end } : {}) }
}

/** Every path:line a result cites, its location's first; bare names only for common code files. */
export function graphCitations(item: { location: string; title: string; detail: string }) {
  const found: GraphCitation[] = []
  const add = (citation: GraphCitation) => {
    const file = toPosix(citation.file)
    if (
      found.length < MAX_CITATIONS &&
      !found.some((other) => other.file === file && other.line === citation.line)
    ) {
      found.push({ ...citation, file })
    }
  }
  const located = graphCitedRange(item.location)
  if (located) {
    add(located)
  }
  for (const match of `${item.location}\n${item.title}\n${item.detail}`.matchAll(CITED)) {
    const file = match[1]!
    if (/:\/\//.test(file) || (!/[\\/]/.test(file) && !CODE_FILE.test(file))) {
      continue
    }
    const line = Number(match[2] ?? match[4])
    const end = Number(match[3] ?? match[5])
    if (Number.isInteger(line) && line >= 1) {
      add({ file, line, ...(Number.isInteger(end) && end > line ? { end } : {}) })
    }
  }
  return found
}

/** The absence a result claims, as matched; none when it claims none. */
export function graphAbsenceClaim(item: { title: string; detail: string }): string | undefined {
  return ABSENCE.exec(`${item.title}\n${item.detail}`)?.[0].toLowerCase()
}

/** The `rg` searches a result gives, in backticks or on a line of their own. */
export function graphCitedSearches(text: string): string[] {
  const searches: string[] = []
  for (const match of text.matchAll(SEARCH)) {
    const search = (match[1] ?? match[2]!).trim().slice(0, SEARCH_CHARS)
    if (searches.length < MAX_SEARCHES && !searches.includes(search)) {
      searches.push(search)
    }
  }
  return searches
}

/** Bounded literal lines, longest first, including parts on either side of an ellipsis. */
function probesOf(excerpt: string | undefined): string[] {
  return [...new Set((excerpt ?? '').split(/\r?\n/).flatMap(graphExcerptFragments))]
    .filter((entry) => entry.length >= PROBE_MIN_CHARS)
    .sort((a, b) => b.length - a.length)
    .slice(0, 3)
    .map((entry) => entry.slice(0, PROBE_MAX_CHARS))
}

/** What the app re-checks of one result; none when it cites nothing and claims no absence. */
export function graphPreVerifyItem(item: {
  key: string
  title: string
  detail: string
  location: string
  excerpt?: string
  trigger?: string
}): GraphPreVerifyItem | undefined {
  const citations = graphCitations(item)
  const absence = graphAbsenceClaim(item)
  if (!citations.length && !absence) {
    return undefined
  }
  const code = !!graphEvidenceLocation(item.location)
  const probes = code ? probesOf(item.excerpt) : []
  const probe = probes[0]
  return {
    key: item.key,
    citations,
    code,
    ...(absence ? { absence } : {}),
    searches: absence ? graphCitedSearches(`${item.detail}\n${item.trigger ?? ''}`) : [],
    ...(probe ? { probe } : {}),
    ...(probes.length > 1 ? { probes } : {})
  }
}

export const graphCitationText = (citation: GraphCitation) =>
  `\`${citation.file}${citation.line ? `:${citation.line}${citation.end ? `-${citation.end}` : ''}` : ''}\``

function citationLine(check: GraphCitationCheck): string {
  const at = check.at ? ` (found as \`${check.at}\`)` : ''
  switch (check.status) {
    case 'ok':
      return `${graphCitationText(check)}${at}: exists, lines in range (${check.lines} lines).`
    case 'past-end':
      return `${graphCitationText(check)}${at}: past the end of the file (${check.lines} lines).`
    case 'absent':
      return `${graphCitationText(check)}: no such file in the workspace.`
    case 'unknown':
      return `${graphCitationText(check)}: not checked (${check.why ?? 'unknown'}).`
  }
}

function searchLine(check: GraphSearchCheck): string {
  if (check.error) {
    return `Search \`${check.search}\`: not re-run (${check.error}).`
  }
  return check.hits?.length
    ? `Search \`${check.search}\` re-run: matches at ${check.hits.join(', ')}${check.more ? ' and more' : ''}.`
    : `Search \`${check.search}\` re-run: no matches.`
}

/** The pre-verify as the reviewer reads it: one line per citation and search. */
export function graphPreVerifyLines(check: GraphPreVerify): string[] {
  return [
    ...check.citations.map(citationLine),
    ...(check.absence && !check.searches.length
      ? [`It claims an absence ("${check.absence}") but gives no search for it.`]
      : []),
    ...check.searches.map(searchLine)
  ]
}
