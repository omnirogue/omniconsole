import { evolveStartRequestSchema } from '../../../shared/evolve-workflow'
import type { EvolveStartRequest, EvolveWorkflowRunRecord } from '../../../shared/evolve-workflow'
import type { OmniRogueCreditBalance } from '../../../shared/omnirogue-account'

export type HostedImproveTier = 'hosted_super_intelligence' | 'hosted_pro'
export type ImproveCandidate = { id: string; kind: 'markdown' | 'prompt' | 'script'; text: string }
export type ImproveRubricCriterion = { id: string; instructions: string; weight: number }
export type ImproveDatasetCase = { id: string; input: string; expectedOutput?: string }

// Bridge projections: this branch does not yet export improve-types.ts or ImproveProposal.
export type ImproveRunResult = {
  runId: string
  bestCandidate: ImproveCandidate
  rubricCriteria: ImproveRubricCriterion[]
  datasetCases: ImproveDatasetCase[]
}

/** Supplied by the hosted quote provider; the bridge never invents credit pricing. */
export type HostedImproveCreditQuote = {
  executionTier: HostedImproveTier
  estimatedCredits: number
}

/** Send intact to a seed-capable hosted transport; the legacy strict Start schema rejects it. */
export type HostedImproveRequest = EvolveStartRequest & {
  runsOn: 'hosted'
  executionTier: HostedImproveTier
  seedFromRunId: string
  seedCandidateId: string
  incumbentKind: ImproveCandidate['kind']
  initialIncumbentText: string
  rubricCriteria: ImproveRubricCriterion[]
  rubricWeights: Record<string, number>
  datasetCases: ImproveDatasetCase[]
  creditBudgetQuote: HostedImproveCreditQuote
}

export type HostedImprovePromotionSummary = {
  runId: string
  seedFromRunId: string
  candidate: ImproveCandidate
  promoted: boolean
  pairwiseTournamentWinRate: number | null
  blindCrossFamilyAuditStatus: 'passed' | 'failed' | 'unavailable' | 'not_run'
  creditsSpent: number
}

export type ImproveProposal = {
  candidate: ImproveCandidate
  originalText: string
  patch: string
  provenance: {
    localRunId: string
    localCandidateId: string
    hostedRunId: string
    ledgerRunId?: string
    hostedCandidateId: string
    executionTier: HostedImproveTier
    pairwiseTournamentWinRate: number | null
    blindCrossFamilyAuditStatus: HostedImprovePromotionSummary['blindCrossFamilyAuditStatus']
    creditsSpent: number
    creditBudgetQuote: HostedImproveCreditQuote
  }
}

export class HostedImproveCreditError extends Error {
  readonly code = 'insufficient_credits'
  readonly topUpCredits: number

  constructor(
    readonly spendableCredits: number,
    readonly estimatedCredits: number
  ) {
    const shortfall = estimatedCredits - spendableCredits
    super(
      `Hosted Improve needs ${estimatedCredits} OmniRogue credits; ${spendableCredits} are available. Top up at least ${shortfall} OmniRogue credits, then retry.`
    )
    this.name = 'HostedImproveCreditError'
    this.topUpCredits = shortfall
  }
}

function nonnegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be finite and nonnegative.`)
  }
}

function nonempty(value: string, label: string): void {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required.`)
  }
}

function validateCandidate(candidate: ImproveCandidate): void {
  nonempty(candidate.id, 'Candidate ID')
  nonempty(candidate.text, 'Candidate text')
  if (!['markdown', 'prompt', 'script'].includes(candidate.kind)) {
    throw new Error('Unsupported Improve candidate kind.')
  }
}

function validateTier(tier: HostedImproveTier): void {
  if (tier !== 'hosted_pro' && tier !== 'hosted_super_intelligence') {
    throw new Error('Choose hosted_pro or hosted_super_intelligence for Hosted Improve.')
  }
}

export function preflightHostedImproveCredits(
  balance: OmniRogueCreditBalance,
  quote: HostedImproveCreditQuote
): void {
  validateTier(quote.executionTier)
  nonnegative(quote.estimatedCredits, 'Estimated credits')
  nonnegative(balance.availableCredits, 'Available credits')
  // availableCredits is spendable; reservations and total balance must not be counted again.
  if (balance.availableCredits < quote.estimatedCredits) {
    throw new HostedImproveCreditError(balance.availableCredits, quote.estimatedCredits)
  }
}

