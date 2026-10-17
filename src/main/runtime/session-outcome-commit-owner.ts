import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeCommit, SessionOutcomeSet } from '../../shared/session-outcome-types'
import type { OrcaRuntimeService } from './omni-runtime'
import { ensureAttachedSessionOutcomePlanningSource } from './session-outcome-attached-planning-source'
import { sessionOutcomePlanningSource } from './session-outcome-workflow-source'

export async function sessionOutcomeCommitOwner(
  runtime: OrcaRuntimeService,
  base: SessionChain,
  old: SessionChain | undefined,
  input: SessionOutcomeCommit,
  principal: string | null,
  epoch: string
): Promise<SessionOutcomeSet['continuation']> {
  let taskId = old?.outcomeSet?.continuation.taskId
  let nativeSource = old?.outcomeSet?.continuation.nativeSource
  try {
    const source = runtime.resolveTerminalPane(
      base.sourcePaneKey,
      base.sourceWorktreeId ?? base.worktreeId
    )
    const db = runtime.getOrchestrationDb()
    const latest = db.getLatestDispatchForTerminal(source.handle)
    const settledSource =
      latest?.assignee_pane_key === runtime.getTerminalPaneKey(source.handle) &&
      latest?.process_incarnation === runtime.getTerminalProcessIncarnation(source.handle)
        ? latest
        : undefined
    const dispatch = db.getActiveDispatchForTerminal(source.handle) ?? settledSource
    const task = dispatch ? db.getTask(dispatch.task_id) : undefined
    taskId ??= task?.hub_task_id ?? undefined
    const run = task ? db.getRun(task.run_id) : undefined
    // This provenance comes only from this host's stored source execution. Never adopt
    // renderer/AI supplied Run IDs or reinterpret an existing sealed continuation.
    if (!old?.outcomeSet && dispatch && task?.hub_task_id && run?.origin === 'local_bound') {
      nativeSource = {
        runId: run.id,
        projectionTaskId: task.id,
        sourceDispatchId: dispatch.id
      }
    }
  } catch {
    /* Unavailable source is handled by the source observation gate. */
  }
  if (nativeSource && !principal) {
    throw new Error('Sign in before committing a card-linked native continuation.')
  }
  if (!sessionOutcomePlanningSource(runtime, base) && input.expectedAttachedTask) {
    await ensureAttachedSessionOutcomePlanningSource(
      runtime,
      base,
      input.expectedAttachedTask,
      principal
    )
  }
  const planning = sessionOutcomePlanningSource(runtime, base)
  taskId ??= planning?.taskId
  if (
    taskId &&
    input.outcomes.some((outcome) => {
      const ref =
        input.taskRef ?? old?.outcomeSet?.outcomes.find((prior) => prior.id === outcome.id)?.taskRef
      return ref && ref.taskId !== taskId
    })
  ) {
    throw new Error(
      'This work is already executing a different card. Detach it before filing here.'
    )
  }
  const owner: SessionOutcomeSet['continuation'] = {
    owner: 'execution-host',
    hostId: 'local',
    epoch,
    state: 'owned',
    ...(principal ? { principal } : {}),
    ...(taskId ? { taskId } : {}),
    // Planning provenance identifies the source; only the observer says it finished.
    ...(old?.outcomeSet?.continuation.planningSource
      ? { planningSource: old.outcomeSet.continuation.planningSource }
      : planning
        ? { planningSource: planning.planningSource }
        : {}),
    ...(nativeSource ? { nativeSource } : {}),
    ...(old?.outcomeSet?.continuation.sourceBinding
      ? { sourceBinding: old.outcomeSet.continuation.sourceBinding }
      : {}),
    ...(old?.outcomeSet?.continuation.initialSource
      ? { initialSource: old.outcomeSet.continuation.initialSource }
      : {}),
    ...(old?.outcomeSet?.continuation.sourcePacket
      ? { sourcePacket: old.outcomeSet.continuation.sourcePacket }
      : {})
  }
  return owner
}
