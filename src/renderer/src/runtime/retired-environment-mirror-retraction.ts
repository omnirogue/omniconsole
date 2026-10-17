/**
 * The saved-environment list's synchronous hook into the session mirror.
 *
 * Why a registry rather than an import: the runtime-status slice cannot import the session-tabs
 * receiver (it imports the store), and a lazy import would let retraction land after the mirror
 * restarted a subscription and recorded its tracking generation. The receiver registers itself
 * when it loads, and the slice calls this in the same turn the environment leaves the list.
 */
type RetireEnvironmentMirrors = (environmentIds: readonly string[]) => void

let retireEnvironmentMirrors: RetireEnvironmentMirrors | null = null

export function registerRetiredEnvironmentMirrorRetraction(retire: RetireEnvironmentMirrors): void {
  retireEnvironmentMirrors = retire
}

/** Retracts rows mirrored from environments removed from the saved list (never re-pairs). */
export function retractRemovedEnvironmentMirrors(environmentIds: readonly string[]): void {
  if (environmentIds.length > 0) {
    retireEnvironmentMirrors?.(environmentIds)
  }
}
