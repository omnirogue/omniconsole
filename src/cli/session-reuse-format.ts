import {
  isUnseenUnsentDelivery,
  type SessionContinueWhenIdleResult,
  type SessionPendingDelivery,
  type SessionPendingListResult
} from '../shared/session-pending-delivery-types'
import type { SessionResumeResult } from '../shared/session-resume-types'

function lines(values: (string | null | undefined | false)[]): string {
  return values.filter((line): line is string => typeof line === 'string').join('\n')
}

export function formatSessionResume(result: SessionResumeResult): string {
  return lines([
    result.summary,
    result.paneKey ? `pane ${result.paneKey}` : null,
    result.terminal ? `terminal ${result.terminal}` : null,
    result.cwd ? `folder ${result.cwd}` : null,
    result.profile && !result.profile.isDefault
      ? `profile ${result.profile.variable}=${result.profile.path}`
      : null,
    result.auditError ? `warning: ${result.auditError}` : null
  ])
}

function when(ms: number | undefined): string {
  return ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : 'unknown time'
}

function formatDelivery(delivery: SessionPendingDelivery): string {
  return lines([
    `${delivery.state} · “${delivery.target.title}” · pane ${delivery.target.paneKey} · ${delivery.id}`,
    `  held ${when(delivery.createdAt)} until ${when(delivery.expiresAt)}${delivery.settledAt ? `, ended ${when(delivery.settledAt)}` : ''}`,
    delivery.note ? `  ${delivery.note}` : null,
    `  prompt: ${delivery.text.replace(/\s+/g, ' ').slice(0, 160)}`
  ])
}

export function formatSessionWhenIdle(result: SessionContinueWhenIdleResult): string {
  return lines([
    result.summary,
    result.sent ? `sent: ${result.sent}` : null,
    result.pending ? formatDelivery(result.pending) : null,
    result.auditError ? `warning: ${result.auditError}` : null
  ])
}

export function formatSessionPending(result: SessionPendingListResult): string {
  if (!result.deliveries.length) {
    return 'No prompts are held for busy sessions.'
  }
  const unsent = result.deliveries.filter(isUnseenUnsentDelivery)
  const rest = result.deliveries.filter((delivery) => !isUnseenUnsentDelivery(delivery))
  return lines([
    unsent.length
      ? `NOT SENT (${unsent.length}): these held prompts never reached their session. Decide what to do with each.`
      : null,
    ...unsent.map(formatDelivery),
    unsent.length && rest.length ? '' : null,
    ...rest.map(formatDelivery)
  ])
}
