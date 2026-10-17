import { installSessionOutcomeTaskContinuation } from '../runtime/session-outcome-task-continuation'
import { installSessionOutcomeWorkflowPort } from '../runtime/session-outcome-workflow-port'
import { sessionOutcomeWorkflowAdapter } from './session-outcome-workflow-adapter'
import { continueConsoleTask } from './console-task-continuation'

export function installSessionOutcomeTaskAdapter(): void {
  installSessionOutcomeTaskContinuation(continueConsoleTask)
  installSessionOutcomeWorkflowPort(sessionOutcomeWorkflowAdapter)
}
