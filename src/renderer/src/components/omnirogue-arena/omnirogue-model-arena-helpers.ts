import { translate } from '@/i18n/i18n'
import type { OmniRogueGatewayModelOption } from '../../../../shared/omnirogue-account'

export const MODEL_ARENA_MIN_CONTENDERS = 2
export const MODEL_ARENA_MAX_CONTENDERS = 4

export const OMNIROGUE_MODEL_ARENA_LABELS = {
  title: 'Model Arena',
  description: 'Send one prompt to several OmniRogue models, compare the answers and pick a winner.',
  prompt: 'Prompt',
  models: 'Models',
  selection: '{selected} of {max} selected (pick at least {min})',
  blind: 'Blind comparison',
  blindHint: 'Hide model names until you vote.',
  cost: 'Round cost: {amount}',
  available: 'Available credits: {amount}',
  creditAmount: '{amount} cr',
  unknownValue: '—',
  quoting: 'Loading credit cost…',
  lowBalance: 'Low credit balance after this round.',
  insufficient: 'Insufficient credits for this round.',
  unknownBalance: 'Connect OmniRogue or refresh your credits to continue.',
  refresh: 'Refresh credits',
  run: 'Run round',
  checking: 'Checking credits…',
  running: 'Running models…',
  contender: 'Model {letter}',
  revealed: '{contender} · {model}',
  latency: 'Latency',
  charged: 'Charged',
  milliseconds: '{value} ms',
  seconds: '{value} s',
  roundCharged: 'Round charged: {amount}',
  answerFailed: 'This model did not answer.',
  pick: 'Pick as winner',
  tie: 'Call it a tie',
  voting: 'Saving vote…',
  winner: 'Winner',
  tieResult: 'You called this round a tie.',
  newRound: 'New round',
  close: 'Close',
  quoteFailed: 'Could not load the credit cost. Try again.',
  invalidQuote: 'Credit quote is unavailable. Try again.',
  expired: 'The credit quote expired. Review the updated cost and try again.',
  balanceChanged: 'Your credit balance is unavailable or insufficient. Refresh credits and try again.',
  serviceChanged: 'The OmniRogue connection changed. Review your round and try again.',
  incompleteRound: 'OmniRogue returned an incomplete round. Check your usage before running again.',
  runFailed: 'The round failed. Check your usage before retrying.',
  voteFailed: 'Could not save your vote. Try again.',
  refreshFailed: 'Could not refresh credits. Try again.'
} as const
export type OmniRogueModelArenaLabelKey = keyof typeof OMNIROGUE_MODEL_ARENA_LABELS
export type OmniRogueModelArenaLabels = Record<OmniRogueModelArenaLabelKey, string>

export type ModelArenaModel = Pick<OmniRogueGatewayModelOption, 'id' | 'label' | 'provider'>
export type ModelArenaRequest = {
  prompt: string
  modelIds: readonly string[]
}
export type ModelArenaQuote = {
  id: string
  // Maximum total charge for every contender in the round; the adapter enforces it atomically.
  credits: number
  expiresAt: number
}
export type ModelArenaAnswer = {
  modelId: string
  status: 'completed' | 'failed'
  output: string
  latencyMs: number
  credits: number
}
export type ModelArenaRound = {
  id: string
  answers: readonly ModelArenaAnswer[]
}
export type ModelArenaVerdict = {
  roundId: string
  // null records a tie.
  winnerModelId: string | null
  blind: boolean
}
// The adapter owns authenticated OmniRogue calls, quote enforcement and vote persistence.
export type OmniRogueModelArenaService = {
  quote: (request: ModelArenaRequest, options: { signal: AbortSignal }) => Promise<ModelArenaQuote>
  run: (
    request: ModelArenaRequest,
    options: { quoteId: string; signal: AbortSignal }
  ) => Promise<ModelArenaRound>
  vote: (verdict: ModelArenaVerdict, options: { signal: AbortSignal }) => Promise<void>
}

// Carries a label key so every surfaced failure stays localizable.
export class ModelArenaError extends Error {
  readonly labelKey: OmniRogueModelArenaLabelKey
  constructor(labelKey: OmniRogueModelArenaLabelKey) {
    super(OMNIROGUE_MODEL_ARENA_LABELS[labelKey])
    this.name = 'ModelArenaError'
    this.labelKey = labelKey
  }
}

