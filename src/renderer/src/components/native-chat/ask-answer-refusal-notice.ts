import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AskAnswerRefusal } from './native-chat-runtime-send'

/** Tell the person why a one-click answer was not (fully) sent, so a refusal is never silent. */
export function showAskAnswerRefusalNotice(refusal: AskAnswerRefusal): void {
  toast.message(
    refusal === 'partial'
      ? // Why: the selector is part-way through; a retry would type from the wrong step.
        translate(
          'components.native-chat.question.partlySent',
          'Answer partly sent. Finish it in the terminal.'
        )
      : refusal === 'not-delivered'
        ? translate(
            'components.native-chat.question.notDelivered',
            'The terminal didn’t take the answer. Nothing was sent; open the session to answer it.'
          )
        : translate(
            'components.native-chat.question.notOnScreen',
            'Can’t see this question in the terminal. Answer it there.'
          )
  )
}
