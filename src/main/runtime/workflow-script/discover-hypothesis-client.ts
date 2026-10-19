import { z } from 'zod'
import { assertJsonTextStructureWithinLimits } from '../../../shared/json-text-structure-limit'

export type DiscoverCitationStance = 'supports' | 'refutes' | 'context'
/** Discover's quote check (`LocalWorkflowEvidenceStatus`) folded to what coverage needs. */
export type DiscoverCitationCheck = 'verified' | 'unchecked' | 'missing' | 'unreadable'
/** A file (`path:line`, `path:start-end`) or URL (`#Lstart-Lend`) a hypothesis rests on. */
export type DiscoverCitationRef = { source: string; startLine?: number; endLine?: number }
export type DiscoverCitation = DiscoverCitationRef & {
  quote?: string
  stance: DiscoverCitationStance
  check: DiscoverCitationCheck
}
export type DiscoverHypothesis = {
  id: string
  claim: string
  /** 0-1; 0-100 percentages are normalized and anything unreadable is null. */
  confidence: number | null
  citations: DiscoverCitation[]
}
export type DiscoverHypothesisIssue = { path: string; message: string }
const VERDICTS = ['supported', 'contested', 'refuted', 'unverified', 'uncited'] as const
export type DiscoverVerdict = (typeof VERDICTS)[number]
export type DiscoverMatrixCell = Record<DiscoverCitationStance | 'verified' | 'failed', number>
export type DiscoverHypothesisCoverage = ReturnType<typeof discoverHypothesisCoverage>
export type DiscoverHypothesisMatrix = ReturnType<typeof buildDiscoverHypothesisMatrix>
export type DiscoverEvidenceSummary = DiscoverHypothesisMatrix['summary']

export const DISCOVER_HYPOTHESES_MAX_BYTES = 4 * 1024 * 1024
export const DISCOVER_HYPOTHESES_MAX_COUNT = 500
export const DISCOVER_CITATIONS_MAX_COUNT = 200
const JSON_LIMITS = { structuralTokens: 500_000, nestingDepth: 32 }

const PATH_REF = /^(.+?):(\d+)(?:-(\d+))?$/
const URL_LINES = /#L(\d+)(?:-L(\d+))?$/
const STANCES: DiscoverCitationStance[] = ['supports', 'refutes', 'context']
const CHECKS = new Map<string, DiscoverCitationCheck>(
  [
    ['verified', 'found', 'moved'].map((word) => [word, 'verified'] as const),
    ['unchecked', 'not-code', 'unquoted'].map((word) => [word, 'unchecked'] as const),
    (['missing', 'unreadable'] as const).map((word) => [word, word] as const)
  ].flat()
)
// Worst to best: of duplicate citations, the best-checked one is kept.
const CHECK_ORDER: DiscoverCitationCheck[] = ['unreadable', 'missing', 'unchecked', 'verified']

const listSchema = z.array(z.unknown())
const payloadSchema = z.union([listSchema, z.object({ hypotheses: listSchema })])
const hypothesisSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  claim: z.string().optional(),
  title: z.string().optional(),
  confidence: z.unknown().optional(),
  citations: z.unknown().optional()
})
const citationSchema = z.preprocess(
  (value) => (typeof value === 'string' ? { location: value } : value),
  z.object({
    location: z.string(),
    quote: z.string().optional(),
    stance: z.string().optional(),
    check: z.string().optional()
  })
)

function withLines(source: string, start?: string, end?: string): DiscoverCitationRef | null {
  if (!source) {
    return null
  }
  if (start === undefined) {
    return { source }
  }
  const startLine = Number(start)
  const endLine = end === undefined ? startLine : Number(end)
  return startLine >= 1 && endLine >= startLine ? { source, startLine, endLine } : null
}

