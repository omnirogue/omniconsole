import type { BuildReviewPipelineSnapshot } from '../../../shared/build-review-pipeline'
import { localReviewWorkspacePath, setReviewEvidenceWorkspace } from './build-review-evidence'
import type { OrcaRuntimeService } from '../omni-runtime'
import { createDesktopCoordinator } from '../orchestration/desktop-coordinator'
import { pushEvent } from './build-review-pipeline-state'
import type { OrchestrationCaller } from './build-review-rpc-call'
import { assertNotCancelled, type ActiveRun } from './build-review-worker-lifecycle'
import {
  bindBuildReviewRun,
  buildReviewWorkspaceKey,
  claimBuildReviewWorkspace,
  type BuildReviewClaimOptions
} from './build-review-workspace-reservation'

/**
 * Bind the pipeline to an orchestration Run. Orchestration mutations resolve
 * their caller through a live terminal pane, so the desktop coordinator owns a
 * hidden shell terminal in the target workspace and speaks as that terminal.
 */
export async function openCoordinator(
  deps: {
    runtime: OrcaRuntimeService
    call: OrchestrationCaller
    /** What an earlier, settled run on this workspace no longer holds (checked, never closed). */
    claimOptions?: (workspaceKey: string) => Promise<BuildReviewClaimOptions>
  },
  pipeline: BuildReviewPipelineSnapshot,
  run: ActiveRun,
  activePipelineFor: (worktreeId: string) => BuildReviewPipelineSnapshot | undefined
): Promise<void> {
  const worktree = await deps.runtime.showManagedTerminalWorkspace(pipeline.worktree)
  pipeline.worktreeId = worktree.id
  if (pipeline.evidenceRequired) {
    setReviewEvidenceWorkspace(run, await localReviewWorkspacePath(deps.runtime, pipeline.worktree))
  }
  const clash = activePipelineFor(worktree.id)
  if (clash && clash.id !== pipeline.id) {
    throw new Error(`Pipeline ${clash.id} is still ${clash.stage} in this workspace.`)
  }
  assertNotCancelled(run)
  const workspaceKey = buildReviewWorkspaceKey(worktree)
  const options = (await deps.claimOptions?.(workspaceKey)) ?? {}
  assertNotCancelled(run)
  claimBuildReviewWorkspace(
    deps.runtime.getOrchestrationDb(),
    workspaceKey,
    worktree.id,
    pipeline.id,
    deps.runtime.getRuntimeId(),
    process.pid,
    options
  )
  run.reservationKey = workspaceKey
  const handle = await createDesktopCoordinator(
    deps.runtime,
    worktree.id,
    'Build + Review coordinator',
    { launchCause: { trigger: 'coordinator-shell', reference: { buildReviewRunId: pipeline.id } } }
  )
  pipeline.coordinatorTerminalHandle = handle
  // Why: a card-bound Run makes every worker dispatch inherit the card (env +
  // prompt), so builder and reviewers work the omnios card, not a local task.
  const created = await deps.call<{ run: { id: string }; projectionTaskId?: string }>(
    'orchestration.runCreate',
    {
      objective: pipeline.objective,
      from: handle,
      ...(pipeline.hubTaskId ? { hubTaskId: pipeline.hubTaskId } : {})
    }
  )
  pipeline.runId = created.run.id
  bindBuildReviewRun(
    deps.runtime.getOrchestrationDb(),
    workspaceKey,
    pipeline.id,
    deps.runtime.getRuntimeId(),
    created.run.id
  )
  if (pipeline.hubTaskId && !created.projectionTaskId) {
    throw new Error(
      'This runtime cannot launch the card projection. Update it before starting bound work.'
    )
  }
  pipeline.projectionTaskId = created.projectionTaskId
  pushEvent(
    pipeline,
    'info',
    'pipeline',
    pipeline.hubTaskId
      ? `Run ${created.run.id} bound to ${handle} and omnios card ${pipeline.hubTaskId}`
      : `Run ${created.run.id} bound to ${handle} (ad hoc: no omnios card)`
  )
}

/** Close the hidden coordinator terminal; true only when its PTY is known to be gone. */
export async function closeCoordinator(
  runtime: OrcaRuntimeService,
  pipeline: BuildReviewPipelineSnapshot
): Promise<boolean> {
  const handle = pipeline.coordinatorTerminalHandle
  if (!handle) {
    return true
  }
  try {
    const closed = await runtime.closeTerminal(handle)
    return closed.ptyKilled === true
  } catch {
    return false
  }
}
