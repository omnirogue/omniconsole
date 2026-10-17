import { isLiveSessionChain, type SessionChain } from '../../../shared/session-chain-types'
import type { ConversationState } from './conversation-state'
import type { SessionSidebarTreeRow } from './session-sidebar-group-model'
import type { PursuitSidebarTreeRow } from './session-sidebar-tree-rows'

/** A seat reads its own attempt: a stopped one failed or is being handled, and asks only by request. */
export function seatState(
  state: NonNullable<SessionChain['outcomeSet']>['attempts'][number]['state'] | undefined,
  asking: boolean
): ConversationState {
  if (asking) {
    return 'needs-you'
  }
  switch (state) {
    case 'running':
    case 'launching':
      return 'running'
    case 'blocked':
      return 'failed'
    case 'unverifiable':
    case 'retryable':
      return 'recovering'
    case 'completed':
    case 'superseded':
      return 'done'
    case 'prepared':
    case undefined:
      return 'queued'
  }
}

/** A plan's seats: the worker tabs of its dispatched attempts, on its host and workspace. */
export function planSeatRows<T extends SessionSidebarTreeRow>(
  rows: readonly T[],
  parent: T,
  chain: SessionChain
): T[] {
  const tabs = new Set(
    (chain.outcomeSet?.attempts ?? []).flatMap((attempt) =>
      attempt.dispatchId && attempt.taskId ? [`worker-${attempt.taskId}`] : []
    )
  )
  return rows.filter(
    (row) =>
      row !== parent &&
      row.session.hostId === parent.session.hostId &&
      row.session.worktreeId === chain.worktreeId &&
      row.session.tabId !== null &&
      tabs.has(row.session.tabId)
  )
}

/** A live plan lists its seats under its own row (Seats and plan history); returns the seats' row keys. */
export function nestLivePlanSeats<T extends PursuitSidebarTreeRow>(
  rows: readonly T[],
  chainByRowKey: ReadonlyMap<string, SessionChain> | undefined
): Set<string> {
  const children = new Set<string>()
  for (const parent of rows) {
    const chain = chainByRowKey?.get(parent.session.rowKey)
    if (!chain?.outcomeSet || !isLiveSessionChain(chain)) {
      continue
    }
    const seats = planSeatRows(rows, parent, chain)
    if (!seats.length) {
      continue
    }
    const asking = new Set(
      (parent.run?.requests ?? []).flatMap((request) => request.scope.attemptId ?? [])
    )
    parent.children = seats.map((seat) => {
      const attempt = chain.outcomeSet!.attempts.findLast(
        (entry) => entry.dispatchId && `worker-${entry.taskId}` === seat.session.tabId
      )
      return { ...seat, pursuitState: seatState(attempt?.state, asking.has(attempt?.id ?? '')) }
    })
    parent.childrenCollapsed = true
    for (const seat of seats) {
      children.add(seat.session.rowKey)
    }
  }
  return children
}
