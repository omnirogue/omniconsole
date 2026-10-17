/**
 * docs/reference/ssh-execution-boundary.md: exactly `live` / `unverifiable` / `exited`, no
 * synonyms. Only the owning host's own observation can say `live` or `exited`; a lost reply,
 * refusal, missing row or unreadable value is `unverifiable`, never `exited`.
 */

import type { SessionExecutionVerdict } from './session-manage-types'

export type { SessionExecutionVerdict }

export const SESSION_HOST_EXECUTION_VERDICTS = [
  'live',
  'unverifiable',
  'exited'
] as const satisfies readonly SessionExecutionVerdict[]

type Unlisted = Exclude<SessionExecutionVerdict, (typeof SESSION_HOST_EXECUTION_VERDICTS)[number]>
// Why a compile-time check: a fourth verdict added upstream must fail here, not drift silently.
export const SESSION_HOST_VERDICTS_COMPLETE: [Unlisted] extends [never] ? true : never = true

const VERDICTS = new Set<string>(SESSION_HOST_EXECUTION_VERDICTS)

export function isSessionExecutionVerdict(value: unknown): value is SessionExecutionVerdict {
  return typeof value === 'string' && VERDICTS.has(value)
}

type ObserveReplyShape = {
  status: string
  sessions?: readonly { conversationId: string; verdict: unknown }[]
}

/** A client's verdict for one conversation from whatever `sessionHost.observe` gave it (or not). */
export function sessionHostVerdictOf(
  reply: ObserveReplyShape | null | undefined,
  conversationId: string
): SessionExecutionVerdict {
  if (reply?.status !== 'ok') {
    return 'unverifiable'
  }
  const verdict = reply.sessions?.find((row) => row.conversationId === conversationId)?.verdict
  return isSessionExecutionVerdict(verdict) ? verdict : 'unverifiable'
}
