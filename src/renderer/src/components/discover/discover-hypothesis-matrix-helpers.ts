export type DiscoverHypothesisVerdict = 'supported' | 'mixed' | 'refuted' | 'untested'

export type DiscoverHypothesisCell = {
  verdict: DiscoverHypothesisVerdict
  evidenceCount?: number
}

export type DiscoverHypothesisLens = {
  id: string
  name: string
}

export type DiscoverHypothesis = {
  id: string
  statement: string
  // Keyed by lens id; a missing lens counts as untested.
  cells: Partial<Record<string, DiscoverHypothesisCell>>
}

export type DiscoverHypothesisFilter = 'all' | DiscoverHypothesisVerdict

export type DiscoverHypothesisSort = 'original' | 'confidence'

export type DiscoverHypothesisCellSelection = {
  hypothesisId: string
  lensId: string
}

export type DiscoverHypothesisCellLabelInput = {
  hypothesis: string
  lens: string
  verdict: string
  evidence: string
}

export type DiscoverHypothesisMatrixLabels = {
  heading: string
  hypothesisColumn: string
  confidenceColumn: string
  coverageRow: string
  filterGroup: string
  filterAll: string
  sortByConfidence: string
  emptyMatrix: string
  emptyFilter: string
  untestedConfidence: string
  verdicts: Record<DiscoverHypothesisVerdict, string>
  evidence: (count: number) => string
  confidence: (percent: number) => string
  coverage: (tested: number, total: number) => string
  shown: (shown: number, total: number) => string
  cell: (input: DiscoverHypothesisCellLabelInput) => string
}

export type DiscoverHypothesisMatrixLabelOverrides = Partial<
  Omit<DiscoverHypothesisMatrixLabels, 'verdicts'>
> & {
  verdicts?: Partial<Record<DiscoverHypothesisVerdict, string>>
}

export const DEFAULT_DISCOVER_HYPOTHESIS_MATRIX_LABELS: DiscoverHypothesisMatrixLabels = {
  heading: 'Hypothesis matrix',
  hypothesisColumn: 'Hypothesis',
  confidenceColumn: 'Confidence',
  coverageRow: 'Tested',
  filterGroup: 'Filter hypotheses by verdict',
  filterAll: 'All',
  sortByConfidence: 'Sort by confidence',
  emptyMatrix: 'No hypotheses yet. Run Discover to generate some.',
  emptyFilter: 'No hypotheses match this filter.',
  untestedConfidence: 'Not tested',
  verdicts: {
    supported: 'Supported',
    mixed: 'Mixed',
    refuted: 'Refuted',
    untested: 'Untested'
  },
  evidence: (count) => (count === 1 ? '1 source' : `${count} sources`),
  confidence: (percent) => `${percent}%`,
  coverage: (tested, total) => `${tested}/${total}`,
  shown: (shown, total) => `Showing ${shown} of ${total} hypotheses`,
  cell: ({ hypothesis, lens, verdict, evidence }) =>
    `${hypothesis}, ${lens}: ${verdict}, ${evidence}`
}

export const DISCOVER_HYPOTHESIS_FILTERS: readonly DiscoverHypothesisFilter[] = [
  'all',
  'supported',
  'mixed',
  'refuted',
  'untested'
]

const VERDICT_SCORE: Record<Exclude<DiscoverHypothesisVerdict, 'untested'>, number> = {
  supported: 1,
  mixed: 0.5,
  refuted: 0
}

const UNTESTED_CELL: DiscoverHypothesisCell = { verdict: 'untested', evidenceCount: 0 }

export function resolveDiscoverHypothesisMatrixLabels(
  overrides?: DiscoverHypothesisMatrixLabelOverrides
): DiscoverHypothesisMatrixLabels {
  if (!overrides) {
    return DEFAULT_DISCOVER_HYPOTHESIS_MATRIX_LABELS
  }
  return {
    ...DEFAULT_DISCOVER_HYPOTHESIS_MATRIX_LABELS,
    ...overrides,
    verdicts: { ...DEFAULT_DISCOVER_HYPOTHESIS_MATRIX_LABELS.verdicts, ...overrides.verdicts }
  }
}

export function normalizeDiscoverEvidenceCount(count: number | undefined): number {
  if (count === undefined || !Number.isFinite(count) || count < 0) {
    return 0
  }
  return Math.floor(count)
}

