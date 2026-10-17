import type { LedgerNowResult } from '@/lib/session-ledger-types'
import type { LedgerCollision } from '@/components/sidebar/team-sessions/collision-peers'

export type SessionLedgerState = {
  live: LedgerNowResult | null
  today: LedgerNowResult | null
  refreshing: boolean
  badgeCount: number
  currentEmployeeId: string | null
  teamTabMounted: boolean
  muted: ReadonlySet<string>
  seen: ReadonlySet<string>
  collisions: LedgerCollision[]
  start(): () => void
  setTeamTabMounted(mounted: boolean): void
  refresh(): Promise<void>
  muteRepo(repo: string): Promise<void>
  /** Once per local session, per peer, per server day; attempts share the local ledger id. */
  hasSeenPeerToday(local: string, peer: string, day: string): boolean
  markSeenPeerToday(local: string, peer: string, day: string): void
  /** Drops one local session's notice; another local's record of the same peer stays queued. */
  dismissCollision(local: string, peer: string): void
}
