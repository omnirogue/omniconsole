import { hasNextOutcomeDiscovery } from '../../shared/next-outcome-intent-instructions'
import { isNextStepChatIntent } from '../../shared/next-step-chat-intent'
import {
  sessionOutcomeTaskRefSchema,
  type SessionOutcomeCommit
} from '../../shared/session-outcome-types'

/** What a commit may carry given who is making it; returns the input with its filing validated. */
export function admitSessionOutcomeCommit(
  input: SessionOutcomeCommit,
  authorityInstruction?: string,
  refreshAuthority?: () => string | undefined
): SessionOutcomeCommit {
  if (input.source !== 'user') {
    if (
      input.taskRef ||
      input.outcomes.some((outcome) =>
        outcome.conditions.some((condition) => condition.verification)
      )
    ) {
      throw new Error('Task filing and executable verification require source user.')
    }
    // refreshAuthority is only ever supplied by the real RPC/dispatch path, which derives
    // authorityInstruction from sessionOutcomeMutationAuthority — an already-authenticated
    // hook capture or dispatch task, i.e. an attested full-source commit and therefore a
    // pursuit request by definition (design doc §4(p)). Its own source-authority and
    // prompt-change checks below still gate it; this scan only catches an unattested caller
    // (no refreshAuthority) manufacturing a pursuit from an ordinary, non-discovery prompt.
    if (
      !refreshAuthority &&
      (!authorityInstruction ||
        (!hasNextOutcomeDiscovery(authorityInstruction) &&
          !isNextStepChatIntent(authorityInstruction)))
    ) {
      throw new Error('no pursuit was requested')
    }
  }
  return input.taskRef
    ? { ...input, taskRef: sessionOutcomeTaskRefSchema.parse(input.taskRef) }
    : input
}
