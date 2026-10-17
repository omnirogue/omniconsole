export const SSH_SESSION_EXPIRED_ERROR = 'SSH_SESSION_EXPIRED'
export const SSH_PTY_IDENTITY_MISMATCH_ERROR = 'SSH_PTY_IDENTITY_MISMATCH'

export function isSshPtyNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /PTY ".+" not found/i.test(message)
}

export function isSshPtyIdentityMismatchError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes(SSH_PTY_IDENTITY_MISMATCH_ERROR) || /identity mismatch/i.test(message)
}

// Only the owning relay's explicit exit evidence permits retiring a saved binding.
export class SshPtyAbsentFromRelayError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SshPtyAbsentFromRelayError'
  }
}

export function isSshPtyAbsentFromRelayError(error: unknown): boolean {
  return error instanceof SshPtyAbsentFromRelayError
}