export function createHostedImproveRequest(
  local: ImproveRunResult,
  options: {
    request: Omit<EvolveStartRequest, 'runsOn' | 'seedFrom' | 'rubricFrom'>
    quote: HostedImproveCreditQuote
    balance: OmniRogueCreditBalance
  }
): HostedImproveRequest {
  preflightHostedImproveCredits(options.balance, options.quote)
  nonempty(local.runId, 'Local Improve run ID')
  validateCandidate(local.bestCandidate)
  const rubricIds = new Set<string>()
  if (!local.rubricCriteria.length) {
    throw new Error('At least one rubric criterion is required.')
  }
  for (const criterion of local.rubricCriteria) {
    nonempty(criterion.id, 'Rubric criterion ID')
    nonempty(criterion.instructions, 'Rubric instructions')
    nonnegative(criterion.weight, 'Rubric weight')
    if (rubricIds.has(criterion.id)) {
      throw new Error('Rubric criterion IDs must be unique.')
    }
    rubricIds.add(criterion.id)
  }
  if (!local.rubricCriteria.some(({ weight }) => weight > 0)) {
    throw new Error('At least one rubric weight must be positive.')
  }
  const caseIds = new Set<string>()
  for (const entry of local.datasetCases) {
    nonempty(entry.id, 'Dataset case ID')
    if (typeof entry.input !== 'string') {
      throw new Error('Dataset case input must be text.')
    }
    if (entry.expectedOutput !== undefined && typeof entry.expectedOutput !== 'string') {
      throw new Error('Dataset expected output must be text.')
    }
    if (caseIds.has(entry.id)) {
      throw new Error('Dataset case IDs must be unique.')
    }
    caseIds.add(entry.id)
  }
  const request = evolveStartRequestSchema.parse({ ...options.request, runsOn: 'hosted' })
  if (request.seedFrom || request.rubricFrom) {
    throw new Error('Use the local Improve seed and rubric.')
  }
  return {
    ...request,
    runsOn: 'hosted',
    executionTier: options.quote.executionTier,
    seedFromRunId: local.runId,
    seedCandidateId: local.bestCandidate.id,
    incumbentKind: local.bestCandidate.kind,
    initialIncumbentText: local.bestCandidate.text,
    rubricCriteria: local.rubricCriteria.map((criterion) => ({ ...criterion })),
    rubricWeights: Object.fromEntries(local.rubricCriteria.map(({ id, weight }) => [id, weight])),
    datasetCases: local.datasetCases.map((entry) => ({ ...entry })),
    creditBudgetQuote: { ...options.quote }
  }
}

/** A review artifact only: this never applies a patch or promotes a workflow. */
export function hostedImproveProposal(
  run: EvolveWorkflowRunRecord & { request: HostedImproveRequest },
  promotionSummary: HostedImprovePromotionSummary
): ImproveProposal | null {
  const seed = run.request
  if (run.state !== 'done' || (run.ledger && run.ledger.status !== 'done')) {
    throw new Error('Hosted Improve must finish successfully before a proposal can be read.')
  }
  if (seed.runsOn !== 'hosted') {
    throw new Error('Expected a hosted Evolve run.')
  }
  validateTier(seed.executionTier)
  nonempty(run.id, 'Hosted run ID')
  nonempty(seed.seedFromRunId, 'Local Improve run ID')
  nonempty(seed.seedCandidateId, 'Local candidate ID')
  nonempty(seed.initialIncumbentText, 'Initial incumbent text')
  if (promotionSummary.runId !== run.id || promotionSummary.seedFromRunId !== seed.seedFromRunId) {
    throw new Error('Hosted promotion does not belong to this run and local Improve seed.')
  }
  if (seed.creditBudgetQuote.executionTier !== seed.executionTier) {
    throw new Error('Hosted credit quote does not match the execution tier.')
  }
  nonnegative(seed.creditBudgetQuote.estimatedCredits, 'Estimated credits')
  nonnegative(promotionSummary.creditsSpent, 'Credits spent')
  const winRate = promotionSummary.pairwiseTournamentWinRate
  if (winRate !== null && (!Number.isFinite(winRate) || winRate < 0 || winRate > 1)) {
    throw new Error('Pairwise tournament win rate must be null or between 0 and 1.')
  }
  if (
    !['passed', 'failed', 'unavailable', 'not_run'].includes(
      promotionSummary.blindCrossFamilyAuditStatus
    )
  ) {
    throw new Error('Unknown blind cross-family audit status.')
  }
  if (typeof promotionSummary.promoted !== 'boolean') {
    throw new Error('Promotion decision is required.')
  }
  if (!promotionSummary.promoted) {
    return null
  }
  validateCandidate(promotionSummary.candidate)
  if (promotionSummary.candidate.kind !== seed.incumbentKind) {
    throw new Error('Hosted candidate kind does not match the local incumbent.')
  }
  return {
    candidate: { ...promotionSummary.candidate },
    originalText: seed.initialIncumbentText,
    patch: textPatch(seed.initialIncumbentText, promotionSummary.candidate.text),
    provenance: {
      localRunId: seed.seedFromRunId,
      localCandidateId: seed.seedCandidateId,
      hostedRunId: run.id,
      ...(run.ledgerRunId ? { ledgerRunId: run.ledgerRunId } : {}),
      hostedCandidateId: promotionSummary.candidate.id,
      executionTier: seed.executionTier,
      pairwiseTournamentWinRate: winRate,
      blindCrossFamilyAuditStatus: promotionSummary.blindCrossFamilyAuditStatus,
      creditsSpent: promotionSummary.creditsSpent,
      creditBudgetQuote: { ...seed.creditBudgetQuote }
    }
  }
}

function textPatch(before: string, after: string): string {
  if (before === after) {
    return ''
  }
  const lines = (text: string) => (text ? text.replace(/\n$/, '').split('\n') : [])
  const removed = lines(before)
  const added = lines(after)
  const side = (text: string, entries: string[], prefix: string) => [
    ...entries.map((line) => `${prefix}${line}`),
    ...(text && !text.endsWith('\n') ? ['\\ No newline at end of file'] : [])
  ]
  return [
    '--- a/workflow',
    '+++ b/workflow',
    `@@ -${removed.length ? 1 : 0},${removed.length} +${added.length ? 1 : 0},${added.length} @@`,
    ...side(before, removed, '-'),
    ...side(after, added, '+'),
    ''
  ].join('\n')
}
