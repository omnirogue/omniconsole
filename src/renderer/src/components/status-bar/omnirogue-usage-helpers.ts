import type { OmniRogueCreditBalance } from '../../../../shared/omnirogue-account'
import { OMNIROGUE_GATEWAY_MODELS } from '../../../../shared/omnirogue-account'

export type OmniRogueUsageCapability =
  | 'llm-gateway'
  | 'media-generation'
  | 'hosted-evolve-si'
  | 'discover-si'

export const OMNIROGUE_USAGE_CAPABILITIES: readonly OmniRogueUsageCapability[] = [
  'llm-gateway',
  'media-generation',
  'hosted-evolve-si',
  'discover-si'
]

export const OMNIROGUE_USAGE_CAPABILITY_LABELS: Record<OmniRogueUsageCapability, string> = {
  'llm-gateway': 'LLM Gateway',
  'media-generation': 'Media Generation',
  'hosted-evolve-si': 'Hosted Evolve SI',
  'discover-si': 'Discover SI'
}

export type OmniRogueUsageEntry = {
  id: string
  /** ISO-8601 timestamp of the charge. */
  occurredAt: string
  capability: OmniRogueUsageCapability
  model?: string | null
  description?: string | null
  credits: number
  /** Credits the prompt cache saved versus an uncached run of the same request. */
  cacheSavedCredits?: number
  promptTokens?: number
  cachedPromptTokens?: number
}

export type OmniRogueUsageBreakdownRow<K extends string = string> = {
  key: K
  label: string
  credits: number
  /** 0..1 share of the breakdown's total. */
  share: number
  count: number
}

export type OmniRogueCacheSavings = {
  savedCredits: number
  /** 0..1, or null when no entry reported prompt tokens. */
  hitRatio: number | null
  promptTokens: number
  cachedPromptTokens: number
}

export type OmniRogueUsageSummary = {
  totalCredits: number
  entryCount: number
  byCapability: OmniRogueUsageBreakdownRow<OmniRogueUsageCapability>[]
  byModel: OmniRogueUsageBreakdownRow[]
  cache: OmniRogueCacheSavings
}

export type OmniRogueLowBalanceState = {
  isLow: boolean
  threshold: number
  availableCredits: number
}

export const OMNIROGUE_DEFAULT_LOW_BALANCE_THRESHOLD = 100

const EXTRA_MODEL_LABELS: Record<string, string> = { 'kimi-k3': 'Kimi K3' }

// Provider prefixes ("moonshotai/kimi-k3") and dotted versions ("claude-opus-5.5") share one key.
export function normalizeOmniRogueModelKey(model: string): string {
  const trimmed = model.trim().toLowerCase()
  return trimmed.slice(trimmed.lastIndexOf('/') + 1).replaceAll('.', '-')
}

const MODEL_LABELS: ReadonlyMap<string, string> = new Map([
  ...OMNIROGUE_GATEWAY_MODELS.map(
    (option) => [normalizeOmniRogueModelKey(option.id), option.label] as const
  ),
  ...Object.entries(EXTRA_MODEL_LABELS)
])

export function resolveOmniRogueModelLabel(model: string): string {
  return MODEL_LABELS.get(normalizeOmniRogueModelKey(model)) ?? model.trim()
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function spendable(value: number | null | undefined): number {
  return isFiniteNumber(value) && value > 0 ? value : 0
}

function shareOf(part: number, total: number): number {
  return total > 0 ? part / total : 0
}

export function summarizeOmniRogueUsage(
  entries: readonly OmniRogueUsageEntry[]
): OmniRogueUsageSummary {
  const capabilityTotals = new Map<OmniRogueUsageCapability, { credits: number; count: number }>()
  const modelTotals = new Map<string, { label: string; credits: number; count: number }>()
  let totalCredits = 0
  let modelCredits = 0
  let savedCredits = 0
  let promptTokens = 0
  let cachedPromptTokens = 0

  for (const entry of entries) {
    const credits = spendable(entry.credits)
    totalCredits += credits
    savedCredits += spendable(entry.cacheSavedCredits)
    const prompt = spendable(entry.promptTokens)
    promptTokens += prompt
    cachedPromptTokens += Math.min(spendable(entry.cachedPromptTokens), prompt)

    const capability = capabilityTotals.get(entry.capability) ?? { credits: 0, count: 0 }
    capability.credits += credits
    capability.count += 1
    capabilityTotals.set(entry.capability, capability)

    const rawModel = entry.model?.trim()
    if (rawModel) {
      const key = normalizeOmniRogueModelKey(rawModel)
      const model = modelTotals.get(key) ?? {
        label: resolveOmniRogueModelLabel(rawModel),
        credits: 0,
        count: 0
      }
      model.credits += credits
      model.count += 1
      modelTotals.set(key, model)
      modelCredits += credits
    }
  }

  const byCapability = OMNIROGUE_USAGE_CAPABILITIES.map((key) => {
    const totals = capabilityTotals.get(key) ?? { credits: 0, count: 0 }
    return {
      key,
      label: OMNIROGUE_USAGE_CAPABILITY_LABELS[key],
      credits: totals.credits,
      share: shareOf(totals.credits, totalCredits),
      count: totals.count
    }
  })

  // Model shares are of model-billed spend so the rows add up to 100%.
  const byModel = Array.from(modelTotals, ([key, totals]) => ({
    key,
    label: totals.label,
    credits: totals.credits,
    share: shareOf(totals.credits, modelCredits),
    count: totals.count
  })).sort((a, b) => b.credits - a.credits || a.label.localeCompare(b.label))

  return {
    totalCredits,
    entryCount: entries.length,
    byCapability,
    byModel,
    cache: {
      savedCredits,
      hitRatio: promptTokens > 0 ? cachedPromptTokens / promptTokens : null,
      promptTokens,
      cachedPromptTokens
    }
  }
}

export function formatOmniRogueCredits(value: number): string {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: value % 1 === 0 ? 0 : 2
  }).format(value)
}

