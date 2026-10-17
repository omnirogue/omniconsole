import { useAppStore } from '@/store'
import { canonicalJson } from '../../../shared/decision-contracts/decision-calibration-summary'
import {
  localWorkflowFindSpec,
  type LocalWorkflowFindRequest
} from '../../../shared/local-workflow-find-request'
import { normalizeSavedReviewRubrics } from '../../../shared/review-rubrics'
import { startLocalWorkflowGraphConversation } from './local-workflow-graph-start'

/**
 * `omni find-best`: opens a Find the best conversation in the workspace and starts it the way Start
 * does (see `startLocalWorkflowGraphConversation`).
 */
export async function startLocalWorkflowFindConversation(
  worktreeId: string,
  request: LocalWorkflowFindRequest
): Promise<{ conversationId: string; executionId: string }> {
  const saved = normalizeSavedReviewRubrics(useAppStore.getState().settings?.reviewRubrics)
  return startLocalWorkflowGraphConversation(worktreeId, {
    kind: 'find',
    prompt: request.prompt,
    ...(request.operationId
      ? {
          launch: {
            operationId: request.operationId,
            origin: request.origin ?? 'cli',
            request: canonicalJson(request)
          }
        }
      : {}),
    spec: (routes) => localWorkflowFindSpec(request, routes, saved)
  })
}
