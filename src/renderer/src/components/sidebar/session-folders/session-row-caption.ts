import { translate } from '@/i18n/i18n'
import { conversationAge, type ConversationCompletion } from '@/lib/conversation-retention'

function finishedAgo(at: number): string {
  const age = conversationAge(Date.now() - at)
  switch (age.unit) {
    case 'minute':
      return translate('conversations.finishedMinutesAgo', 'Finished {{count}} min ago', {
        count: age.count
      })
    case 'hour':
      return translate('conversations.finishedHoursAgo', 'Finished {{count}} h ago', {
        count: age.count
      })
    case 'day':
      return translate('conversations.finishedDaysAgo', 'Finished {{count}} d ago', {
        count: age.count
      })
  }
}

/**
 * One line under a finished row: who owns it now, or how long ago it ended. A row put
 * away by hand before it finished says only that it was archived.
 */
export function sessionRowCaption(
  completed: ConversationCompletion | null,
  archived: boolean
): string | null {
  if (!completed) {
    return archived ? translate('conversations.archivedByYou', 'Archived') : null
  }
  const body =
    completed.reason === 'handed'
      ? translate('conversations.handedTo', 'Handed to {{name}} · they own it now', {
          name: completed.handedTo ?? ''
        })
      : completed.reason === 'done'
        ? translate('conversations.planFinished', 'Plan finished · complete')
        : finishedAgo(completed.at)
  return archived ? translate('conversations.archivedRow', 'Archived · {{body}}', { body }) : body
}
