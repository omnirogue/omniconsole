import { translate } from '@/i18n/i18n'
import type { BackofficeTodoItem } from '../../../../shared/backoffice-work-types'
import { isThreadRecipient, type NextStepSubject } from './next-step-subject'

/** What every ＋ ⏳ ✓ action answers with, and the two checks the answers share. */
export type NextStepActionResult =
  | { ok: true; message: string }
  | { ok: false; message: string; evidenceItem?: BackofficeTodoItem }

export const newOperationId = (): string => `ns_${crypto.randomUUID().replace(/-/g, '')}`

export function revisionOf(item: BackofficeTodoItem): number | null {
  return Number.isSafeInteger(item.state_revision) && (item.state_revision ?? -1) >= 0
    ? (item.state_revision as number)
    : null
}

/** Why ✓ is not offered here, or null when it is. */
export function doneRefusal(
  subject: NextStepSubject,
  // Why: kept for callers; a session finishes with or without its card.
  _linkedCard: BackofficeTodoItem | null
): string | null {
  switch (subject.kind) {
    case 'session':
      // Why: finishing a session's work needs no card; with one, the card is completed too.
      return subject.session.paneKey && subject.session.tabId
        ? null
        : translate('nextStep.waitNoPane', 'Open this session in its workspace first.')
    case 'card':
      if (subject.item.status?.toLowerCase() === 'done') {
        return translate('auto.components.TaskPage.backofficeCompleted', 'Completed')
      }
      return revisionOf(subject.item) === null
        ? translate('nextStep.waitNoRevision', 'This card cannot be changed from here yet.')
        : null
    case 'thread':
      if (subject.detail.thread.state === 'resolved') {
        return translate('handoffs.completed', 'Completed')
      }
      return isThreadRecipient(subject)
        ? null
        : translate('nextStep.threadNotMine', 'Only the person this was sent to can act on it.')
  }
}
