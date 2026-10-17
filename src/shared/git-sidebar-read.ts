export const GIT_SIDEBAR_READ_TIMEOUT_MS = 5_000

export class GitSidebarReadUnknownError extends Error {
  constructor() {
    super('Git sidebar read is unknown: deadline exceeded')
    this.name = 'GitSidebarReadUnknownError'
  }
}

// Why: one deadline covers the entire read, including admission and sequential Git commands.
export async function withGitSidebarDeadline<T>(
  read: (options: { signal: AbortSignal; timeout: number }) => Promise<T>,
  timeout = GIT_SIDEBAR_READ_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const value = await read({
      signal: controller.signal,
      timeout
    })
    if (controller.signal.aborted) {
      throw new GitSidebarReadUnknownError()
    }
    return value
  } catch (error) {
    if (
      controller.signal.aborted ||
      (error instanceof Error && error.name === 'GitCommandTimeoutError')
    ) {
      throw new GitSidebarReadUnknownError()
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}
