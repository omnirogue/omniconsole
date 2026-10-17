import { isAbsolute, resolve } from 'node:path'
import { splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'
import type { OrchestrationDb } from '../orchestration/db'
import { captureCandidateArtifacts, type CandidateArtifacts } from './workflow-working-artifacts'
import { getWorkingAgentCallForDispatch } from './workflow-working-agent-calls'
import { workingAgentCallNeedsArtifacts } from './workflow-working-agent-artifact-policy'

/** Derive one child's path from the owned Dispatch resource, never from model-supplied JSON. */
export function getWorkingAgentDispatchArtifactSource(
  db: OrchestrationDb,
  dispatchId: string
): { path: string; sourceBase: string } | undefined {
  const call = getWorkingAgentCallForDispatch(db, dispatchId)
  if (!call || !workingAgentCallNeedsArtifacts(call.call_id)) {
    return undefined
  }
  const resource = db.getWorkerTerminalResourceByOwner(dispatchId)
  const childId = resource?.worktree_id
  const parent = splitWorktreeIdForFilesystem(call.workspace_id)
  const child = childId ? splitWorktreeIdForFilesystem(childId) : null
  if (
    !resource ||
    resource.origin_dispatch_id !== dispatchId ||
    !['owned', 'released'].includes(resource.ownership_state) ||
    !childId ||
    !parent ||
    !child ||
    !parent.repoId ||
    child.repoId !== parent.repoId ||
    !isAbsolute(parent.worktreePath) ||
    !isAbsolute(child.worktreePath) ||
    resolve(parent.worktreePath) === resolve(child.worktreePath) ||
    (call.child_worktree_id && call.child_worktree_id !== childId)
  ) {
    throw new Error('Writable Dispatch child worktree identity is missing or changed')
  }
  if (resource.ownership_state === 'released' && call.state !== 'accepted') {
    throw new Error('Writable Dispatch was released before result acceptance')
  }
  const pinned = db.db
    .prepare(`UPDATE local_workflow_worker_calls SET child_worktree_id=?
      WHERE task_id=? AND (child_worktree_id IS NULL OR child_worktree_id=?)`)
    .run(childId, call.task_id, childId)
  if (pinned.changes !== 1) {
    throw new Error('Writable Dispatch child worktree pin changed')
  }
  return { path: child.worktreePath, sourceBase: call.source_base }
}

/** Capture before result acceptance and again after worker_done/release to detect later edits. */
export async function captureWorkingAgentDispatchArtifacts(
  db: OrchestrationDb,
  dispatchId: string
): Promise<CandidateArtifacts | undefined> {
  const source = getWorkingAgentDispatchArtifactSource(db, dispatchId)
  return source ? captureCandidateArtifacts(source.path, source.sourceBase) : undefined
}