/** Reads one citation reference; null when it names no source or a reversed line range. */
export function parseDiscoverCitationRef(text: string): DiscoverCitationRef | null {
  const trimmed = text.trim().replace(/[.,;:]+$/, '')
  if (/^https?:\/\//i.test(trimmed)) {
    const lines = URL_LINES.exec(trimmed)
    return withLines(lines ? trimmed.slice(0, lines.index) : trimmed, lines?.[1], lines?.[2])
  }
  const match = PATH_REF.exec(trimmed)
  const path = (match ? match[1] : trimmed).replace(/\\/g, '/').replace(/^\.\//, '')
  return withLines(path, match?.[2], match?.[3])
}

function readCitation(raw: unknown, path: string, issues: DiscoverHypothesisIssue[]) {
  const parsed = citationSchema.safeParse(raw)
  const ref = parsed.success ? parseDiscoverCitationRef(parsed.data.location) : null
  if (!parsed.success || !ref) {
    issues.push({ path, message: 'citation needs a readable location' })
    return null
  }
  const stanceWord = parsed.data.stance?.trim().toLowerCase() ?? 'supports'
  const checkWord = parsed.data.check?.trim().toLowerCase() ?? 'unchecked'
  const stance = STANCES.find((known) => known === stanceWord)
  const check = CHECKS.get(checkWord)
  if (!stance || !check) {
    issues.push({ path, message: `unknown stance "${stanceWord}" or check "${checkWord}"` })
  }
  const quote = parsed.data.quote?.trim()
  const citation: DiscoverCitation = {
    ...ref,
    stance: stance ?? 'context',
    check: check ?? 'unchecked'
  }
  return quote ? { ...citation, quote } : citation
}

function readCitations(raw: unknown, path: string, issues: DiscoverHypothesisIssue[]) {
  const entries: unknown[] = Array.isArray(raw) ? raw : []
  if (raw !== undefined && !Array.isArray(raw)) {
    issues.push({ path, message: 'citations must be an array' })
  }
  if (entries.length > DISCOVER_CITATIONS_MAX_COUNT) {
    issues.push({ path, message: 'citations beyond the limit were dropped' })
  }
  // Finders often cite the same line; keep one per reference and stance.
  const merged = new Map<string, DiscoverCitation>()
  const rank = (citation: DiscoverCitation) => CHECK_ORDER.indexOf(citation.check)
  entries.slice(0, DISCOVER_CITATIONS_MAX_COUNT).forEach((entry, index) => {
    const citation = readCitation(entry, `${path}[${index}]`, issues)
    const key = citation
      ? JSON.stringify([citation.source, citation.startLine, citation.endLine, citation.stance])
      : ''
    const kept = merged.get(key)
    if (citation && (!kept || rank(citation) > rank(kept))) {
      merged.set(key, citation)
    }
  })
  return [...merged.values()]
}

function confidenceOf(value: unknown, path: string, issues: DiscoverHypothesisIssue[]) {
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    issues.push({ path, message: 'confidence must be 0-1 or a 0-100 percentage' })
    return null
  }
  return value > 1 ? value / 100 : value
}

/** Reads `[...]` or `{ hypotheses: [...] }`, skipping each unreadable hypothesis with an issue. */
export function parseDiscoverHypotheses(payload: unknown): {
  hypotheses: DiscoverHypothesis[]
  issues: DiscoverHypothesisIssue[]
} {
  const parsed = payloadSchema.safeParse(payload)
  if (!parsed.success) {
    throw new Error('Discover hypotheses must be an array or { hypotheses: [...] }')
  }
  const items = Array.isArray(parsed.data) ? parsed.data : parsed.data.hypotheses
  const issues: DiscoverHypothesisIssue[] = []
  if (items.length > DISCOVER_HYPOTHESES_MAX_COUNT) {
    issues.push({ path: 'hypotheses', message: 'hypotheses beyond the limit were dropped' })
  }
  const hypotheses = new Map<string, DiscoverHypothesis>()
  items.slice(0, DISCOVER_HYPOTHESES_MAX_COUNT).forEach((raw, index) => {
    const path = `hypotheses[${index}]`
    const value = hypothesisSchema.safeParse(raw)
    const claim = value.success ? (value.data.claim ?? value.data.title ?? '').trim() : ''
    const id = value.success ? String(value.data.id ?? '').trim() || `h${index + 1}` : ''
    if (!value.success || !claim || hypotheses.has(id)) {
      issues.push({ path, message: claim ? `duplicate id "${id}"` : 'hypothesis needs a claim' })
      return
    }
    hypotheses.set(id, {
      id,
      claim,
      confidence: confidenceOf(value.data.confidence, `${path}.confidence`, issues),
      citations: readCitations(value.data.citations, `${path}.citations`, issues)
    })
  })
  return { hypotheses: [...hypotheses.values()], issues }
}

const isFailed = (citation: DiscoverCitation) =>
  citation.check === 'missing' || citation.check === 'unreadable'

const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : null)

