import { parseExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import type { SessionTabsInventoryCoverage } from '../../shared/session-tabs-absence-evidence'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'

/**
 * Owner-side scope of the session-tabs process census (session-count fix step 6, C4).
 *
 * Why scoped: the census restores runtime-owned terminals per execution host, so a host it could
 * not ask leaves only that host's workspaces incomplete. One offline SSH host used to strip
 * authority from the whole inventory, which kept confirmed local closes from ever retracting.
 */

/** Known execution hosts (paired runtimes excluded) this census did not query. */
export function listUnqueriedCensusHostIds(
  knownHostIds: Iterable<ExecutionHostId>,
  queriedHostIds: ReadonlySet<ExecutionHostId>
): Set<ExecutionHostId> {
  const unqueried = new Set<ExecutionHostId>()
  for (const hostId of knownHostIds) {
    if (parseExecutionHostId(hostId)?.kind !== 'runtime' && !queriedHostIds.has(hostId)) {
      unqueried.add(hostId)
    }
  }
  return unqueried
}

export function sameCensusHostIds(
  left: ReadonlySet<ExecutionHostId>,
  right: ReadonlySet<ExecutionHostId>
): boolean {
  return left.size === right.size && [...left].every((hostId) => right.has(hostId))
}

/** An unknown host is unverifiable only while some known host went unasked. */
export function isCensusUnverifiedWorkspaceHost(
  unverifiedHostIds: ReadonlySet<ExecutionHostId>,
  workspaceHostId: ExecutionHostId | null
): boolean {
  return (
    unverifiedHostIds.size > 0 &&
    (workspaceHostId === null || unverifiedHostIds.has(workspaceHostId))
  )
}

/**
 * The unverified scope an inventory carries: repos are listed by id so every worktree of an SSH
 * repo stays covered even when this runtime never saw that worktree; other workspace keys
 * (folder workspaces, unknown hosts) are listed exactly.
 */
export function buildSessionTabsInventoryCoverage(args: {
  unverifiedHostIds: ReadonlySet<ExecutionHostId>
  repos: readonly { id: string; hostId: ExecutionHostId }[]
  workspaceKeys: Iterable<string>
  resolveWorkspaceHostId: (workspaceKey: string) => ExecutionHostId | null
}): SessionTabsInventoryCoverage {
  const unverifiedRepoIds = args.repos
    .filter((repo) => args.unverifiedHostIds.has(repo.hostId))
    .map((repo) => repo.id)
  const unverifiedRepoIdSet = new Set(unverifiedRepoIds)
  const unverifiedWorkspaces = new Set<string>()
  for (const workspaceKey of args.workspaceKeys) {
    if (
      !unverifiedRepoIdSet.has(getRepoIdFromWorktreeId(workspaceKey)) &&
      isCensusUnverifiedWorkspaceHost(
        args.unverifiedHostIds,
        args.resolveWorkspaceHostId(workspaceKey)
      )
    ) {
      unverifiedWorkspaces.add(workspaceKey)
    }
  }
  return {
    unverifiedRepoIds: [...unverifiedRepoIdSet].sort(),
    unverifiedWorkspaces: [...unverifiedWorkspaces].sort()
  }
}

/** How long a workspace must stay census-verified before receivers are sent a re-minted frame. */
export const SESSION_TABS_CENSUS_VERIFIED_HOLD_MS = 5_000

/**
 * Re-mints a workspace only once its verdict has stayed "verified" for the hold. Going unverified
 * needs no re-mint (every later frame carries the marker) and cancels a pending one, so a flapping
 * relay causes no version burst. Correctness never waits on the timer: only the moment receivers
 * may drop rows they were keeping does.
 */
export class SessionTabsCensusRemintScheduler {
  private readonly verifiedSince = new Map<string, number>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly options: {
      holdMs: number
      isStillVerified: (worktreeId: string) => boolean
      remint: (worktreeId: string) => void
      now?: () => number
    }
  ) {}

  noteVerified(worktreeId: string): void {
    if (!this.verifiedSince.has(worktreeId)) {
      this.verifiedSince.set(worktreeId, this.now())
    }
    this.schedule()
  }

  noteUnverified(worktreeId: string): void {
    this.verifiedSince.delete(worktreeId)
    if (this.verifiedSince.size === 0 && this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private schedule(): void {
    if (this.timer || this.verifiedSince.size === 0) {
      return
    }
    const earliest = Math.min(...this.verifiedSince.values())
    const delay = Math.max(0, earliest + this.options.holdMs - this.now())
    this.timer = setTimeout(() => this.flush(), delay)
    // Why: a pending re-mint must never keep a quitting runtime alive.
    this.timer.unref?.()
  }

  private flush(): void {
    this.timer = null
    const now = this.now()
    for (const [worktreeId, since] of this.verifiedSince) {
      if (now - since < this.options.holdMs) {
        continue
      }
      this.verifiedSince.delete(worktreeId)
      if (this.options.isStillVerified(worktreeId)) {
        this.options.remint(worktreeId)
      }
    }
    this.schedule()
  }
}