export function discoverHypothesisCell(
  hypothesis: DiscoverHypothesis,
  lensId: string
): DiscoverHypothesisCell {
  const cell = hypothesis.cells[lensId]
  if (!cell) {
    return UNTESTED_CELL
  }
  return {
    verdict: cell.verdict,
    evidenceCount: normalizeDiscoverEvidenceCount(cell.evidenceCount)
  }
}

// First occurrence wins so duplicate ids never collide as React keys.
export function uniqueDiscoverEntries<T extends { id: string }>(entries: readonly T[]): T[] {
  const seen = new Set<string>()
  const unique: T[] = []
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      continue
    }
    seen.add(entry.id)
    unique.push(entry)
  }
  return unique
}

// Evidence-weighted support across tested lenses; null when nothing was tested.
export function discoverHypothesisConfidence(
  hypothesis: DiscoverHypothesis,
  lenses: readonly DiscoverHypothesisLens[]
): number | null {
  let weighted = 0
  let weight = 0
  for (const lens of lenses) {
    const cell = discoverHypothesisCell(hypothesis, lens.id)
    if (cell.verdict === 'untested') {
      continue
    }
    const cellWeight = Math.max(1, cell.evidenceCount ?? 0)
    weighted += VERDICT_SCORE[cell.verdict] * cellWeight
    weight += cellWeight
  }
  if (weight === 0) {
    return null
  }
  return Math.round((weighted / weight) * 100)
}

export function discoverHypothesisRowVerdict(
  hypothesis: DiscoverHypothesis,
  lenses: readonly DiscoverHypothesisLens[]
): DiscoverHypothesisVerdict {
  const tested = new Set<DiscoverHypothesisVerdict>()
  for (const lens of lenses) {
    const { verdict } = discoverHypothesisCell(hypothesis, lens.id)
    if (verdict !== 'untested') {
      tested.add(verdict)
    }
  }
  if (tested.size === 0) {
    return 'untested'
  }
  if (tested.size === 1) {
    return [...tested][0]
  }
  return 'mixed'
}

export type DiscoverHypothesisMatrixRow = {
  hypothesis: DiscoverHypothesis
  index: number
  verdict: DiscoverHypothesisVerdict
  confidence: number | null
  cells: { lens: DiscoverHypothesisLens; cell: DiscoverHypothesisCell }[]
}

function compareByConfidence(
  a: DiscoverHypothesisMatrixRow,
  b: DiscoverHypothesisMatrixRow
): number {
  if (a.confidence === b.confidence) {
    return a.index - b.index
  }
  if (a.confidence === null) {
    return 1
  }
  if (b.confidence === null) {
    return -1
  }
  return b.confidence - a.confidence
}

export function buildDiscoverHypothesisMatrixRows(
  hypotheses: readonly DiscoverHypothesis[],
  lenses: readonly DiscoverHypothesisLens[],
  options: { filter: DiscoverHypothesisFilter; sort: DiscoverHypothesisSort }
): DiscoverHypothesisMatrixRow[] {
  const rows = hypotheses.map((hypothesis, index) => ({
    hypothesis,
    index,
    verdict: discoverHypothesisRowVerdict(hypothesis, lenses),
    confidence: discoverHypothesisConfidence(hypothesis, lenses),
    cells: lenses.map((lens) => ({ lens, cell: discoverHypothesisCell(hypothesis, lens.id) }))
  }))
  const filtered =
    options.filter === 'all' ? rows : rows.filter((row) => row.verdict === options.filter)
  if (options.sort === 'confidence') {
    return filtered.toSorted(compareByConfidence)
  }
  return filtered
}

export type DiscoverLensCoverage = {
  lensId: string
  tested: number
  total: number
}

export function summarizeDiscoverLensCoverage(
  hypotheses: readonly DiscoverHypothesis[],
  lenses: readonly DiscoverHypothesisLens[]
): DiscoverLensCoverage[] {
  return lenses.map((lens) => ({
    lensId: lens.id,
    tested: hypotheses.filter(
      (hypothesis) => discoverHypothesisCell(hypothesis, lens.id).verdict !== 'untested'
    ).length,
    total: hypotheses.length
  }))
}

export function isSameDiscoverCell(
  selection: DiscoverHypothesisCellSelection | null | undefined,
  hypothesisId: string,
  lensId: string
): boolean {
  return selection?.hypothesisId === hypothesisId && selection.lensId === lensId
}
