import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

/** What happened to one selected conversation inside a bulk action. */
export type SessionBulkOutcome = {
  key: string
  label: string
  ok: boolean
  skipped?: boolean
  message?: string
}

/** A `message` on a successful step is a note about it, such as context the hub did not take. */
export type SessionBulkStep = { ok: boolean; skipped?: boolean; message?: string }

/**
 * Run one action over the selection in order, never in parallel: each step is a store
 * write or a tab close that must see the previous one settled, and a throw is an outcome,
 * not an abort.
 */
export async function runSessionBulkAction<T extends { key: string; label: string }>(
  items: readonly T[],
  run: (item: T) => SessionBulkStep | Promise<SessionBulkStep>
): Promise<SessionBulkOutcome[]> {
  const outcomes: SessionBulkOutcome[] = []
  for (const item of items) {
    try {
      const step = await run(item)
      outcomes.push({ key: item.key, label: item.label, ...step })
    } catch (error) {
      outcomes.push({
        key: item.key,
        label: item.label,
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }
  return outcomes
}

export function succeededSessionKeys(outcomes: readonly SessionBulkOutcome[]): string[] {
  return outcomes.filter((outcome) => outcome.ok).map((outcome) => outcome.key)
}

export type SessionBulkSummary = {
  tone: 'success' | 'warning' | 'error'
  title: string
  description: string | null
}

/** One line for the toast: all done, some done (naming the rest), or nothing done. */
export function describeSessionBulkOutcomes(
  action: string,
  outcomes: readonly SessionBulkOutcome[]
): SessionBulkSummary {
  const done = outcomes.filter((outcome) => outcome.ok)
  const failed = outcomes.filter((outcome) => !outcome.ok)
  if (failed.length === 0) {
    // Why: "all done" with a warning attached is still a warning — the note is the only place
    // the person learns what the action could not carry over.
    const notes = done
      .filter((outcome) => outcome.message)
      .map((outcome) => `${outcome.label} (${outcome.message})`)
      .join(', ')
    return {
      tone: notes ? 'warning' : 'success',
      title: translate('conversations.bulkAllDone', '{{action}}: {{count}} conversations.', {
        action,
        count: done.length
      }),
      description: notes
        ? translate('conversations.bulkDoneNotes', 'Note: {{labels}}', { labels: notes })
        : null
    }
  }
  const labels = failed
    .map((outcome) => (outcome.message ? `${outcome.label} (${outcome.message})` : outcome.label))
    .join(', ')
  return {
    tone: done.length > 0 ? 'warning' : 'error',
    title:
      done.length > 0
        ? translate('conversations.bulkPartial', '{{action}}: {{done}} of {{total}}.', {
            action,
            done: done.length,
            total: outcomes.length
          })
        : translate('conversations.bulkNoneDone', '{{action}}: nothing changed.', { action }),
    description: translate('conversations.bulkFailedLabels', 'Not done: {{labels}}', { labels })
  }
}

export function toastSessionBulkOutcomes(
  action: string,
  outcomes: readonly SessionBulkOutcome[]
): SessionBulkSummary {
  const summary = describeSessionBulkOutcomes(action, outcomes)
  const options = summary.description ? { description: summary.description } : undefined
  if (summary.tone === 'success') {
    toast.success(summary.title, options)
  } else if (summary.tone === 'warning') {
    toast.warning(summary.title, options)
  } else {
    toast.error(summary.title, options)
  }
  return summary
}
