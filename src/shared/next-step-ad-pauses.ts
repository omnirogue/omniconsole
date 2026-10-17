/**
 * Ad pauses (Sal, 2026-09-26): "Pausing an ad, ad set or campaign is allowed by default when the
 * evidence supports it." The person can switch every session, or one session, to ask first.
 * Spend changes (budgets, bids, turning delivery on) always need the person.
 */

export type NextStepAdPauses = 'allowed' | 'ask-first'
export const NEXT_STEP_AD_PAUSES = ['allowed', 'ask-first'] as const

export function normalizeAdPauses(raw: unknown): NextStepAdPauses | null {
  return raw === 'allowed' || raw === 'ask-first' ? raw : null
}

/** The session's own choice wins over the global one; absent everywhere = allowed. */
export function resolveAdPauses(
  global: NextStepAdPauses | undefined,
  session: NextStepAdPauses | undefined
): NextStepAdPauses {
  return session ?? global ?? 'allowed'
}
