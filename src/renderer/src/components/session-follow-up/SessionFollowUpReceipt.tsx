import { useState } from 'react'
import { WorkflowError } from '@/components/console-workflows/WorkflowFields'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { workflowErrorMessage } from '@/lib/console-workflow-client'
import {
  cancelSessionFollowUp,
  confirmSessionFollowUpFinished,
  dismissSessionFollowUp,
  retrySessionFollowUp
} from '@/lib/session-follow-up-commands'
import {
  followUpPeople,
  followUpReceiptText,
  followUpWaitingText,
  joinNames
} from '@/lib/session-follow-up-messages'
import { isSessionFollowUpReady, sessionFollowUpRow } from '@/lib/session-follow-up-rows'
import type { WorkFollowUpRow } from '../../../../shared/backoffice-work-views'
import { sessionFollowUpStep, type SessionChain } from '../../../../shared/session-chain-types'
import {
  hasSessionFollowUpStartedDelivery,
  type SessionFollowUpDelivery,
  type SessionFollowUpRule
} from '../../../../shared/session-follow-up-rule'

function deliveryLabel(delivery: SessionFollowUpDelivery): string {
  switch (delivery) {
    case 'sent':
      return translate('sessionFollowUp.deliverySent', 'Sent')
    case 'sending':
      return translate('sessionFollowUp.deliverySending', 'Sending or not yet confirmed')
    case 'failed':
      return translate('sessionFollowUp.deliveryRefused', 'Refused')
    case 'pending':
      return translate('sessionFollowUp.deliveryPending', 'Not sent yet')
  }
}

function cancelledText(rule: SessionFollowUpRule): string {
  const sent = rule.recipients.filter((person) => person.delivery === 'sent')
  const unsure = rule.recipients.filter((person) => person.delivery === 'sending')
  if (unsure.length > 0) {
    return translate(
      'sessionFollowUp.statusCancelledUnsure',
      'Cancelled. A request to {{people}} may already have been delivered; check the task.',
      { people: joinNames(unsure.map((person) => person.name)) }
    )
  }
  return sent.length > 0
    ? translate('sessionFollowUp.statusCancelledAfter', 'Cancelled after sending to {{people}}.', {
        people: joinNames(sent.map((person) => person.name))
      })
    : translate('sessionFollowUp.statusCancelled', 'Cancelled. Nothing was sent.')
}

function statusText(row: WorkFollowUpRow, rule: SessionFollowUpRule): string {
  const people = followUpPeople(rule)
  switch (row.state) {
    case 'waiting-for-run':
      return (
        row.detail ??
        translate(
          'sessionFollowUp.statusWaitingRun',
          'Waiting for the run to finish, then {{people}}',
          { people }
        )
      )
    case 'delivering':
      return translate('sessionFollowUp.statusDelivering', 'Sending to {{people}}…', { people })
    case 'delivered':
      return followUpWaitingText(rule)
    case 'cancelled':
      return cancelledText(rule)
    case 'exception':
      return row.detail ?? ''
  }
}

/** The saved rule and its real delivery state, with the actions that state allows. */
export function SessionFollowUpReceipt({
  chain,
  onEdit,
  onNew
}: {
  chain: SessionChain
  onEdit: () => void
  onNew: () => void
}): React.JSX.Element | null {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const step = sessionFollowUpStep(chain)
  const row = sessionFollowUpRow(chain)
  if (!step || !row) {
    return null
  }
  const rule = step.handoff
  const started = hasSessionFollowUpStartedDelivery(rule)
  const act = async (action: () => Promise<void>): Promise<void> => {
    setPending(true)
    setError('')
    try {
      await action()
    } catch (reason) {
      setError(workflowErrorMessage(reason))
    } finally {
      setPending(false)
    }
  }
  const finished = row.state === 'delivered' || row.state === 'cancelled'
  return (
    <div className="space-y-3" data-session-follow-up-state={row.state}>
      <p className="text-sm">{followUpReceiptText(rule)}</p>
      <p
        className={
          row.state === 'exception' ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'
        }
      >
        {statusText(row, rule)}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">{translate('sessionFollowUp.task', 'Task')}</dt>
        <dd className="truncate">{rule.taskTitle}</dd>
        {rule.dueAt ? (
          <>
            <dt className="text-muted-foreground">
              {translate('sessionFollowUp.due', 'Due date')}
            </dt>
            <dd>{new Date(rule.dueAt).toLocaleString()}</dd>
          </>
        ) : null}
        {started
          ? rule.recipients.map((person) => (
              <div key={person.employeeId} className="contents">
                <dt className="text-muted-foreground">{person.name}</dt>
                <dd>{deliveryLabel(person.delivery)}</dd>
              </div>
            ))
          : null}
      </dl>
      {rule.files?.length ? (
        <ul className="space-y-0.5 font-mono text-[11px] text-muted-foreground">
          {rule.files.map((file) => (
            <li key={file.name} className="truncate">
              {translate('sessionFollowUp.fileLine', '{{name}} · {{size}} KB · {{digest}}', {
                name: file.name,
                size: Math.max(1, Math.round(file.size / 1024)),
                digest: file.sha256.slice(0, 12)
              })}
            </li>
          ))}
        </ul>
      ) : null}
      <WorkflowError message={error} />
      <div className="flex flex-wrap justify-end gap-2">
        {finished ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => void act(() => dismissSessionFollowUp(chain.id))}
            >
              {translate('sessionFollowUp.dismiss', 'Dismiss')}
            </Button>
            <Button size="sm" variant="outline" disabled={pending} onClick={onNew}>
              {translate('sessionFollowUp.addAnother', 'Add another next step')}
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => void act(() => cancelSessionFollowUp(chain.id))}
          >
            {translate('sessionFollowUp.cancel', 'Cancel next step')}
          </Button>
        )}
        {!finished && !started ? (
          <Button size="sm" variant="outline" disabled={pending} onClick={onEdit}>
            {translate('sessionFollowUp.edit', 'Edit')}
          </Button>
        ) : null}
        {isSessionFollowUpReady(chain) ? (
          <Button
            size="sm"
            disabled={pending}
            onClick={() => void act(() => confirmSessionFollowUpFinished(chain.id))}
          >
            {translate('sessionFollowUp.sendNow', 'Send now')}
          </Button>
        ) : null}
        {row.state === 'waiting-for-run' && rule.waitingForFiles?.length ? (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => void act(() => retrySessionFollowUp(chain.id))}
          >
            {translate('sessionFollowUp.checkAgain', 'Check files now')}
          </Button>
        ) : null}
        {row.state === 'exception' ? (
          <Button
            size="sm"
            disabled={pending}
            onClick={() => void act(() => retrySessionFollowUp(chain.id))}
          >
            {translate('sessionFollowUp.retry', 'Retry')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
