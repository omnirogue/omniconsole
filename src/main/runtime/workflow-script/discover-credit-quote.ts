import type {
  DiscoverCreditBudgetGuard,
  DiscoverCreditMode,
  DiscoverCreditQuote,
  OmniRogueCreditBalance
} from '../../../shared/omnirogue-account'
import {
  DISCOVER_DEFAULT_MAX_AGENTS,
  DISCOVER_LENS_IDS,
  DISCOVER_MAX_AGENTS_CEILING,
  DISCOVER_MIN_AGENTS,
  estimateDiscoverAgents
} from '../../../shared/local-workflow-draft'
import type { OmniRogueAccountLease } from '../../omnirogue-account/omnirogue-account-lease'
import {
  discoverCreditQuoteRequestSchema,
  type DiscoverCreditQuoteResult
} from '../../../shared/discover-credit-quote-ipc'

export type { DiscoverCreditBudgetGuard, DiscoverCreditMode, DiscoverCreditQuote }

export type DiscoverCreditQuoteOptions = {
  /** Unified wallet credits per call, supplied by the caller's current model pricing. */
  creditsPerAgent: number
  /** Worst-case credits per call, including the selected models' token limits. */
  maxCreditsPerAgent: number
  maxAgents?: number
  lensCount?: number
  /** Graph runs use their actual planned call ceiling, including verification and repeats. */
  agentCalls?: number
  /** Quick's reader may use a different model from the standard/deep lineup. */
  quickMaxCreditsPerAgent?: number
  checkBalance?: boolean
  account?: Pick<OmniRogueAccountLease, 'status' | 'requireToken'>
  fetch?: typeof globalThis.fetch
}

function validCredits(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  )
}

function requireCredits(value: number, name: string): number {
  if (!validCredits(value)) {
    throw new RangeError(`${name} must be finite, non-negative credits within the safe range`)
  }
  return value
}

function requireInteger(value: number, low: number, high: number, name: string): number {
  if (!Number.isInteger(value) || value < low || value > high) {
    throw new RangeError(`${name} must be an integer from ${low} to ${high}`)
  }
  return value
}

function wholeCredits(calls: number, rate: number): number {
  return requireCredits(Math.ceil(calls * rate), 'Calculated credits')
}

/** Advisory only: launch admission must recheck the wallet and reserve atomically. */
export async function quoteDiscoverRunCredits(
  mode: DiscoverCreditMode,
  options: DiscoverCreditQuoteOptions
): Promise<DiscoverCreditQuote> {
  if (mode !== 'quick' && mode !== 'standard' && mode !== 'deep') {
    throw new RangeError('Unknown Discover mode')
  }
  const rate = requireCredits(options.creditsPerAgent, 'creditsPerAgent')
  const maxRate = requireCredits(options.maxCreditsPerAgent, 'maxCreditsPerAgent')
  if (maxRate < rate) {
    throw new RangeError('maxCreditsPerAgent must cover creditsPerAgent')
  }
  const lensCount = requireInteger(
    options.lensCount ?? DISCOVER_LENS_IDS.length,
    1,
    DISCOVER_LENS_IDS.length,
    'lensCount'
  )
  const maxAgents = requireInteger(
    options.maxAgents ??
      (mode === 'quick'
        ? 2
        : mode === 'deep'
          ? DISCOVER_MAX_AGENTS_CEILING
          : DISCOVER_DEFAULT_MAX_AGENTS),
    mode === 'quick' ? 2 : DISCOVER_MIN_AGENTS,
    DISCOVER_MAX_AGENTS_CEILING,
    'maxAgents'
  )
  // Quick Discover has a reader and a report; standard/deep use the revision 7 planner.
  const graphCalls =
    options.agentCalls === undefined
      ? undefined
      : requireInteger(options.agentCalls, 1, Number.MAX_SAFE_INTEGER, 'agentCalls')
  const agentCalls =
    graphCalls !== undefined
      ? { low: graphCalls, high: graphCalls }
      : mode === 'quick'
        ? { low: 2, high: 2 }
        : estimateDiscoverAgents(lensCount, mode === 'deep' ? 'exhaustive' : 'thorough', maxAgents)
  const quickRate = requireCredits(
    options.quickMaxCreditsPerAgent ?? maxRate,
    'quickMaxCreditsPerAgent'
  )
  const quote: DiscoverCreditQuote = {
    mode,
    estimatedCredits: wholeCredits(agentCalls.high, rate),
    maxReservationCredits: wholeCredits(agentCalls.high, maxRate),
    quickMaxReservationCredits: wholeCredits(2, mode === 'quick' ? maxRate : quickRate),
    agentCalls: { low: agentCalls.low, high: agentCalls.high },
    balance: null,
    balanceStatus: 'not-requested'
  }
  if (options.checkBalance) {
    await readWalletBalance(quote, options)
  }
  return quote
}

/** Desktop quote adapter; prices must come from the current pricing provider. */
export async function quoteDiscoverCredits(request: unknown): Promise<DiscoverCreditQuoteResult> {
  const { mode, pricing, ...bounds } = discoverCreditQuoteRequestSchema.parse(request)
  if (!pricing) {
    return { quote: null, guard: await unpricedDiscoverGuard() }
  }
  const quote = await quoteDiscoverRunCredits(mode, { ...pricing, ...bounds, checkBalance: true })
  return { quote, guard: checkDiscoverCreditBudgetGuard(quote, quote.balance) }
}

/**
 * No pricing provider supplies rates yet, so there is no estimate to gate on (the gateway still
 * charges per call); a launch still needs a linked account with spendable credits.
 */
