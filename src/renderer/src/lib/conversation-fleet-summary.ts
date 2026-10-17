import { translate } from '@/i18n/i18n'
import type { ConversationFleetView } from '@/store/conversation-fleet-store'
import { conversationFleetProgress, fleetRunPersonActions } from './conversation-fleet-progress'

type SummaryRun = Pick<ConversationFleetView, 'admission' | 'jobs' | 'verified' | 'createdAt'>

export function hasUnconfirmedFleetCancellation(
  run: Pick<ConversationFleetView, 'admission' | 'jobs' | 'verified'>
): boolean {
  return (
    run.admission === 'accepted' &&
    run.verified &&
    run.jobs.some((job) => job.status === 'cancelled' || job.status === 'cancel_requested')
  )
}

export type ConversationFleetSummary = {
  text: string
  completed: number
  total: number
  lastActivityAt: string | null
  lastActivitySource: 'job' | 'receipt' | null
}

function validTimestamp(value: string | null | undefined): number | null {
  const timestamp = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(timestamp) ? timestamp : null
}

/** Receipt recovery can happen long after execution; prefer the jobs' own timestamps. */
function lastActivity(
  run: SummaryRun
): Pick<ConversationFleetSummary, 'lastActivityAt' | 'lastActivitySource'> {
  const timestamps = run.jobs.flatMap((job) => {
    const timestamp = validTimestamp(job.updated_at)
    return timestamp === null ? [] : [timestamp]
  })
  const jobAt = timestamps.length ? Math.max(...timestamps) : null
  const timestamp = jobAt ?? validTimestamp(run.createdAt)
  return {
    lastActivityAt: timestamp === null ? null : new Date(timestamp).toISOString(),
    lastActivitySource: jobAt !== null ? 'job' : timestamp !== null ? 'receipt' : null
  }
}

export function conversationFleetSummary(run: SummaryRun): ConversationFleetSummary {
  const progress = conversationFleetProgress(run.jobs, run.verified)
  const counts = { completed: progress.completed, total: progress.total }
  const summary = { ...counts, ...lastActivity(run) }
  if (run.admission === 'pending') {
    return {
      ...summary,
      text: translate('conversationFleet.summaryPending', 'Checking whether this work started.')
    }
  }
  if (hasUnconfirmedFleetCancellation(run)) {
    return {
      ...summary,
      text: translate(
        'conversationFleet.summaryStopping',
        'Cancellation requested. Stopping has not been confirmed.'
      )
    }
  }
  if (progress.phase === 'unverifiable' || progress.phase === 'cancelled') {
    return {
      ...summary,
      text: progress.total
        ? translate(
            'conversationFleet.summaryUnverifiedProgress',
            'Current status is unavailable. Steps finished at last check: {{completed}} of {{total}}.',
            counts
          )
        : translate('conversationFleet.summaryUnverified', 'Current status is unavailable.')
    }
  }
  switch (progress.phase) {
    case 'working':
      return {
        ...summary,
        text: translate(
          'conversationFleet.summaryWorking',
          'Work is continuing. Steps finished: {{completed}} of {{total}}.',
          counts
        )
      }
    case 'waiting':
      return {
        ...summary,
        text: translate(
          'conversationFleet.summaryWaiting',
          'Waiting to continue. Steps finished: {{completed}} of {{total}}.',
          counts
        )
      }
    case 'failed':
      return {
        ...summary,
        text: translate(
          'conversationFleet.summaryFailed',
          'Some work couldn’t finish. Steps finished: {{completed}} of {{total}}.',
          counts
        )
      }
    case 'complete':
      return {
        ...summary,
        text: translate('conversationFleet.summaryComplete', 'Finished.', counts)
      }
    case 'needs-you':
      return {
        ...summary,
        text: fleetRunPersonActions(run.jobs).decisions.length
          ? translate('conversationFleet.summaryDecision', 'A decision is needed to continue.')
          : translate('conversationFleet.summaryReview', 'Your review is ready.')
      }
  }
}
