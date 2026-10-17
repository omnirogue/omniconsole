/**
 * Retryable refusals of `session.tabs.activate` from a non-host caller (a paired computer or a
 * phone). Both keep the row and start nothing; neither is absence proof, which stays
 * `tab_not_found`. Older clients see a coded failure with a readable message and no "closed".
 */

/** The owner cannot verify the tab now: its window is starting, reloading or still publishing. */
export const SESSION_TAB_UNVERIFIABLE_CODE = 'session_tab_unverifiable'
/** The owner's window lists the tab but did not acknowledge mounting that exact surface. */
export const SESSION_TAB_MOUNT_FAILED_CODE = 'session_tab_mount_failed'

export const SESSION_TAB_ACTIVATION_REFUSAL_CODES = [
  SESSION_TAB_UNVERIFIABLE_CODE,
  SESSION_TAB_MOUNT_FAILED_CODE
] as const

export type SessionTabActivationRefusalCode = (typeof SESSION_TAB_ACTIVATION_REFUSAL_CODES)[number]

export type SessionTabActivationRefusalData = {
  retryable: true
  reason: string
}

const REFUSAL_MESSAGES: Record<SessionTabActivationRefusalCode, string> = {
  [SESSION_TAB_UNVERIFIABLE_CODE]:
    'The computer running this session is still loading its sessions (its window is starting or reloading), so it cannot verify this one yet. The session was kept and nothing was started; try again in a moment.',
  [SESSION_TAB_MOUNT_FAILED_CODE]:
    'The computer running this session could not open it in its window. The session was kept and nothing was started in the background; try again.'
}

export function sessionTabActivationRefusalMessage(code: SessionTabActivationRefusalCode): string {
  return REFUSAL_MESSAGES[code]
}

/** True for either refusal, by RPC error code or (through relays that keep only text) message. */
export function isRetryableSessionTabActivationRefusal(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false
  }
  const error = value as { code?: unknown; message?: unknown }
  if (
    typeof error.code === 'string' &&
    (SESSION_TAB_ACTIVATION_REFUSAL_CODES as readonly string[]).includes(error.code)
  ) {
    return true
  }
  const message = typeof error.message === 'string' ? error.message : ''
  return (
    SESSION_TAB_ACTIVATION_REFUSAL_CODES.some((code) => message.includes(code)) ||
    Object.values(REFUSAL_MESSAGES).includes(message)
  )
}
