import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { resolveBackofficeBaseUrl } from '../../../../shared/backoffice-connection'
import type { NextStepAgentRecipient } from '../../../../shared/next-step-draft'
import { buildCardLaunch, buildThreadLaunch, nextStepAgentBrief } from './next-step-launch'
import { nextStepSubjectTask, type NextStepSubject } from './next-step-subject'
import { isTaskContinuationAgent, type TaskContinuationModalData } from './task-continuation'
import type { NextStepSendResult } from './next-step-send'

type CardOrThread = Extract<NextStepSubject, { kind: 'card' | 'thread' }>
const refused = (message: string): NextStepSendResult => ({ ok: false, message })
const sent = (message: string): NextStepSendResult => ({ ok: true, message })

/** Continue the same task; a taskless thread opens the workspace composer. */
export function launchNextStepAgent(
  subject: CardOrThread,
  agent: NextStepAgentRecipient,
  operationId: string,
  callbacks?: {
    onStarted?: TaskContinuationModalData['onStarted']
    onCancelled?: () => void
    onLaunched?: (worktreeId: string, tabId: string) => void
  }
): NextStepSendResult {
  const state = useAppStore.getState()
  const task = nextStepSubjectTask(subject)
  if (task) {
    if (!window.api?.consoleLocalExecution?.continueTask || !isTaskContinuationAgent(agent.agent)) {
      return refused(
        translate(
          'nextStep.continuationUnavailable',
          'Task continuation is unavailable for this agent in this version of OmniConsole.'
        )
      )
    }
    const continuation: TaskContinuationModalData = {
      operationId,
      ...(callbacks ? { onStarted: callbacks.onStarted, onCancelled: callbacks.onCancelled } : {}),
      taskId: task.id,
      ...(subject.kind === 'thread' ? { threadId: subject.detail.thread.id } : {}),
      title: task.title,
      agent: agent.agent,
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.effort ? { effort: agent.effort } : {}),
      instruction: nextStepAgentBrief(agent)
    }
    state.openModal('task-continuation', continuation)
    return sent(
      translate('nextStep.continuationOpened', 'Choose a work location to continue this task.')
    )
  }
  const connection = resolveBackofficeBaseUrl(state.settings ?? {})
  if (!connection.configured) {
    return refused(connection.message)
  }
  const brief = nextStepAgentBrief(agent)
  const launch =
    subject.kind === 'card'
      ? buildCardLaunch({
          item: subject.item,
          baseUrl: connection.baseUrl,
          settings: state.settings,
          brief
        })
      : buildThreadLaunch({
          detail: subject.detail,
          baseUrl: connection.baseUrl,
          settings: state.settings,
          brief
        })
  if (!launch) {
    return refused(
      translate(
        'nextStep.launchUnavailable',
        'This work cannot be linked to a workspace right now.'
      )
    )
  }
  state.openModal('new-workspace-composer', {
    ...launch,
    ...(callbacks?.onCancelled ? { onCancelled: callbacks.onCancelled } : {}),
    initialAgent: agent.agent,
    launchOptions: {
      preferences: { model: agent.model, effort: agent.effort },
      submitPrompt: true,
      chatBypass: true,
      ...(callbacks?.onLaunched ? { onLaunched: callbacks.onLaunched } : {})
    }
  })
  return sent(
    translate('nextStep.composerOpened', 'Choose the folder; the instruction is filled in.')
  )
}
