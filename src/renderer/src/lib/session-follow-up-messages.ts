import { translate } from '@/i18n/i18n'
import { outputFileName } from '../../../shared/session-follow-up-deliverables'
import type {
  SessionFollowUpAction,
  SessionFollowUpException,
  SessionFollowUpRule
} from '../../../shared/session-follow-up-rule'

/** Every sentence a saved follow-up shows, in one place so the rows, receipt and toasts agree. */
export function followUpActionLabel(
  action: SessionFollowUpAction | null | undefined
): string | null {
  switch (action) {
    case undefined:
    case null:
      return null
    case 'approve':
      return translate('sessionFollowUp.actionApprove', 'Approve')
    case 'decide':
      return translate('sessionFollowUp.actionDecide', 'Decide')
    case 'edit':
      return translate('sessionFollowUp.actionEdit', 'Edit')
    case 'fyi':
      return translate('sessionFollowUp.actionFyi', 'For information')
    case 'review':
      return translate('sessionFollowUp.actionReview', 'Review')
  }
}

function actionPhrase(action: SessionFollowUpAction | null | undefined): string {
  switch (action) {
    case undefined:
    case null:
      return ''
    case 'approve':
      return translate('sessionFollowUp.phraseApprove', 'for approval')
    case 'decide':
      return translate('sessionFollowUp.phraseDecide', 'for a decision')
    case 'edit':
      return translate('sessionFollowUp.phraseEdit', 'to edit')
    case 'fyi':
      return translate('sessionFollowUp.phraseFyi', 'for information')
    case 'review':
      return translate('sessionFollowUp.phraseReview', 'for review')
  }
}

export function joinNames(names: readonly string[]): string {
  return new Intl.ListFormat(undefined, { style: 'long', type: 'conjunction' }).format(names)
}

export function followUpPeople(
  rule: Pick<SessionFollowUpRule, 'recipients' | 'agentRecipients'>
): string {
  return joinNames(
    [...rule.recipients, ...(rule.agentRecipients ?? [])].map((recipient) => recipient.name)
  )
}

export function followUpDeliverablesText(
  rule: Pick<SessionFollowUpRule, 'deliverables' | 'includeSummary' | 'transcriptSource'>
): string {
  const files =
    rule.deliverables.kind === 'manifest'
      ? translate('sessionFollowUp.deliverablesManifest', 'the final deliverables from this run')
      : rule.deliverables.kind === 'manifests'
        ? translate(
            'sessionFollowUp.deliverablesManifests',
            'the final deliverables from {{count}} runs',
            { count: rule.deliverables.manifestPaths.length }
          )
        : rule.deliverables.paths.length > 3
          ? translate('sessionFollowUp.deliverablesMany', '{{first}} and {{count}} more files', {
              first: outputFileName(rule.deliverables.paths[0]!),
              count: rule.deliverables.paths.length - 1
            })
          : joinNames(rule.deliverables.paths.map(outputFileName))
  if (rule.transcriptSource) {
    return joinNames([
      ...(files ? [files] : []),
      ...(rule.includeSummary ? [translate('sessionFollowUp.onlySummary', 'a final summary')] : []),
      translate('nextStep.completeHistoryDeliverable', 'complete session history')
    ])
  }
  if (!rule.includeSummary) {
    return files || translate('nextStep.messageDeliverable', 'the message')
  }
  return files
    ? translate('sessionFollowUp.withSummary', '{{files}} and a final summary', { files })
    : translate('sessionFollowUp.onlySummary', 'a final summary')
}

export function followUpReceiptText(
  rule: Pick<SessionFollowUpRule, 'deliverables' | 'includeSummary' | 'recipients' | 'action'>
): string {
  const values = {
    files: followUpDeliverablesText(rule),
    people: followUpPeople(rule),
    action: actionPhrase(rule.action)
  }
  return rule.deliverables.kind !== 'files'
    ? translate(
        'sessionFollowUp.receiptManifest',
        'Saved: when this run declares its final files and stops, send {{files}} to {{people}} {{action}}.',
        values
      )
    : translate(
        'sessionFollowUp.receiptFiles',
        'Saved: when this session is finished, send {{files}} to {{people}} {{action}}.',
        values
      )
}

/** What counts as finished for this rule, said before it is saved. */
export function followUpTriggerText(rule: Pick<SessionFollowUpRule, 'deliverables'>): string {
  if (rule.deliverables.kind !== 'files') {
    return translate(
      'sessionFollowUp.triggerManifest',
      'Finished means the run wrote this manifest, its own list of final files, and stopped.'
    )
  }
  if (rule.deliverables.paths.length === 0) {
    return translate(
      'nextStep.triggerMessageCompletion',
      'Sent after a verified completion or your confirmation that the session is finished.'
    )
  }
  return translate(
    'sessionFollowUp.triggerFiles',
    'A stop at the prompt only ends a turn. When the session stops with every file present, Send now appears; a clean exit also counts as finished.'
  )
}