export function resolveModelArenaLabels(
  overrides: Partial<OmniRogueModelArenaLabels> = {}
): OmniRogueModelArenaLabels {
  return Object.fromEntries(
    Object.entries(OMNIROGUE_MODEL_ARENA_LABELS).map(([key, fallback]) => [
      key,
      overrides[key as OmniRogueModelArenaLabelKey] ?? translate(`omnirogueModelArena.${key}`, fallback)
    ])
  ) as OmniRogueModelArenaLabels
}

export function fillModelArenaLabel(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : match
  )
}

export function modelArenaErrorKey(
  cause: unknown,
  fallback: OmniRogueModelArenaLabelKey
): OmniRogueModelArenaLabelKey {
  return cause instanceof ModelArenaError ? cause.labelKey : fallback
}

const creditFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })

export function formatModelArenaCredits(value: number, labels: OmniRogueModelArenaLabels): string {
  return fillModelArenaLabel(labels.creditAmount, { amount: creditFormat.format(value) })
}

export function formatModelArenaLatency(latencyMs: number, labels: OmniRogueModelArenaLabels): string {
  if (latencyMs < 1000) {
    return fillModelArenaLabel(labels.milliseconds, { value: Math.round(latencyMs) })
  }
  return fillModelArenaLabel(labels.seconds, { value: (latencyMs / 1000).toFixed(1) })
}

export function modelArenaContenderName(index: number, labels: OmniRogueModelArenaLabels): string {
  return fillModelArenaLabel(labels.contender, { letter: String.fromCharCode(65 + index) })
}

export function modelArenaModelLabel(modelId: string, models: readonly ModelArenaModel[]): string {
  return models.find((model) => model.id === modelId)?.label ?? modelId
}

export function toggleModelArenaSelection(
  selected: readonly string[],
  modelId: string,
  max = MODEL_ARENA_MAX_CONTENDERS
): string[] {
  if (selected.includes(modelId)) {
    return selected.filter((id) => id !== modelId)
  }
  if (selected.length >= max) {
    return [...selected]
  }
  return [...selected, modelId]
}

export function buildModelArenaRequest(
  prompt: string,
  selected: readonly string[],
  models: readonly ModelArenaModel[]
): ModelArenaRequest | null {
  const text = prompt.trim()
  const known = new Set(models.map((model) => model.id))
  const modelIds = [...new Set(selected)].filter((id) => known.has(id))
  if (!text || modelIds.length !== selected.length) {
    return null
  }
  if (modelIds.length < MODEL_ARENA_MIN_CONTENDERS || modelIds.length > MODEL_ARENA_MAX_CONTENDERS) {
    return null
  }
  return { prompt: text, modelIds }
}

function isNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0
}

export function isCompleteModelArenaRound(round: ModelArenaRound | null | undefined, request: ModelArenaRequest): boolean {
  if (!round?.id?.trim() || !Array.isArray(round.answers) || round.answers.length !== request.modelIds.length) {
    return false
  }
  const answered = new Set(round.answers.map((answer) => answer.modelId))
  if (answered.size !== request.modelIds.length || request.modelIds.some((id) => !answered.has(id))) {
    return false
  }
  return round.answers.every((answer) =>
    (answer.status === 'completed' || answer.status === 'failed') && typeof answer.output === 'string' &&
    isNonNegative(answer.latencyMs) && isNonNegative(answer.credits)
  )
}

export function modelArenaRoundCredits(round: ModelArenaRound): number {
  return round.answers.reduce((total, answer) => total + answer.credits, 0)
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

// Blind rounds must not reveal the selection order; seeding by round ID keeps re-renders stable.
export function modelArenaDisplayOrder(round: ModelArenaRound, blind: boolean): ModelArenaAnswer[] {
  if (!blind) {
    return [...round.answers]
  }
  return round.answers
    .map((answer) => ({ answer, rank: fnv1a(`${round.id}:${answer.modelId}`) }))
    .toSorted((a, b) => a.rank - b.rank || a.answer.modelId.localeCompare(b.answer.modelId))
    .map(({ answer }) => answer)
}
