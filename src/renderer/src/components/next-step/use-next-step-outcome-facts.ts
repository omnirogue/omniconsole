import { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { BackofficeTodoItem } from '../../../../shared/backoffice-work-types'
import type { NextStepOutcomeFacts } from './next-step-outcome-facts'
import { summarizeAssistantMessage } from './next-step-outcome-facts'
import type { NextStepSubject } from './next-step-subject'
import { useNextStepTask } from './use-next-step-task'

/** Reads the session facts Details shows; every selector returns a stored value, never a fresh object. */
export function useNextStepOutcomeFacts(
  subject: Extract<NextStepSubject, { kind: 'session' }>,
  linkedCard: BackofficeTodoItem | null
): NextStepOutcomeFacts & { linked: { id: string; title: string } | null } {
  const { session } = subject
  const workspace = useAppStore((state) => state.getKnownWorktreeById(session.worktreeId))
  const status = useAppStore((state) =>
    session.paneKey ? state.agentStatusByPaneKey[session.paneKey] : undefined
  )
  const repoId = workspace?.repoId ?? null
  const repoName = useAppStore((state) =>
    repoId ? (state.repos.find((repo) => repo.id === repoId)?.displayName ?? null) : null
  )
  const context = useNextStepTask(subject)
  const { linked, deliverables } = context
  const taskId = linked?.id ?? linkedCard?.task_id ?? null
  const taskTitle = linked?.title ?? linkedCard?.title ?? null
  const model = status?.model ?? null
  const lastAnswer = status?.lastCompletedAssistantMessage ?? status?.lastAssistantMessage ?? null
  const workspacePath = workspace?.path ?? null
  const branch = workspace?.branch ?? null
  return useMemo(
    () => ({
      session,
      workspacePath,
      branch,
      repoId,
      repoName,
      model,
      summary: summarizeAssistantMessage(lastAnswer),
      task: taskId ? { id: taskId, title: taskTitle ?? taskId } : null,
      defaultDeliverables: deliverables,
      linked
    }),
    [
      session,
      workspacePath,
      branch,
      repoId,
      repoName,
      model,
      lastAnswer,
      taskId,
      taskTitle,
      deliverables,
      linked
    ]
  )
}
