import { startLocalWorkflowFindConversation } from '@/lib/local-workflow-find-start'
import { startLocalWorkflowRunConversation } from '@/lib/local-workflow-graph-start'
import { isLocalWorkflowRunRequest } from '../../../../shared/local-workflow-run-request'

/** `omni find-best` and `omni workflow run`: the app opens and starts the conversation, then tells the CLI. */
export function registerLocalWorkflowFindIpcBridge(unsubs: (() => void)[]): void {
  const api = window.api.localWorkflow
  // Why optional: partial preload doubles in tests and older preloads have no find channel.
  if (!api?.onFindRequest) {
    return
  }
  unsubs.push(
    api.onFindRequest(({ requestId, worktreeId, request }) => {
      const started = isLocalWorkflowRunRequest(request)
        ? startLocalWorkflowRunConversation(worktreeId, request)
        : startLocalWorkflowFindConversation(worktreeId, request)
      void started.then(
        (run) => api.replyFind({ requestId, ...run }),
        (error: unknown) =>
          api.replyFind({
            requestId,
            error: error instanceof Error ? error.message : String(error)
          })
      )
    })
  )
}
