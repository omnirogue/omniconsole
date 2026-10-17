/**
 * Reads a workflow conversation's run from the controller that owns it: this computer's runtime,
 * which started it (`{kind:'local'}` in local-workflow-graph-start.ts), whatever host runs the
 * workspace. Read-only: nothing is recovered, resumed, cancelled or deleted. Registered through
 * session-manage-workflow-runtime.ts by the module that already holds the controller.
 */

import { evolveChangedEvent } from '../../shared/evolve-workflow-status'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import {
  buildReviewRunState,
  isWorkflowRunNotFound,
  localWorkflowRunState,
  type SessionWorkflowAnchorRef
} from '../../shared/session-workflow-anchor'
import { getBuildReviewService } from '../runtime/build-review/build-review-service-registry'
import { getEvolveService } from '../runtime/evolve/evolve-service-registry'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { getLocalWorkflowHost } from '../runtime/workflow-script/local-workflow-runtime-host'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import type { SessionWorkflowRunReader, SessionWorkflowRunReading } from './session-manage-workflow'

/** A wedged controller must not hold a whole list or tidy; a late reading is no reading. */
export const SESSION_WORKFLOW_READ_TIMEOUT_MS = 3_000

async function readRun(
  runtime: OrcaRuntimeService,
  row: SessionManageSidebarRow,
  ref: SessionWorkflowAnchorRef
): Promise<SessionWorkflowRunReading> {
  const preset = row.workflow?.preset
  if (preset === 'build-review') {
    return { status: buildReviewRunState(getBuildReviewService(runtime).show(ref.runId)) }
  }
  if (!row.tabId) {
    return { status: 'unavailable', reason: 'its tab is not known' }
  }
  if (preset === 'evolve') {
    const event = evolveChangedEvent({
      ...getEvolveService(runtime).show(ref.runId),
      conversationId: row.tabId
    })
    return event ? { status: localWorkflowRunState(event.state) } : { status: 'unavailable' }
  }
  const host = await getLocalWorkflowHost(runtime)
  const status = await host.status({
    worktree: `id:${row.worktreeId}`,
    conversationId: row.tabId,
    executionId: ref.runId
  })
  return { status: localWorkflowRunState(status.state) }
}

export function readRuntimeWorkflowRun(runtime: OrcaRuntimeService): SessionWorkflowRunReader {
  return (row, ref) =>
    withTimeout(
      readRun(runtime, row, ref).catch((error: unknown): SessionWorkflowRunReading =>
        isWorkflowRunNotFound(error)
          ? { status: 'missing' }
          : {
              status: 'unavailable',
              reason: error instanceof Error ? error.message : String(error)
            }
      ),
      SESSION_WORKFLOW_READ_TIMEOUT_MS,
      { status: 'unavailable', reason: 'its controller did not answer in time' }
    )
}
