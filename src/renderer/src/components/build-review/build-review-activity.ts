import { translate } from '@/i18n/i18n'
import type {
  BuildReviewEvent,
  BuildReviewEventKind
} from '../../../../shared/build-review-pipeline'
import { plainFailureText, withoutIdentifiers } from './build-review-plain-text'

export type BuildReviewActivityEntry = {
  key: string
  at: string
  role: BuildReviewEvent['role']
  kind: BuildReviewEvent['kind']
  text: string
}

// What people wrote: an agent's question or escalation, the operator's reply, a worker's report
// subject. Shown as written, never rewritten.
const VERBATIM_KINDS: ReadonlySet<BuildReviewEventKind> = new Set<BuildReviewEventKind>([
  'question',
  'reply',
  'escalation',
  'worker_done'
])

/** The runtime's own plumbing lines, reworded for a person; null for any other line. */
function plumbingLine(text: string): string | null {
  if (/^Run \S+ bound to \S+/.test(text)) {
    return translate('buildReview.activity.coordinatorReady', 'Run started')
  }
  if (/^Dispatch \S+ is running$/.test(text)) {
    return translate('buildReview.activity.workerRunning', 'Agent is running')
  }
  if (text.startsWith('Pipeline created for ')) {
    return translate('buildReview.activity.created', 'Run created')
  }
  if (text === 'Pipeline completed') {
    return translate('buildReview.activity.completed', 'Run completed')
  }
  if (text === 'Pipeline cancelled') {
    return translate('buildReview.activity.cancelled', 'Run cancelled')
  }
  if (text === 'Cancel requested by the operator') {
    return translate('buildReview.activity.cancelRequested', 'Cancel requested')
  }
  if (text.startsWith('Ignored worker_done from ')) {
    return translate(
      'buildReview.activity.ignoredReport',
      'Ignored a report from an agent outside this run'
    )
  }
  if (text.startsWith('Recorded on card ')) {
    return translate('buildReview.activity.recorded', 'Recorded on the linked task')
  }
  const notRecorded = /^Could not record \S+ on card \S+: ([\s\S]*)$/.exec(text)
  if (notRecorded) {
    return translate(
      'buildReview.activity.notRecorded',
      'Could not record on the linked task: {{reason}}',
      { reason: withoutIdentifiers(notRecorded[1]!.trim()) }
    )
  }
  if (text.startsWith('All reviewers approved. Acceptance is decided on card ')) {
    return translate('buildReview.activity.allApproved', 'All reviewers approved')
  }
  return recoveryLine(text)
}

/** Failure lines `plainFailureText` words: a stuck start, or a workspace another run holds. */
const RECOVERY_FAILURE =
  /Agent startup blocked: |\bagent_prompt_(?:stalled|blocked)\b|still owns this workspace|is still (?:starting|building|reviewing) in this workspace/

/** Lines about a stuck start and the workspace it held, reworded for a person. */
function recoveryLine(text: string): string | null {
  if (/^release retained(?: \([^)]*\))?$/.test(text)) {
    return translate('buildReview.activity.terminalKept', "Kept the agent's terminal open")
  }
  if (text === 'Kept its terminal open so you can answer it') {
    return translate(
      'buildReview.activity.keptForAnswer',
      'Kept its terminal open so you can answer it'
    )
  }
  if (text === 'Retry requested') {
    return translate('buildReview.activity.retry', 'Retry requested')
  }
  if (text === 'Workspace released') {
    return translate('buildReview.activity.released', 'Workspace released')
  }
  if (text === 'The workspace is still reserved.') {
    return translate('buildReview.activity.stillReserved', 'The workspace is still reserved.')
  }
  return RECOVERY_FAILURE.test(text)
    ? plainFailureText(text.replace(/^(?:builder|reviewer): /, ''))
    : null
}

function readableText(event: BuildReviewEvent): string {
  if (VERBATIM_KINDS.has(event.kind)) {
    return event.text.trim()
  }
  const text = event.text.trim()
  return plumbingLine(text) ?? withoutIdentifiers(text)
}

/**
 * The run's event log as a person reads it: heartbeats (one per worker ping) dropped, the
 * runtime's plumbing reworded without its identifiers, and consecutive repeats folded into one.
 */
export function buildReviewActivity(
  events: readonly BuildReviewEvent[]
): BuildReviewActivityEntry[] {
  const entries: BuildReviewActivityEntry[] = []
  events.forEach((event, index) => {
    if (event.kind === 'heartbeat') {
      return
    }
    const text = readableText(event)
    const previous = entries.at(-1)
    if (!text || (previous && previous.text === text && previous.role === event.role)) {
      return
    }
    entries.push({
      key: `${index}:${event.at}`,
      at: event.at,
      role: event.role,
      kind: event.kind,
      text
    })
  })
  return entries
}
