import type { DashboardAgentRow } from './useDashboardData'
import {
  dashboardCardDisplayState,
  type DashboardBucket,
  type DashboardCardDotState
} from '../../../../shared/dashboard-snapshot'
import { dashboardBucketForDotState } from './dashboard-card-bucket'
import { pendingSessionAsk } from '../../../../shared/session-questions'

export type DashboardRowBucketProjection = {
  isTitleDerived: boolean
  dotState: DashboardCardDotState
  workingMode: DashboardAgentRow['entry']['workingMode']
  unseen: boolean
  bucket: DashboardBucket
}

/** Derive the shared dashboard presentation state for one agent row. */
export function dashboardRowBucketProjection(
  row: Pick<DashboardAgentRow, 'paneKey' | 'entry' | 'state' | 'startedAt'>,
  acknowledgedAgentsByPaneKey?: Record<string, number>
): DashboardRowBucketProjection {
  const isTitleDerived = row.startedAt === 0
  // Why: an async question (Codex's) rides the finished turn that asked it; the person is needed.
  const asksAfterTurn =
    (row.state === 'done' || row.state === 'working') &&
    row.entry.interactivePrompt != null &&
    pendingSessionAsk({
      state: row.state,
      workingMode: row.entry.workingMode,
      interactivePrompt: row.entry.interactivePrompt,
      toolName: row.entry.toolName
    })?.delivery === 'async'
  // A failed or interrupted turn is inactive, not completed or asking for a person.
  const dotState: DashboardCardDotState = asksAfterTurn
    ? 'waiting'
    : row.state === 'done' && (row.entry.failed || row.entry.interrupted)
      ? 'idle'
      : row.state
  const workingMode =
    !asksAfterTurn && row.state === 'working' && row.entry.workingMode === 'monitoring'
      ? row.entry.workingMode
      : undefined
  const unseen =
    !isTitleDerived && (acknowledgedAgentsByPaneKey?.[row.paneKey] ?? 0) < row.entry.stateStartedAt
  const bucket = dashboardBucketForDotState(
    dashboardCardDisplayState({ dotState, workingMode, unseen })
  )

  return { isTitleDerived, dotState, workingMode, unseen, bucket }
}
