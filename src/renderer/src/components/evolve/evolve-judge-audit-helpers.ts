// Pure logic and default copy behind the Evolve judge audit inspector: which blind cross-family
// verdicts count, which are excluded, and whether the candidate beat the baseline outright.

export const JUDGE_FAMILIES = ['anthropic', 'openai', 'google', 'xai', 'moonshot'] as const
export type EvolveJudgeFamily = (typeof JUDGE_FAMILIES)[number]

/** Which side a judge preferred, always named by role, never by the blind A/B slot. */
export type EvolveJudgeVerdict = 'candidate' | 'baseline' | 'tie'
export type EvolveJudgeAuditStatus = 'passed' | 'failed' | 'inconclusive' | 'not_run'

/** One blind pairwise judgment. `swappedVerdict` is the same judge's verdict with the A/B order
 * reversed; null means the position-bias probe did not run for this judgment. */
export type EvolveJudgment = {
  id: string
  judgeLabel: string
  judgeFamily: EvolveJudgeFamily
  candidateFamily: EvolveJudgeFamily
  shownFirst: 'baseline' | 'candidate'
  verdict: EvolveJudgeVerdict
  swappedVerdict?: EvolveJudgeVerdict | null
  confidence?: number | null
  rationale?: string | null
}

export type EvolveJudgmentFlags = { selfPreference: boolean; positionFlip: boolean }

export type EvolveJudgeAuditSummary = Record<EvolveJudgeVerdict, number> & {
  total: number
  counted: number
  selfPreference: number
  positionFlips: number
  independentFamilies: EvolveJudgeFamily[]
  majority: EvolveJudgeVerdict | null
  agreement: number | null
  status: EvolveJudgeAuditStatus
}

export const DEFAULT_MIN_INDEPENDENT_FAMILIES = 2

/** A judge from the candidate's own family may prefer its own style, and a judge whose verdict
 * follows the A/B order is reading position rather than content; neither one is counted. */
export function judgmentFlags(judgment: EvolveJudgment): EvolveJudgmentFlags {
  const swapped = judgment.swappedVerdict
  return {
    selfPreference: judgment.judgeFamily === judgment.candidateFamily,
    positionFlip: swapped !== null && swapped !== undefined && swapped !== judgment.verdict
  }
}

export function isFlagged(judgment: EvolveJudgment): boolean {
  const flags = judgmentFlags(judgment)
  return flags.selfPreference || flags.positionFlip
}

/** Tallies only independent, position-consistent verdicts. The candidate must win outright, as
 * the incumbent keeps the title on a tie, and enough distinct judge families must have counted. */
export function summarizeJudgeAudit(
  judgments: readonly EvolveJudgment[],
  minIndependentFamilies = DEFAULT_MIN_INDEPENDENT_FAMILIES
): EvolveJudgeAuditSummary {
  const tally: Record<EvolveJudgeVerdict, number> = { candidate: 0, baseline: 0, tie: 0 }
  const families = new Set<EvolveJudgeFamily>()
  let [selfPreference, positionFlips] = [0, 0]
  for (const judgment of judgments) {
    const flags = judgmentFlags(judgment)
    selfPreference += Number(flags.selfPreference)
    positionFlips += Number(flags.positionFlip)
    if (flags.selfPreference || flags.positionFlip) {
      continue
    }
    tally[judgment.verdict] += 1
    families.add(judgment.judgeFamily)
  }
  const counted = tally.candidate + tally.baseline + tally.tie
  const ranked = (Object.keys(tally) as EvolveJudgeVerdict[]).sort((a, b) => tally[b] - tally[a])
  const unique = counted > 0 && tally[ranked[0]] > tally[ranked[1]]
  const majority = unique ? ranked[0] : null
  const independentFamilies = JUDGE_FAMILIES.filter((family) => families.has(family))
  return {
    ...tally,
    total: judgments.length,
    counted,
    selfPreference,
    positionFlips,
    independentFamilies,
    majority,
    agreement: majority ? tally[majority] / counted : null,
    status: auditStatus(judgments.length, independentFamilies.length, tally, minIndependentFamilies)
  }
}

function auditStatus(
  total: number,
  familyCount: number,
  tally: Record<EvolveJudgeVerdict, number>,
  minIndependentFamilies: number
): EvolveJudgeAuditStatus {
  if (total === 0) {
    return 'not_run'
  }
  if (familyCount < Math.max(1, minIndependentFamilies)) {
    return 'inconclusive'
  }
  return tally.candidate > tally.baseline ? 'passed' : 'failed'
}

/** "67%"; null (nothing counted) reads as a dash so nothing looks measured that was not. */
export function formatShare(fraction: number | null | undefined): string {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) {
    return '—'
  }
  return `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`
}

/** "Anthropic, Google"; a dash when no family counted. */
export function familyList(
  families: readonly EvolveJudgeFamily[],
  names: Record<EvolveJudgeFamily, string>
): string {
  return families.length === 0 ? '—' : families.map((family) => names[family]).join(', ')
}

