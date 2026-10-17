export const SSH_PTY_EXIT_CONFIRMED_CODE = -32047
export const SSH_SESSION_UNVERIFIABLE_ERROR = 'SSH_SESSION_UNVERIFIABLE'

export function confirmedSshPtyExitError(id: string): Error {
  return Object.assign(new Error(`PTY "${id}" not found`), {
    code: SSH_PTY_EXIT_CONFIRMED_CODE
  })
}

export function isConfirmedSshPtyExitError(error: unknown, id: string): boolean {
  return (
    error instanceof Error &&
    (error as Error & { code?: unknown }).code === SSH_PTY_EXIT_CONFIRMED_CODE &&
    error.message === `PTY "${id}" not found`
  )
}