export function formatOmniRogueShare(share: number): string {
  if (!Number.isFinite(share) || share <= 0) {
    return '0%'
  }
  if (share < 0.001) {
    return '<0.1%'
  }
  return new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 }).format(
    share
  )
}

function validThreshold(value: number | undefined): number | undefined {
  return isFiniteNumber(value) && value >= 0 ? value : undefined
}

export function resolveOmniRogueLowBalance(
  balance: OmniRogueCreditBalance | null | undefined,
  thresholdOverride?: number
): OmniRogueLowBalanceState | null {
  if (!balance || !Number.isFinite(balance.availableCredits)) {
    return null
  }
  const threshold =
    validThreshold(thresholdOverride) ??
    validThreshold(balance.lowBalanceThreshold) ??
    OMNIROGUE_DEFAULT_LOW_BALANCE_THRESHOLD
  return {
    isLow: balance.availableCredits <= threshold,
    threshold,
    availableCredits: balance.availableCredits
  }
}

const CSV_HEADER = [
  'Receipt ID',
  'Date (UTC)',
  'Capability',
  'Model',
  'Description',
  'Credits',
  'Prompt-cache saved credits',
  'Prompt tokens',
  'Cached prompt tokens'
]

type NumericColumn = (entry: OmniRogueUsageEntry) => number | undefined

const NUMERIC_COLUMNS: readonly NumericColumn[] = [
  (entry) => entry.credits,
  (entry) => entry.cacheSavedCredits,
  (entry) => entry.promptTokens,
  (entry) => entry.cachedPromptTokens
]

// Spreadsheets run cells starting with these as formulas; prefixing keeps receipts inert.
const SPREADSHEET_FORMULA_PREFIX = /^[=+\-@\t\r]/

export function escapeCsvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

function textCell(value: string | null | undefined): string {
  const text = value ?? ''
  return escapeCsvField(SPREADSHEET_FORMULA_PREFIX.test(text) ? `'${text}` : text)
}

function numberCell(value: number | undefined): string {
  return isFiniteNumber(value) ? String(Math.round(value * 10_000) / 10_000) : ''
}

function receiptDate(occurredAt: string): string {
  const time = Date.parse(occurredAt)
  return Number.isNaN(time) ? occurredAt : new Date(time).toISOString()
}

function chronologicalTime(entry: OmniRogueUsageEntry): number {
  const time = Date.parse(entry.occurredAt)
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time
}

function sumFinite(entries: readonly OmniRogueUsageEntry[], pick: NumericColumn): number {
  return entries.reduce((total, entry) => {
    const value = pick(entry)
    return isFiniteNumber(value) ? total + value : total
  }, 0)
}

/** RFC 4180 receipt: CRLF records, quoted fields where needed, and a closing total row. */
export function buildOmniRogueUsageCsv(entries: readonly OmniRogueUsageEntry[]): string {
  const rows = [...entries]
    .sort((a, b) => chronologicalTime(a) - chronologicalTime(b))
    .map((entry) => [
      textCell(entry.id),
      textCell(receiptDate(entry.occurredAt)),
      textCell(OMNIROGUE_USAGE_CAPABILITY_LABELS[entry.capability] ?? entry.capability),
      textCell(entry.model ? resolveOmniRogueModelLabel(entry.model) : ''),
      textCell(entry.description),
      ...NUMERIC_COLUMNS.map((pick) => numberCell(pick(entry)))
    ])
  // Totals add up the printed rows (refunds included), unlike the clamped spend summary.
  const totals = NUMERIC_COLUMNS.map((pick) => numberCell(sumFinite(entries, pick)))
  const totalRow = ['Total', '', '', '', '', ...totals]
  const records = [CSV_HEADER.map(escapeCsvField), ...rows, totalRow]
  return `${records.map((record) => record.join(',')).join('\r\n')}\r\n`
}

export function buildOmniRogueUsageCsvFilename(now: Date): string {
  return `omnirogue-usage-receipt-${now.toISOString().slice(0, 10)}.csv`
}
