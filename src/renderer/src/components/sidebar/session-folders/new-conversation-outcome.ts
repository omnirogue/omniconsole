import { useEffect, useState } from 'react'
import {
  consoleWorkflowApi,
  workflowData,
  workflowErrorMessage
} from '@/lib/console-workflow-client'
import type { LaunchAgentInNewTabArgs } from '@/lib/launch-agent-in-new-tab-types'
import type { WorkCard } from '../../../../../shared/console-work-home-contract'
import { HUB_TASK_ID_PATTERN } from '../../../../../shared/omnios-task-binding'
import { isClosedTaskStatus } from '../../../../../shared/task-state'

export type NewConversationOutcomeDraft = {
  outcome: string
  taskId: string
  /** null follows the default: off, so a typed outcome reaches the agent as a plain goal. */
  planMode: boolean | null
}

export const EMPTY_NEW_CONVERSATION_OUTCOME: NewConversationOutcomeDraft = {
  outcome: '',
  taskId: '',
  planMode: null
}

export function newConversationPlansTeam(draft: NewConversationOutcomeDraft): boolean {
  return draft.outcome.trim().length > 0 && (draft.planMode ?? false)
}

/** Launch fields for this draft; empty for today's one-click launch with nothing entered. */
export function newConversationLaunchExtras(
  draft: NewConversationOutcomeDraft,
  now = new Date()
): Pick<LaunchAgentInNewTabArgs, 'outcome' | 'hubTaskId'> {
  const text = draft.outcome.trim()
  return {
    ...(text
      ? {
          outcome: {
            text,
            ...(newConversationPlansTeam(draft) ? { teamPlanConsentedAt: now.toISOString() } : {})
          }
        }
      : {}),
    ...(HUB_TASK_ID_PATTERN.test(draft.taskId) ? { hubTaskId: draft.taskId } : {})
  }
}

export type LaunchTaskChoice = { id: string; title: string }
const LAUNCH_TASK_CHOICE_LIMIT = 40

/** Open top-level cards a new conversation can serve; the same cut the task attach pickers use. */
export function launchTaskChoices(cards: readonly WorkCard[]): LaunchTaskChoice[] {
  return cards
    .filter(
      (card) =>
        HUB_TASK_ID_PATTERN.test(card.id) &&
        !isClosedTaskStatus(card.status) &&
        card.kanban_status !== 'done' &&
        card.kanban_eligible !== false &&
        !card.parent_task_id
    )
    .slice(0, LAUNCH_TASK_CHOICE_LIMIT)
    .map((card) => ({ id: card.id, title: card.title }))
}

/**
 * Reads the work list only while the launch options are open; the one-click path never waits on it.
 * Keyed by account scope, so switching accounts drops the previous scope's cards instead of
 * leaving them selectable.
 */
export function useLaunchTaskChoices(
  enabled: boolean,
  scope: string
): {
  tasks: LaunchTaskChoice[] | null
  error: string
} {
  const [tasks, setTasks] = useState<LaunchTaskChoice[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!enabled) {
      return
    }
    let live = true
    setError('')
    setTasks(null)
    void Promise.resolve()
      .then(() => consoleWorkflowApi().listWork())
      .then((result) => {
        if (live) {
          setTasks(launchTaskChoices(workflowData(result).items))
        }
      })
      .catch((reason: unknown) => {
        if (live) {
          setTasks([])
          setError(workflowErrorMessage(reason))
        }
      })
    return () => {
      live = false
    }
  }, [enabled, scope])
  return { tasks, error }
}
