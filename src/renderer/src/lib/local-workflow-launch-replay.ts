import { useAppStore } from '@/store'
import type { LocalWorkflowLaunch } from '../../../shared/local-workflow-launch'
import type { TerminalTab } from '../../../shared/terminal-tab-types'

type Started = { conversationId: string; executionId: string }
const pending = new Map<string, { request: string; work: Promise<Started> }>()

export function workflowLaunchAnchor(
  worktreeId: string,
  launch: LocalWorkflowLaunch | undefined
): TerminalTab | undefined {
  if (!launch) {
    return undefined
  }
  const id = `workflow-${launch.operationId}`
  const tab = Object.values(useAppStore.getState().tabsByWorktree ?? {})
    .flat()
    .find((entry) => entry.id === id)
  if (
    tab &&
    (tab.worktreeId !== worktreeId || tab.localWorkflow?.launch?.request !== launch.request)
  ) {
    throw new Error('This workflow operation ID already belongs to another request.')
  }
  return tab
}

/** Concurrent delivery joins the same admission; the durable anchor covers renderer restarts. */
export function replayWorkflowLaunch(
  worktreeId: string,
  launch: LocalWorkflowLaunch | undefined,
  start: () => Promise<Started>
): Promise<Started> {
  if (!launch) {
    return start()
  }
  const key = JSON.stringify([worktreeId, launch.operationId])
  const existing = pending.get(key)
  if (existing) {
    return existing.request === launch.request
      ? existing.work
      : Promise.reject(new Error('This workflow operation ID already belongs to another request.'))
  }
  const work = start().finally(() => pending.delete(key))
  pending.set(key, { request: launch.request, work })
  return work
}