/** Replaces each `{{name}}` with its value; unknown names become empty. */
export function interpolate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : ''
  )
}

/** Every user-visible string the inspector renders; callers pass translated overrides. */
export type EvolveJudgeAuditLabels = {
  title: string
  description: string
  status: Record<EvolveJudgeAuditStatus, string>
  verdict: Record<EvolveJudgeVerdict, string>
  family: Record<EvolveJudgeFamily, string>
  tally: string
  agreement: string
  families: string
  excluded: string
  insufficientFamilies: string
  columns: Record<
    | 'judge'
    | 'candidateFamily'
    | 'order'
    | 'verdict'
    | 'swap'
    | 'confidence'
    | 'flags'
    | 'rationale',
    string
  >
  shownFirst: Record<EvolveJudgment['shownFirst'], string>
  swap: Record<'consistent' | 'flipped' | 'notProbed', string>
  flags: Record<keyof EvolveJudgmentFlags | 'none', string>
  filter: Record<'label' | 'all' | 'flagged', string>
  showRationale: string
  hideRationale: string
  noRationale: string
  rationaleFor: string
  noJudgments: string
  noFlagged: string
  tableLabel: string
  summaryLabel: string
}

export const DEFAULT_JUDGE_AUDIT_LABELS: EvolveJudgeAuditLabels = {
  title: 'Judge audit',
  description:
    'Blind pairwise verdicts from independent model families. Same-family and order-dependent verdicts are shown but not counted.',
  status: {
    passed: 'Passed',
    failed: 'Failed',
    inconclusive: 'Inconclusive',
    not_run: 'Not run'
  },
  verdict: { candidate: 'Candidate', baseline: 'Baseline', tie: 'Tie' },
  family: {
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    google: 'Google',
    xai: 'xAI',
    moonshot: 'Moonshot'
  },
  tally:
    'Candidate {{candidate}} · Baseline {{baseline}} · Tie {{tie}} ({{counted}} of {{total}} counted)',
  agreement: 'Agreement {{share}}',
  families: 'Independent families: {{families}}',
  excluded: '{{selfPreference}} same-family, {{positionFlips}} order-dependent',
  insufficientFamilies: 'Needs verdicts from at least {{min}} independent families.',
  columns: {
    judge: 'Judge',
    candidateFamily: 'Candidate family',
    order: 'Blind order',
    verdict: 'Verdict',
    swap: 'Order swap',
    confidence: 'Confidence',
    flags: 'Flags',
    rationale: 'Rationale'
  },
  shownFirst: { baseline: 'A = baseline', candidate: 'A = candidate' },
  swap: { consistent: 'Consistent', flipped: 'Flipped', notProbed: 'Not probed' },
  flags: { selfPreference: 'Same family', positionFlip: 'Order-dependent', none: 'None' },
  filter: { label: 'Show judgments', all: 'All', flagged: 'Flagged only' },
  showRationale: 'Show rationale',
  hideRationale: 'Hide rationale',
  noRationale: 'This judge gave no rationale.',
  rationaleFor: 'Rationale from {{judge}}',
  noJudgments: 'No judge has audited this run yet.',
  noFlagged: 'No judgment is flagged.',
  tableLabel: 'Blind judge verdicts',
  summaryLabel: 'Audit summary'
}

/** Any subset of the labels; a nested group may override only some of its keys. */
export type EvolveJudgeAuditLabelOverrides = {
  [K in keyof EvolveJudgeAuditLabels]?: EvolveJudgeAuditLabels[K] extends string
    ? string
    : Partial<EvolveJudgeAuditLabels[K]>
}

/** Defaults with any overrides on top; nested groups merge key by key. */
export function resolveJudgeAuditLabels(
  overrides: EvolveJudgeAuditLabelOverrides = {}
): EvolveJudgeAuditLabels {
  const base = DEFAULT_JUDGE_AUDIT_LABELS
  return {
    ...base,
    ...overrides,
    status: { ...base.status, ...overrides.status },
    verdict: { ...base.verdict, ...overrides.verdict },
    family: { ...base.family, ...overrides.family },
    columns: { ...base.columns, ...overrides.columns },
    shownFirst: { ...base.shownFirst, ...overrides.shownFirst },
    swap: { ...base.swap, ...overrides.swap },
    flags: { ...base.flags, ...overrides.flags },
    filter: { ...base.filter, ...overrides.filter }
  }
}

export function swapState(judgment: EvolveJudgment): keyof EvolveJudgeAuditLabels['swap'] {
  if (judgment.swappedVerdict === null || judgment.swappedVerdict === undefined) {
    return 'notProbed'
  }
  return judgmentFlags(judgment).positionFlip ? 'flipped' : 'consistent'
}

/** Flag names for one judgment in display order; empty when it counts. */
export function flagKeys(judgment: EvolveJudgment): (keyof EvolveJudgmentFlags)[] {
  const flags = judgmentFlags(judgment)
  return (['selfPreference', 'positionFlip'] as const).filter((key) => flags[key])
}