export async function unpricedDiscoverGuard(
  options: Pick<DiscoverCreditQuoteOptions, 'account' | 'fetch'> = {}
): Promise<DiscoverCreditBudgetGuard> {
  const wallet: Pick<DiscoverCreditQuote, 'balance' | 'balanceStatus'> = {
    balance: null,
    balanceStatus: 'not-requested'
  }
  await readWalletBalance(wallet, options)
  const available = wallet.balance?.availableCredits
  if (wallet.balanceStatus === 'connect-account' || !validCredits(available)) {
    return {
      allowed: false,
      shortfallCredits: 0,
      warningMessage:
        wallet.balanceStatus === 'connect-account'
          ? 'Connect OmniRogue to check your spendable credits before launching Discover.'
          : 'Unable to verify spendable credits. Reconnect OmniRogue and try again.',
      recommendedAction: 'connect-account'
    }
  }
  if (available <= 0) {
    return {
      allowed: false,
      shortfallCredits: 0,
      warningMessage: 'Your OmniRogue wallet has no spendable credits. Top up credits to continue.',
      recommendedAction: 'top-up'
    }
  }
  return {
    allowed: true,
    shortfallCredits: 0,
    warningMessage: `Discover credit pricing is unavailable, so this run has no estimate; it spends from your ${available.toLocaleString('en-US', { maximumFractionDigits: 6 })} spendable credits.`,
    recommendedAction: 'proceed'
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function walletBalance(value: unknown): OmniRogueCreditBalance | null {
  const envelope = record(value)
  if (!envelope || envelope.ok === false || envelope.success === false || envelope.error) {
    return null
  }
  const data = record(envelope.data) ?? envelope
  const wallet = record(data.wallet) ?? data
  const availableCredits = wallet.spendableCredits ?? wallet.availableCredits
  if (!validCredits(availableCredits)) {
    return null
  }
  // Spendable/available already excludes holds; subtracting reserved again double-counts them.
  return {
    availableCredits,
    ...(validCredits(wallet.reservedCredits) ? { reservedCredits: wallet.reservedCredits } : {}),
    updatedAt: new Date().toISOString()
  }
}

async function readWalletBalance(
  quote: Pick<DiscoverCreditQuote, 'balance' | 'balanceStatus'>,
  options: Pick<DiscoverCreditQuoteOptions, 'account' | 'fetch'>
): Promise<void> {
  quote.balanceStatus = 'unavailable'
  try {
    const account =
      options.account ??
      (
        await import('../../omnirogue-account/omnirogue-account-lease')
      ).getSharedOmniRogueAccountLease()
    const status = await account.status()
    if (status.state !== 'linked') {
      quote.balanceStatus = 'connect-account'
      return
    }
    if (!status.apiOrigin) {
      return
    }
    const origin = new URL(status.apiOrigin)
    if (origin.protocol !== 'https:' || origin.username || origin.password) {
      return
    }
    const token = await account.requireToken()
    if (!token) {
      quote.balanceStatus = 'connect-account'
      return
    }
    const response = await (options.fetch ?? globalThis.fetch)(
      new URL('/api/omniconsole/wallet', origin.origin),
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(8_000)
      }
    )
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      quote.balanceStatus = response.status === 401 ? 'connect-account' : 'unavailable'
      return
    }
    quote.balance = walletBalance(await response.json())
    quote.balanceStatus = quote.balance ? 'available' : 'unavailable'
  } catch {
    // Keep the local estimate; never turn a transport/auth failure into a zero-cost approval.
  }
}

export function checkDiscoverCreditBudgetGuard(
  quote: DiscoverCreditQuote,
  balance: OmniRogueCreditBalance | number | null | undefined
): DiscoverCreditBudgetGuard {
  const available = typeof balance === 'number' ? balance : balance?.availableCredits
  const blocked: DiscoverCreditBudgetGuard = {
    allowed: false,
    shortfallCredits: 0,
    warningMessage: 'Connect OmniRogue to check your spendable credits before launching Discover.',
    recommendedAction: 'connect-account'
  }
  if (quote.balanceStatus === 'connect-account') {
    return blocked
  }
  if (
    !validCredits(quote.maxReservationCredits) ||
    !validCredits(quote.estimatedCredits) ||
    quote.estimatedCredits > quote.maxReservationCredits
  ) {
    return { ...blocked, warningMessage: 'Refresh the Discover credit estimate before launching.' }
  }
  if (!validCredits(available)) {
    return quote.balanceStatus === 'unavailable'
      ? {
          ...blocked,
          warningMessage: 'Unable to verify spendable credits. Reconnect OmniRogue and try again.'
        }
      : blocked
  }
  const shortfallCredits = Math.max(0, quote.maxReservationCredits - available)
  if (shortfallCredits === 0) {
    return {
      allowed: true,
      shortfallCredits: 0,
      warningMessage: null,
      recommendedAction: 'proceed'
    }
  }
  const quickFits =
    quote.mode !== 'quick' &&
    validCredits(quote.quickMaxReservationCredits) &&
    available >= quote.quickMaxReservationCredits &&
    quote.quickMaxReservationCredits < quote.maxReservationCredits
  return {
    allowed: false,
    shortfallCredits,
    warningMessage: `Discover needs ${shortfallCredits.toLocaleString('en-US', { maximumFractionDigits: 6 })} more credits for its maximum reservation. ${quickFits ? 'Switch to Quick or top up credits.' : 'Top up credits to continue.'}`,
    recommendedAction: quickFits ? 'switch-to-quick' : 'top-up'
  }
}
