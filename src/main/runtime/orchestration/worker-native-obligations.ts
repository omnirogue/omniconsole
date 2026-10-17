import type { OrcaRuntimeService } from '../omni-runtime'
import type { OrchestrationDb } from './db'
import type { WorkerTerminalResourceRow } from './worker-terminal-ownership'
import { orchestrationTimestampToMs } from '../rpc/methods/orchestration-worker-output'

/** Native provider children have no Task rows; their exact parent's hook owns their liveness and
 *  its open questions or approval prompts. */
export function workerHasNativeObligations(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  resource: WorkerTerminalResourceRow
): boolean {
  const worker = db.getWorkerDispatch(resource.owner_dispatch_id)
  const session =
    worker &&
    runtime.getExactWorkerProviderSession(
      resource.terminal_handle,
      orchestrationTimestampToMs(worker.created_at)
    )
  if (
    !session ||
    session.paneKey !== resource.pane_key ||
    session.processIncarnation !== resource.process_incarnation
  ) {
    return true
  }
  const hook = runtime.getLastAgentHookRowForPane(session.paneKey)
  if (
    hook?.providerSession &&
    (hook.providerSession.key !== session.providerSession.key ||
      hook.providerSession.id !== session.providerSession.id)
  ) {
    return true
  }
  // A worker showing a question or an approval prompt is still waiting on a person; closing it
  // would discard that unanswered native obligation along with the answer path.
  return Boolean(
    hook?.interactivePrompt ||
    hook?.state === 'waiting' ||
    hook?.state === 'blocked' ||
    hook?.workingMode === 'monitoring' ||
    hook?.subagents?.some((child) => child.state !== 'idle') ||
    (hook?.backgroundTaskCount ?? 0) > 0
  )
}
