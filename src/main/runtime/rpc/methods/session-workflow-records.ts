import { SESSION_TABS_WORKFLOW_RECORDS_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { isDeepStrictEqual } from 'node:util'
import {
  SESSION_WORKFLOW_RECORDS_EVENT,
  type RuntimeSessionWorkflowRecord,
  type RuntimeSessionWorkflowRecordDelta,
  type RuntimeSessionWorkflowRecordSet
} from '../../../../shared/session-workflow-records'
import type { RpcContext } from '../core'
import type { SessionWorkflowRecordStore } from '../../session-workflow-record-store'

/** What the wire reads: the runtime's store, absent on runtimes (and doubles) without one. */
export type SessionWorkflowRecordSource = Pick<SessionWorkflowRecordStore, 'snapshot' | 'onChange'>

type WorkflowContext = Pick<RpcContext, 'runtime' | 'clientCapabilities'>

/** Why optional: runtime doubles (and runtimes built without a window) have no store. */
export function sessionWorkflowRecordSourceOf(
  runtime: unknown
): SessionWorkflowRecordSource | null {
  const read = (runtime as { getSessionWorkflowRecordStore?: () => SessionWorkflowRecordSource })
    ?.getSessionWorkflowRecordStore
  return typeof read === 'function' ? read.call(runtime) : null
}

/** The store, only for a client that negotiated workflow records; everyone else gets null. */
function negotiatedSource(context: WorkflowContext): SessionWorkflowRecordSource | null {
  return context.clientCapabilities?.includes(SESSION_TABS_WORKFLOW_RECORDS_RUNTIME_CAPABILITY) ===
    true
    ? sessionWorkflowRecordSourceOf(context.runtime)
    : null
}

/**
 * A full inventory with the controller's whole workflow set beside it, for a negotiated client.
 * A client that did not ask keeps exactly today's projection (Rule 3).
 */
export function projectInventoryWorkflowRecords<T extends object>(
  inventory: T,
  context: WorkflowContext
): T {
  const source = negotiatedSource(context)
  return source ? { ...inventory, workflowRecords: source.snapshot() } : inventory
}

/** Each workspace whose list differs between two sets, with its new whole list (`[]` if none). */
function changedWorkspaces(
  before: RuntimeSessionWorkflowRecordSet,
  after: RuntimeSessionWorkflowRecordSet
): Record<string, RuntimeSessionWorkflowRecord[]> {
  const changed: Record<string, RuntimeSessionWorkflowRecord[]> = {}
  const names = new Set([
    ...Object.keys(before.recordsByWorktree),
    ...Object.keys(after.recordsByWorktree)
  ])
  for (const worktreeId of names) {
    const next = after.recordsByWorktree[worktreeId] ?? []
    if (!isDeepStrictEqual(before.recordsByWorktree[worktreeId] ?? [], next)) {
      changed[worktreeId] = next
    }
  }
  return changed
}

/**
 * `session.tabs.subscribeAll`'s emit for a negotiated client: the initial inventory carries the
 * whole workflow set, and every later change is one `workflowRecords` event ordered by revision.
 * Between two complete sets the event is a delta (only the workspaces that changed, against the
 * revision this stream last delivered), so an archive mark or a status change does not resend
 * every record; any other change (completeness, a new generation) resends the whole set. Watches
 * only once the initial inventory went out and stops at the stream's end or abort. Others get the
 * emit unchanged.
 */
export function withSessionWorkflowRecordStream(
  context: WorkflowContext & Pick<RpcContext, 'signal'>,
  emit: (result: unknown) => void
): (result: unknown) => void {
  const source = negotiatedSource(context)
  if (!source) {
    return emit
  }
  let stopWatching: (() => void) | null = null
  let delivered: RuntimeSessionWorkflowRecordSet | null = null
  let ended = false
  const stop = (): void => {
    ended = true
    stopWatching?.()
    stopWatching = null
  }
  const deliverChange = (): void => {
    const next = source.snapshot()
    const before = delivered
    delivered = next
    if (before && before.generation === next.generation && before.complete && next.complete) {
      emit({
        type: SESSION_WORKFLOW_RECORDS_EVENT,
        generation: next.generation,
        revision: next.revision,
        baseRevision: before.revision,
        complete: true,
        changedByWorktree: changedWorkspaces(before, next)
      } satisfies RuntimeSessionWorkflowRecordDelta & { type: string })
      return
    }
    emit({ type: SESSION_WORKFLOW_RECORDS_EVENT, ...next })
  }
  context.signal?.addEventListener('abort', stop, { once: true })
  return (result: unknown) => {
    const type = (result as { type?: unknown } | null)?.type
    if (type === 'end') {
      stop()
      emit(result)
      return
    }
    if (type !== 'snapshots') {
      emit(result)
      return
    }
    delivered = source.snapshot()
    emit({ ...(result as object), workflowRecords: delivered })
    if (!stopWatching && !ended) {
      stopWatching = source.onChange(deliverChange)
    }
  }
}
