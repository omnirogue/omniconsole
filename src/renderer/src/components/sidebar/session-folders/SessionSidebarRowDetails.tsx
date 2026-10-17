import { Clock3 } from 'lucide-react'
import { FinishedSessionDispositionRetry } from '@/components/next-action/FinishedSessionDispositionRetry'
import {
  failedSessionDisposition,
  retryFinishedSessionDisposition
} from '@/components/next-action/finished-session-disposition'
import { PlanRowAction } from '@/components/session-team/PlanRowAction'
import type { SessionRunRowState } from '@/lib/session-run-row-state'
import type { PursuitSidebarTreeRow } from '@/lib/session-sidebar-tree-rows'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { SessionChain } from '../../../../../shared/session-chain-types'
import { SessionRowRunRequests } from './SessionRowRunRequests'
import { SessionRowHistory } from './SessionRowHistory'
import type { SessionRowDetailNotes } from './session-row-status'
import { cn } from '@/lib/utils'

/**
 * Everything a collapsed row keeps out of the list: what the run asks and the way to meet it,
 * the full diagnostic of a failure, the plan notation with View Plan / Publish and its seats and
 * history, a close or save that did not happen, the queue, the notes about an unreachable
 * computer or a missing session key, the lock the plan holds, and what was done to it (History).
 */
export function SessionSidebarRowDetails({
  id,
  session,
  notes,
  activity,
  pursuitChain,
  run = null,
  seats,
  onOpenSeat,
  placement = 'inline'
}: {
  /** The chevron's aria-controls target; absent inside the hover card. */
  id?: string
  session: SidebarSession
  notes: SessionRowDetailNotes
  /** The step or activity line, when a status pushed it off the row. */
  activity: string | null
  pursuitChain: SessionChain | null
  /** The plan as the row already read it, so the details never disagree with the row. */
  run?: SessionRunRowState | null
  seats?: readonly PursuitSidebarTreeRow[]
  onOpenSeat?: (row: PursuitSidebarTreeRow) => void
  /** Under the row in the list (indented, on a rule) or inside the row's hover card (flush). */
  placement?: 'inline' | 'card'
}): React.JSX.Element {
  const failedDisposition = failedSessionDisposition(pursuitChain)
  return (
    <div
      id={id}
      className={cn(
        'space-y-1 text-xs text-muted-foreground',
        placement === 'inline' && 'ml-8 mr-2 border-l pb-2 pl-3'
      )}
      data-session-row-details={placement}
    >
      {activity ? (
        <p className="whitespace-normal" data-session-activity-row="">
          {activity}
        </p>
      ) : null}
      {pursuitChain && run ? (
        <SessionRowRunRequests
          requests={run.requests}
          session={session}
          chainId={pursuitChain.id}
        />
      ) : null}
      {notes.reason ? (
        <p className="whitespace-normal text-destructive" data-session-failure="">
          {notes.reason}
        </p>
      ) : null}
      {pursuitChain ? (
        <PlanRowAction chain={pursuitChain} run={run} seats={seats} onOpenSeat={onOpenSeat} />
      ) : null}
      {/* Why after the plan: the run reads Completed; its session's close or save is a footnote. */}
      {pursuitChain && failedDisposition ? (
        <FinishedSessionDispositionRetry
          scope="row"
          disposition={failedDisposition}
          onRetry={() => retryFinishedSessionDisposition(pursuitChain)}
        />
      ) : null}
      {notes.queue ? (
        <p className="flex items-center gap-1">
          <Clock3 className="size-3 shrink-0" />
          {notes.queue}
        </p>
      ) : null}
      {notes.unavailable ? <p>{notes.unavailable}</p> : null}
      {notes.folderAssignment ? (
        <p className="whitespace-normal">{notes.folderAssignment}</p>
      ) : null}
      {notes.lock.map((line) => (
        <p key={line} className="truncate" data-session-locked="">
          {line}
        </p>
      ))}
      {/* Why inline only: the hover card is transient; History and its Undo need a stable place. */}
      {placement === 'inline' ? <SessionRowHistory session={session} /> : null}
    </div>
  )
}
