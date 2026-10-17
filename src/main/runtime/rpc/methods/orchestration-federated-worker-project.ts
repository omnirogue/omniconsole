import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { startFederatedWorker } from './orchestration-federated-worker-start'
import type { WorkerProject } from './orchestration-worker-project'

/**
 * A worker on another computer (`--on`, or the project's Computers list) joins its project as a local one does, but its brief,
 * resolved for that computer, rides ahead of the task text (backend plan §2b): every version of
 * that computer delivers it, and there is no new field for an older one to drop.
 */
export async function startFederatedWorkerInProject(
  args: Parameters<typeof startFederatedWorker>[0] & { project: WorkerProject }
): Promise<unknown> {
  const { project, ...start } = args
  const server = args.runtime.resolveOrchestrationWorkerServer(
    (args.params.on ?? project.on) as string
  )
  const inherited = await project.inheritOn({
    hostId: toRuntimeExecutionHostId(server.environmentId),
    name: server.name
  })
  const spec = inherited.brief ? `${inherited.brief}\n\n${args.task.spec}` : args.task.spec
  const started = await startFederatedWorker({
    ...start,
    // Why: a friendly selector may change while the project documents are being read.
    params: { ...args.params, on: server.environmentId },
    task: { ...args.task, spec }
  })
  return { ...(started as Record<string, unknown>), ...inherited.receipt }
}
