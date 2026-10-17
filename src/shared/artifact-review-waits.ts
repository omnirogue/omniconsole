/**
 * Work → "Waiting for a decision": every pending review page asking the signed-in person (OmniOS
 * inbox) and every page this computer's sessions wait on, with where that session is now.
 */

export type ReviewWaitSession = {
  /** The publishing session's wait (artifact-review-sleep.ts), or what its computer reported. */
  state: string
  /** Which computer holds it; null when unknown. */
  host: string | null
  /** Only for another computer: its heartbeat is recent. */
  hostOnline?: boolean | null
  at: string | null
  /** One of OmniOS's fixed words; `detail` is this computer's own full reason. */
  reason?: string | null
  detail?: string | null
  /** Another computer may wake it (Phase 2); null when unknown. */
  portable?: boolean | null
  /** This computer published it, so it can open the session. */
  local: boolean
  ledgerId?: string
  paneKey?: string
  nativeSessionId?: string
}

export type ReviewWaitItem = {
  slug: string
  title: string
  question: string
  /** The page's own short version, as OmniOS lists it; null when it has none. */
  summary?: string | null
  shareUrl: string
  /** pending, approved, changes_requested, rejected; '' when only this computer knows the page. */
  status: string
  revision: number
  updatedAt: string | null
  publishedBy: { name: string; email: string; isYou: boolean } | null
  session: ReviewWaitSession | null
}

export type ReviewWaitsResult =
  | { status: 'ok'; items: ReviewWaitItem[]; inbox: 'ok' | 'unavailable' | 'signed-out' }
  | { status: 'signed-out' }

export const REVIEW_WAIT_OLD_MS = 7 * 24 * 60 * 60_000

// States in which the session still runs, or will, on the computer that reported it.
const ON_HOST = new Set(['waiting', 'asleep', 'waking', 'awake'])

/** As OmniOS's `hostAway`: another computer stopped checking in while its session waits there. */
export function reviewWaitHostAway(session: ReviewWaitSession | null): boolean {
  return Boolean(
    session &&
    !session.local &&
    session.hostOnline === false &&
    session.portable !== true &&
    ON_HOST.has(session.state)
  )
}

/** The chip words, as OmniOS Work → Decisions shows them (CONTRACT.md). */
export function reviewWaitChip(item: Pick<ReviewWaitItem, 'status' | 'session'>): string | null {
  const session = item.session
  if (!session) {
    return null
  }
  const on = session.host ? ` on ${session.host}` : ''
  const reason = session.reason?.trim()
  switch (session.state) {
    case 'waiting':
      return `Waiting${on}`
    case 'asleep':
      if (reason?.startsWith('capacity')) {
        return item.status === 'approved'
          ? 'Approved · waiting for account capacity'
          : 'Waiting for account capacity'
      }
      return `Asleep${on}`
    case 'waking':
      return 'Waking'
    case 'awake':
      return `Awake${on}`
    case 'moved':
      return `Moved${session.host ? ` to ${session.host}` : ''}`
    case 'deleted':
      return item.status === 'rejected' ? 'Rejected · deleted' : 'Session deleted'
    case 'stalled':
      return reason ? `Stalled: ${reason}` : 'Stalled'
    default:
      return session.state
  }
}
