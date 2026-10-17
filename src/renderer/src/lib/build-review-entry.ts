import { useAppStore } from '@/store'
import { getAgentDetectionTargetKeyForWorktree } from '@/hooks/useAgentDetectionTarget'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session'
import type { BuildReviewPipelineSnapshot } from '../../../shared/build-review-pipeline'
import {
  createLocalWorkflowConversation,
  titleLocalWorkflowConversation,
  updateLocalWorkflowConversation
} from './local-workflow-conversation'
import { activateAndRevealWorkspace } from './worktree-activation'

/**
 * Whether a workspace can hold a Build + Review conversation tab. Local and SSH workspaces can:
 * the coordinator runs on this machine either way, and an SSH host only runs the workers. A
 * runtime environment, a web runtime session or a host that has not resolved yet cannot.
 */
export function canHoldBuildReviewTab(worktreeId: string): boolean {
  const state = useAppStore.getState()
  if (isWebRuntimeSessionActive(state.settings?.activeRuntimeEnvironmentId)) {
    return false
  }
  const target = getAgentDetectionTargetKeyForWorktree(state, worktreeId)
  return target === 'local' || Boolean(target?.startsWith('ssh:'))
}

/** Shows the workspace first, so a tab opened from another workspace's menu is in view. */
function revealWorkspace(worktreeId: string): boolean {
  if (useAppStore.getState().activeWorktreeId === worktreeId) {
    return true
  }
  return activateAndRevealWorkspace(worktreeId, { providesInitialSurface: true }) !== false
}

/**
 * The one way to open Build + Review: a conversation tab in the workspace when it can hold one,
 * otherwise the start dialog, which asks for a workspace. Nothing runs until Start.
 * Returns the new tab, or null when the dialog opened instead.
 */
export function openBuildReview(
  worktreeId?: string | null,
  options: { prompt?: string } = {}
): string | null {
  if (worktreeId && canHoldBuildReviewTab(worktreeId) && revealWorkspace(worktreeId)) {
    try {
      const tabId = createLocalWorkflowConversation(worktreeId, 'build-review')
      if (options.prompt) {
        updateLocalWorkflowConversation(worktreeId, tabId, { prompt: options.prompt })
      }
      return tabId
    } catch {
      // Why: the host changed under us; the dialog still lets the person pick a workspace.
    }
  }
  useAppStore.getState().buildReview.openStartDialog(worktreeId ?? undefined, options.prompt)
  return null
}

/**
 * Gives a run started from the dialog its own conversation tab in the workspace it runs in.
 * Returns the tab, or null when that workspace cannot hold one and the run page shows it instead.
 */
export function anchorBuildReviewRun(
  worktreeId: string | undefined,
  pipeline: BuildReviewPipelineSnapshot
): string | null {
  if (worktreeId && canHoldBuildReviewTab(worktreeId) && revealWorkspace(worktreeId)) {
    try {
      const tabId = createLocalWorkflowConversation(worktreeId, 'build-review')
      updateLocalWorkflowConversation(worktreeId, tabId, {
        buildReviewPipelineId: pipeline.id,
        prompt: pipeline.objective
      })
      titleLocalWorkflowConversation(tabId, pipeline.objective)
      return tabId
    } catch {
      // Why: the run has already started; a Start that reported failure here would invite a
      // second run, so the page, which lists every run, shows this one instead.
    }
  }
  const state = useAppStore.getState()
  state.buildReview.select(pipeline.id)
  state.openBuildReviewPage()
  return null
}
