/**
 * Why a session host did not act. Refusals travel as result values, never as RPC errors: relay
 * JSON-RPC rebuilds errors with the transport's numeric code, so a string code would not survive.
 */

export const SESSION_HOST_REFUSAL_CODES = [
  /** The capability was not negotiated with this peer; nothing was sent or run. */
  'unsupported-capability',
  /** A capability name this build does not know. */
  'unknown-capability',
  /** The negotiation predates a reconnect or a host process restart; probe again. */
  'renegotiate',
  'invalid-request',
  /** No authenticated origin evidence (pane, person surface, unattended context). */
  'provenance-required',
  'unknown-conversation',
  /** A pre-Phase-4 session this host has not adopted with verified ownership. */
  'not-adopted',
  /** Another host owns the conversation, or this one relinquished it. */
  'not-owner',
  'stale-owner-epoch',
  /** The host reads no turn for it, so nothing turn-fenced can be reserved. */
  'turn-unknown',
  'stale-turn',
  /** Another operation holds this turn (two Macs, two ids, one turn: one wins). */
  'turn-reserved',
  'stale-organization-revision',
  /** The operation id was already used with a different request. */
  'operation-conflict',
  'reservation-invalid',
  /** The host restarted and is reconciling its journal; admission reopens after. */
  'reconciling',
  'ownership-conflict',
  'storage-unavailable',
  /** A person's input reached the conversation first; pending automation was dropped unsent. */
  'person-input',
  /** Keep going, a chain, an outcome runner or a held delivery already drives it. */
  'has-driver',
  'hard-stop',
  'unattended-restricted',
  'automation-disabled',
  'relocation-disabled',
  'not-eligible',
  'grant-invalid',
  /** Client-side only: the host could not be asked. Pairs with verdict `unverifiable`. */
  'host-unreachable'
] as const
export type SessionHostRefusalCode = (typeof SESSION_HOST_REFUSAL_CODES)[number]

/** The live values a stale request was refused against, so the caller can re-observe. */
export type SessionHostRefusalCurrent = {
  hostId?: string
  ownerEpoch?: number
  turnRevision?: string | null
  organizationRevision?: string
  operationId?: string
}

export type SessionHostRefusal = {
  code: SessionHostRefusalCode
  /** Plain words, including that nothing was changed; clients render this. */
  message: string
  capability?: string
  current?: SessionHostRefusalCurrent
}

/** As a client reads it: a newer host's code stays a string. Render `message`; never switch on it. */
export type SessionHostReceivedRefusal = Omit<SessionHostRefusal, 'code'> & { code: string }

const KNOWN_CODES = new Set<string>(SESSION_HOST_REFUSAL_CODES)

export function isSessionHostRefusalCode(value: unknown): value is SessionHostRefusalCode {
  return typeof value === 'string' && KNOWN_CODES.has(value)
}

/**
 * - `repeat-same-operation`: the answer was lost or must be re-asked; resend the identical request
 *   (or query `sessionHost.operation`). The host never delivers one operation id twice.
 * - `new-operation-after-observe`: observe again and send a new operation id with fresh values.
 * - `never`: a person has to change something first.
 */
export type SessionHostRetryRule = 'repeat-same-operation' | 'new-operation-after-observe' | 'never'

const REPEAT = new Set<string>(['host-unreachable', 'renegotiate'])
const REOBSERVE = new Set<string>([
  'stale-owner-epoch',
  'stale-turn',
  'turn-reserved',
  'stale-organization-revision',
  'reconciling',
  'storage-unavailable'
])

/** Unknown codes from a newer host are `never`: retrying what is not understood is guessing. */
export function sessionHostRetryRule(code: string): SessionHostRetryRule {
  if (REPEAT.has(code)) {
    return 'repeat-same-operation'
  }
  return REOBSERVE.has(code) ? 'new-operation-after-observe' : 'never'
}

export function sessionHostRefusal(
  code: SessionHostRefusalCode,
  message: string,
  extra: Pick<SessionHostRefusal, 'capability' | 'current'> = {}
): SessionHostRefusal {
  return { code, message, ...extra }
}

/** A paired runtime answers `method_not_found`; a relay answers JSON-RPC -32601. */
export function isSessionHostMethodMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'method_not_found' || code === -32601
}

/** An older host without the method: explicit, never a local or raw-terminal fallback. */
export function sessionHostMissingMethodRefusal(
  method: string,
  capability: string
): SessionHostRefusal {
  return sessionHostRefusal(
    'unsupported-capability',
    `That computer's OmniConsole does not have ${method}, so it cannot carry this out. Update it and try again. Nothing was sent.`,
    { capability }
  )
}
