import { BOARD_TASK_ID_PATTERN } from './board-task-id'

export const OMNIOS_WORK_URL = 'https://console.example.com'
// Keep runtime admission aligned with the signed-in omnios BFF card routes.
export const HUB_TASK_ID_PATTERN = BOARD_TASK_ID_PATTERN

export function buildHubTaskEnvironment(
  hubTaskId?: string | null
): Record<string, string> | undefined {
  return hubTaskId ? { OMNI_TASK_ID: hubTaskId, OMNIOS_URL: OMNIOS_WORK_URL } : undefined
}

export function prependHubTaskPrompt(prompt: string, hubTaskId?: string | null): string {
  if (!hubTaskId) {
    return prompt
  }
  const instruction = `You are working omnios card ${hubTaskId}. Start with whoami, then get_task ${hubTaskId} and read resume, the shared task context/memory, and its lifecycle actions. One parent task may contain many sessions; creating or retrying a session never creates another parent card. Maintain the Kanban status of this outcome through the shared task tools: Backlog is uncommitted; Ready is actionable; In Progress means you or another actor is actively pursuing it; Waiting requires an external blocker and a recorded wake/follow-up; Review requires a completed candidate awaiting verification; Done requires its acceptance criteria and completion evidence. Use transition_task with the observed expected_revision: start when work begins, wait only when the whole outcome cannot progress, resume when the blocker is resolved, and submit_for_review with candidate evidence. Canonical tasks use the lifecycle actions returned by get_task. Failed attempts, paused sessions and handoffs do not independently change the outcome; preserve active sibling work. Leave add_task_note progress notes and a final_report; notes and session exit never complete the task. Use complete_task and the existing proof/verification flow only when the actual outcome is satisfied, then read back its status.`
  return prompt === instruction || prompt.startsWith(`${instruction}\n`)
    ? prompt
    : `${instruction}\n${prompt}`
}
