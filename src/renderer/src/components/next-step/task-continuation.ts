import { translate } from '@/i18n/i18n'
import { workflowData } from '@/lib/console-workflow-client'
import type {
  ConsoleLocalExecutionView,
  ConsoleTaskContinuationRequest
} from '../../../../shared/console-local-execution'

export type TaskContinuationModalData = Omit<
  ConsoleTaskContinuationRequest,
  'worktree' | 'model'
> & {
  onCancelled?: () => void
  onStarted?: (execution: ConsoleLocalExecutionView) => void
  title: string
  model?: string
}

export function isTaskContinuationAgent(
  agent: string
): agent is ConsoleTaskContinuationRequest['agent'] {
  return agent === 'claude' || agent === 'codex' || agent === 'grok'
}

/** Admission and execution belong to the local controller, including for a paired renderer. */
export async function continueTaskExecution(
  request: ConsoleTaskContinuationRequest
): Promise<ConsoleLocalExecutionView> {
  const api = window.api?.consoleLocalExecution
  if (!api?.continueTask) {
    throw new Error(
      translate(
        'nextStep.continuationApiUnavailable',
        'Task continuation is unavailable in this version of OmniConsole.'
      )
    )
  }
  const execution = workflowData(await api.continueTask(request))
  if (execution.state !== 'running') {
    throw new Error(
      execution.error ||
        translate(
          'nextStep.continuationNotRunning',
          'The agent is not confirmed running ({{state}}). Your instructions are kept; retry to check this same request.',
          { state: execution.state }
        )
    )
  }
  return execution
}
