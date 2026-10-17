import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { ShownAsyncQuestion } from '../../../../shared/codex-async-question-dismissal'
import type { AskQuestion } from '../../../../shared/native-chat-ask-types'

type AsyncQuestionDismissalResult = 'dismissed' | 'unavailable' | 'unconfirmed'

/** Only the question text and its occurrence identify what was shown. */
export function shownAsyncQuestions(questions: readonly AskQuestion[]): ShownAsyncQuestion[] {
  return questions.map(({ question, askedAt }) =>
    askedAt === undefined ? { question } : { question, askedAt }
  )
}

/** Only the questions' owner can confirm dismissal; older or remote hosts may refuse it. */
export async function dismissAsyncQuestions(
  paneKey: string,
  questions: readonly AskQuestion[]
): Promise<AsyncQuestionDismissalResult> {
  if (questions.length === 0) {
    return 'dismissed'
  }
  const dismiss = window.api?.agentStatus?.dismissAsyncQuestions
  if (!dismiss) {
    return 'unavailable'
  }
  try {
    const dismissed = await dismiss({
      paneKey,
      questions: shownAsyncQuestions(questions)
    })
    return dismissed === true ? 'dismissed' : 'unavailable'
  } catch (err: unknown) {
    console.warn('[agent-question] async question dismissal failed:', err)
    return 'unconfirmed'
  }
}

export function showAsyncQuestionDismissalRefusalNotice(
  result: Exclude<AsyncQuestionDismissalResult, 'dismissed'>
): void {
  toast.message(
    result === 'unavailable'
      ? translate(
          'components.native-chat.question.dismissalUnavailable',
          'This host cannot dismiss these questions. They remain available to answer here.'
        )
      : translate(
          'components.native-chat.question.dismissalUnconfirmed',
          'Could not confirm dismissal on the questions’ host. They remain available here.'
        )
  )
}