export function discoverHypothesisCoverage({ citations, confidence }: DiscoverHypothesis) {
  const verified = citations.filter((citation) => citation.check === 'verified')
  const supporting = verified.filter((citation) => citation.stance === 'supports').length
  const refuting = verified.filter((citation) => citation.stance === 'refutes').length
  const support = ratio(supporting, supporting + refuting)
  // Indexed by (has verified support) + 2 * (has verified refutation).
  const directional = (['unverified', 'supported', 'refuted', 'contested'] as const)[
    Number(supporting > 0) + 2 * Number(refuting > 0)
  ]
  const verdict: DiscoverVerdict = citations.length === 0 ? 'uncited' : directional
  return {
    citations: citations.length,
    verified: verified.length,
    failed: citations.filter(isFailed).length,
    verifiedSupporting: supporting,
    verifiedRefuting: refuting,
    sources: new Set(citations.map((citation) => citation.source)).size,
    verificationRate: ratio(verified.length, citations.length),
    /** Share of verified supporting/refuting evidence that supports the claim. */
    support,
    verdict,
    /** Stated confidence minus evidence support; positive means the claim is overstated. */
    confidenceGap: confidence === null || support === null ? null : confidence - support
  }
}

function cellsFor(citations: DiscoverCitation[], column: Map<string, number>) {
  const cells: (DiscoverMatrixCell | null)[] = Array.from({ length: column.size }, () => null)
  for (const citation of citations) {
    const index = column.get(citation.source) ?? 0
    const cell = cells[index] ?? { supports: 0, refutes: 0, context: 0, verified: 0, failed: 0 }
    cell[citation.stance] += 1
    cell.verified += citation.check === 'verified' ? 1 : 0
    cell.failed += isFailed(citation) ? 1 : 0
    cells[index] = cell
  }
  return cells
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)

/** Rows are hypotheses, columns are cited sources; a rate is null when nothing backs it. */
export function buildDiscoverHypothesisMatrix(
  hypotheses: DiscoverHypothesis[],
  issues: DiscoverHypothesisIssue[] = []
) {
  const citedBy = new Map<string, number>()
  for (const hypothesis of hypotheses) {
    for (const source of new Set(hypothesis.citations.map((citation) => citation.source))) {
      citedBy.set(source, (citedBy.get(source) ?? 0) + 1)
    }
  }
  const count = (source: string) => citedBy.get(source) ?? 0
  const sources = [...citedBy.keys()].sort(
    (a, b) => count(b) - count(a) || (a < b ? -1 : Number(a > b))
  )
  const column = new Map(sources.map((source, index) => [source, index]))
  const rows = hypotheses.map((hypothesis) => ({
    hypothesis,
    coverage: discoverHypothesisCoverage(hypothesis),
    cells: cellsFor(hypothesis.citations, column)
  }))
  const coverages = rows.map((row) => row.coverage)
  const verdicts = Object.fromEntries(
    VERDICTS.map((verdict) => [verdict, coverages.filter((c) => c.verdict === verdict).length])
  ) as Record<DiscoverVerdict, number>
  const confidences = hypotheses.flatMap((h) => (h.confidence === null ? [] : [h.confidence]))
  const gaps = coverages.flatMap((c) => (c.confidenceGap === null ? [] : [c.confidenceGap]))
  const citations = sum(coverages.map((coverage) => coverage.citations))
  const verified = sum(coverages.map((coverage) => coverage.verified))
  const covered = coverages.filter((coverage) => coverage.verifiedSupporting > 0).length
  return {
    /** Most-cited first, then by name, so shared evidence lines up on the left. */
    sources,
    rows,
    issues,
    summary: {
      hypotheses: rows.length,
      citations,
      verifiedCitations: verified,
      failedCitations: sum(coverages.map((coverage) => coverage.failed)),
      uniqueSources: sources.length,
      sharedSources: sources.filter((source) => count(source) > 1).length,
      verdicts,
      /** Hypotheses with at least one verified supporting citation. */
      coverageRate: ratio(covered, rows.length),
      verificationRate: ratio(verified, citations),
      meanConfidence: ratio(sum(confidences), confidences.length),
      meanCalibrationGap: ratio(sum(gaps.map(Math.abs)), gaps.length)
    }
  }
}

/** Parses a Discover hypotheses JSON document within byte and structure limits. */
export function readDiscoverHypothesisMatrix(
  text: string,
  maxBytes: number = DISCOVER_HYPOTHESES_MAX_BYTES
): DiscoverHypothesisMatrix {
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new RangeError(`Discover hypotheses exceed the ${maxBytes} byte limit`)
  }
  assertJsonTextStructureWithinLimits(text, JSON_LIMITS)
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error('Discover hypotheses are not valid JSON')
  }
  const { hypotheses, issues } = parseDiscoverHypotheses(payload)
  return buildDiscoverHypothesisMatrix(hypotheses, issues)
}
