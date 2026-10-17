import type { SessionRunRowState } from '@/lib/session-run-row-state'
import type { PursuitSidebarTreeRow } from '@/lib/session-sidebar-tree-rows'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { SessionChain } from '../../../../../shared/session-chain-types'
import { SessionSidebarRowDetails } from './SessionSidebarRowDetails'
import { SessionSidebarRowStatusLine } from './SessionSidebarRowStatusLine'
import type { SessionRowDetailNotes, SessionRowStatus } from './session-row-status'

/**
 * What a one-line row keeps for its hover card: the status line the row no longer shows, then
 * the same details block the chevron opens inline — the full reason, the plan notation with its
 * seats, the queue, the lock. The same components print both, so the card and the list agree.
 */
export function SessionSidebarRowHoverDetails({
  session,
  status,
  notes,
  activity,
  pursuitChain,
  run,
  seats,
  onOpenSeat,
  hasDetails
}: {
  session: SidebarSession
  status: SessionRowStatus | null
  notes: SessionRowDetailNotes
  /** The step or the current activity, when the row has one. */
  activity: string | null
  pursuitChain: SessionChain | null
  run: SessionRunRowState | null
  seats?: readonly PursuitSidebarTreeRow[]
  onOpenSeat?: (row: PursuitSidebarTreeRow) => void
  hasDetails: boolean
}): React.JSX.Element | null {
  if (!status && !activity && !hasDetails) {
    return null
  }
  return (
    <>
      {status ? <SessionSidebarRowStatusLine status={status} wrap /> : null}
      {activity || hasDetails ? (
        <SessionSidebarRowDetails
          placement="card"
          session={session}
          notes={notes}
          activity={activity}
          pursuitChain={pursuitChain}
          run={run}
          seats={seats}
          onOpenSeat={onOpenSeat}
        />
      ) : null}
    </>
  )
}
