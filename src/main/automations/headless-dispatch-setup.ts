import {
  AutomationLaunchUnverifiableError,
  type AutomationLaunchTerminalBinding
} from '../../shared/automation-launch-outcome'
import { isSessionAttemptApprovalStartupBlocker } from '../../shared/session-attempt-recovery'
import type { CreateWorktreeResult } from '../../shared/worktree/create-types'

/** Preserve the created workspace when its startup worker may already exist. */
export function assertHeadlessAutomationWorktreeStartup(
  created: Pick<CreateWorktreeResult, 'startupTerminalOutcome' | 'warning'>,
  terminal: AutomationLaunchTerminalBinding
): void {
  if (created.startupTerminalOutcome === 'unverifiable') {
    throw new AutomationLaunchUnverifiableError(
      new Error(created.warning || 'Automation workspace startup could not be verified.'),
      terminal
    )
  }
}

/** The person answers a live worker's supported question in its existing conversation. */
export function assertHeadlessAutomationWaitSettled(
  terminal: AutomationLaunchTerminalBinding,
  wait: { satisfied: boolean; blockedReason?: string }
): void {
  if (!wait.satisfied && isSessionAttemptApprovalStartupBlocker(wait.blockedReason)) {
    throw new AutomationLaunchUnverifiableError(
      new Error(
        'The routine agent is waiting for input in its conversation. Open it to continue this run.'
      ),
      terminal
    )
  }
}

/** Preserve the launched worker if later display/output setup cannot finish. */
export async function prepareHeadlessAutomationLaunch<TResult>(
  terminal: AutomationLaunchTerminalBinding,
  prepare: () => TResult | Promise<TResult>
): Promise<TResult> {
  try {
    return await prepare()
  } catch (error) {
    throw new AutomationLaunchUnverifiableError(error, terminal)
  }
}