export function followUpReadyText(): string {
  return translate(
    'sessionFollowUp.statusReady',
    'The session stopped with every file present. Send now if the work is finished; otherwise this waits for its next turn or a clean exit.'
  )
}

export function followUpSentToast(
  rule: Pick<SessionFollowUpRule, 'recipients' | 'action'>
): string {
  const action = followUpActionLabel(rule.action)
  return action
    ? translate('sessionFollowUp.sentToast', 'Sent to {{people}} · {{action}}', {
        people: followUpPeople(rule),
        action
      })
    : translate('sessionFollowUp.sentToastPlain', 'Sent to {{people}}', {
        people: followUpPeople(rule)
      })
}

/** "Waiting for Uma · Review", or just the people when nothing specific was asked. */
export function followUpWaitingText(
  rule: Pick<SessionFollowUpRule, 'recipients' | 'action'>
): string {
  const action = followUpActionLabel(rule.action)
  return action
    ? translate('sessionFollowUp.statusDelivered', 'Waiting for {{people}} · {{action}}', {
        people: followUpPeople(rule),
        action
      })
    : translate('sessionFollowUp.statusDeliveredPlain', 'Waiting for {{people}}', {
        people: followUpPeople(rule)
      })
}

function exceptionText(
  exception: Pick<SessionFollowUpException, 'code' | 'subject' | 'detail'>
): string {
  const { subject, detail } = exception
  switch (exception.code) {
    case 'host-unreachable':
      return translate(
        'sessionFollowUp.errorHostUnreachable',
        '{{host}} is not connected. The run there is unverifiable and nothing was sent; this continues when the host reconnects.',
        { host: subject || translate('sessionFollowUp.theHost', 'The execution host') }
      )
    case 'unverifiable':
      return translate(
        'sessionFollowUp.errorUnverifiable',
        'Whether the session finished could not be verified, so no request was sent. This checks again on its own. {{detail}}',
        { detail }
      )
    case 'unreadable':
      return translate(
        'sessionFollowUp.errorUnreadable',
        'A deliverable could not be read on its computer, so no request was sent. {{detail}}',
        { detail }
      )
    case 'outside-workspace':
      return translate(
        'sessionFollowUp.errorOutsideWorkspace',
        'The manifest lists {{name}}, which is outside this workspace, so no request was sent.',
        { name: subject }
      )
    case 'files-changed':
      return translate(
        'sessionFollowUp.errorFilesChanged',
        '{{name}} changed or disappeared after it was captured, so no request was sent. Retry captures the files again.',
        { name: subject }
      )
    case 'file-too-large':
      return translate(
        'sessionFollowUp.errorFileTooLarge',
        '{{name}} is over the 10 MB limit, so no request was sent.',
        { name: subject }
      )
    case 'too-many-files':
      return translate(
        'sessionFollowUp.errorTooManyFiles',
        'The run declared {{count}} files; one request carries at most 32, so no request was sent.',
        { count: Number(subject) || 0 }
      )
    case 'duplicate-names':
      return translate(
        'sessionFollowUp.errorDuplicateNames',
        'Two deliverables are named {{name}}. Rename one; no request was sent.',
        { name: subject }
      )
    case 'summary-unavailable':
      return translate(
        'sessionFollowUp.errorSummary',
        "The session's final output could not be read for the summary, so no request was sent."
      )
    case 'upload-failed':
      return translate(
        'sessionFollowUp.errorUpload',
        '{{name}} could not be attached to the task, so no request was sent. {{detail}}',
        { name: subject, detail }
      )
    case 'rejected':
      return translate(
        'sessionFollowUp.errorRejected',
        'The request to {{people}} was refused: {{detail}}',
        { people: subject, detail }
      )
    case 'unconfirmed':
      return translate(
        'sessionFollowUp.errorUnconfirmed',
        'Delivery to {{people}} could not be confirmed. Retry sends the same request again and cannot create a second one.',
        { people: subject }
      )
    case 'save-failed':
      return translate(
        'sessionFollowUp.errorSaveFailed',
        'The delivery state could not be saved, so nothing more was sent.'
      )
    case 'run-failed':
      return translate(
        'sessionFollowUp.errorRunFailed',
        'The session did not reach a clean finish, so no request was sent. {{detail}}',
        { detail }
      )
  }
}

export function followUpExceptionMessage(
  exception: Pick<SessionFollowUpException, 'code' | 'subject' | 'detail'>
): string {
  return exceptionText(exception).trim()
}
