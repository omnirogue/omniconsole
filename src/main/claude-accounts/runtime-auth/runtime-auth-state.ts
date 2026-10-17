import type { Store } from '../../persistence'
import { ClaudeRuntimePathResolver } from '../runtime-paths'
import { claudeSeatDirectories, sameClaudeIdentity } from '../../rate-limits/claude-seat-directory'

export class ClaudeRuntimeAuthState {
  protected readonly pathResolver = new ClaudeRuntimePathResolver()
  protected mutationQueue: Promise<unknown> = Promise.resolve()
  protected lastSyncedAccountId: string | null = null
  // Why: creds OmniConsole last wrote to the shared file; a mismatch on managed→default transition means an external login overwrote it, so adopt it as the new default.
  protected lastWrittenCredentialsJson: string | null = null
  protected hasMaterializedRuntimeAuth = false
  protected hasLastWrittenOauthAccount = false
  protected lastWrittenOauthAccount: unknown = null
  protected skipNextReadBackForAccountId: string | null = null
  protected managedRefreshDeferredByLivePtyAccountId: string | null = null

  protected constructor(protected readonly store: Store) {}

  /**
   * Why: `claudeSeatDirectories()` reads identity off every discovered Claude
   * config dir, including OmniConsole's OWN runtime config dir once we've
   * materialized an account into it. Without excluding that self-write, every
   * sync after the first treats our own just-written runtime credentials as an
   * externally-owned CLI seat and refuses to read back a later refresh for the
   * same account -- a false "seat" that is really just us.
   */
  protected isSameIdentityCliSeat(account: {
    id: string
    email?: string | null
    organizationUuid?: string | null
  }): boolean {
    const ownRuntimeConfigDir =
      this.hasMaterializedRuntimeAuth && this.lastSyncedAccountId === account.id
        ? this.pathResolver.getRuntimePaths().configDir
        : null
    return claudeSeatDirectories().some(
      (seat) => seat.path !== ownRuntimeConfigDir && sameClaudeIdentity(account, seat)
    )
  }
}
