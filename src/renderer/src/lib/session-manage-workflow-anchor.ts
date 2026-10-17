import {
  sameSessionWorkflowAnchor,
  type SessionManageWorkflowAnchor,
  type SessionWorkflowAnchorRef
} from '../../../shared/session-workflow-anchor'
import type { SidebarSession } from './sidebar-sessions'

/**
 * A workflow conversation's run, as management rows carry it (C6): the controller that owns it
 * (this computer's runtime, which started it) and what this window last read. A run not started
 * yet is a draft, or `starting` while its Start is being sent.
 */
export function sessionManageWorkflowAnchor(
  session: Pick<SidebarSession, 'workflow' | 'mirroredWorkflow'>
): SessionManageWorkflowAnchor | undefined {
  const workflow = session.workflow
  // Why: a paired controller's workflow is that computer's to manage, never this one's (step 9).
  if (!workflow || session.mirroredWorkflow) {
    return undefined
  }
  return {
    controller: 'local',
    preset: workflow.preset,
    runId: workflow.runId ?? null,
    status: workflow.runId
      ? workflow.status === 'draft'
        ? 'unknown'
        : workflow.status
      : workflow.status === 'running'
        ? 'starting'
        : 'draft'
  }
}

/** The pane-less workflow anchor a request names by its controller and run, exactly. */
export function matchManagedWorkflowAnchor(
  sessions: readonly SidebarSession[],
  target: { tabId?: string; workflow: SessionWorkflowAnchorRef }
): SidebarSession | null {
  return (
    sessions.find(
      (entry) =>
        !entry.paneKey &&
        (!target.tabId || entry.tabId === target.tabId) &&
        sameSessionWorkflowAnchor(sessionManageWorkflowAnchor(entry), target.workflow)
    ) ?? null
  )
}
