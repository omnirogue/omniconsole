import { dispatchSessionUpNext } from '../next-action/advanced/dispatch-session-up-next'
import type { NextStepDraft } from '../../../../shared/next-step-draft'
import type { NextStepSubject } from './next-step-subject'
import type { NextStepSendResult } from './next-step-send-result'

export async function sendAfterSession(
  subject: Extract<NextStepSubject, { kind: 'session' }>,
  input: NextStepDraft
): Promise<NextStepSendResult> {
  return dispatchSessionUpNext(subject.session, input)
}
