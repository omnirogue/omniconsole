import { translate } from '@/i18n/i18n'
import { waitingForAgentLabel } from '@/components/native-chat/chat-communication-labels'
import type { WorkRow } from '../../../../../shared/backoffice-work-views'

export function personName(id: string, names: ReadonlyMap<string, string>): string {
  return names.get(id) ?? id
}

/** "Needs you", "Waiting for Iris · review" or "Run finishing, then Iris". */
export function describeNextActor(row: WorkRow, names: ReadonlyMap<string, string>): string {
  const action = row.actionLabel ? ` · ${row.actionLabel}` : ''
  // Why: a finished row has no next actor; "Waiting for …" on it would claim work that is over.
  const state = row.state?.toLowerCase()
  if (state === 'resolved' || state === 'done') {
    return translate('backofficeWork.finished', 'Finished') + action
  }
  if (state === 'cancelled') {
    return translate('backofficeWork.cancelled', 'Cancelled') + action
  }
  // Why: a rule that failed waits on nobody and asks nobody; it says that it failed.
  if (row.kind === 'exception' && !row.needsYou) {
    return translate('backofficeWork.failed', 'Failed') + action
  }
  if (row.waitingFor && row.message?.task_id === null) {
    return waitingForAgentLabel(personName(row.message.recipient_employee_id, names)) + action
  }
  switch (row.nextActor.kind) {
    case 'me':
      return translate('backofficeWork.needsYou', 'Needs you') + action
    case 'person':
      return (
        translate('backofficeWork.waitingForPerson', 'Waiting for {{person}}', {
          person: personName(row.nextActor.id, names)
        }) + action
      )
    case 'run':
      if (row.nextActor.thenIds.length === 0) {
        return translate('backofficeWork.runInProgress', 'Run in progress') + action
      }
      return translate('backofficeWork.runThen', 'Run finishing, then {{people}}', {
        people: row.nextActor.thenIds.map((id) => personName(id, names)).join(', ')
      })
  }
}
