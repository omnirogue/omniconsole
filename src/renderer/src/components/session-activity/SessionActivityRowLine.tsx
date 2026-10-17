import type { SessionChainRowInfo } from '@/lib/session-chain-support'
import { showsSessionActivityOnRow } from './session-activity'
import { useSessionActivity } from './use-session-activity'

/**
 * One line on a session list row: the plan step it is on, else what it is doing now. It is
 * a single truncating line in the row's existing text column, so a narrow sidebar clips the
 * text instead of wrapping or growing the row. Silent when nothing is known — see
 * `showsSessionActivityOnRow`.
 */
export function SessionActivityRowLine({
  paneKey,
  launchedBy
}: {
  paneKey: string | null
  /** From the row's existing `useLaunchedSessionPlan` call; no second subscription. */
  launchedBy?: SessionChainRowInfo | null
}): React.JSX.Element | null {
  const activity = useSessionActivity({ paneKey, launchedBy })
  if (!showsSessionActivityOnRow(activity)) {
    return null
  }
  return (
    <span
      className="block truncate text-xs font-normal text-muted-foreground"
      data-session-activity-row={activity.signal}
      title={activity.line}
    >
      {activity.line}
    </span>
  )
}
