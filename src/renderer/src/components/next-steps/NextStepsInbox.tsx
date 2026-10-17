import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useSidebarSessions } from '@/components/sidebar/session-folders/use-sidebar-sessions'
import { toastSessionBulkOutcomes } from '@/components/sidebar/session-folders/session-bulk-outcome'
import { NextStepsTray } from './NextStepsTray'
import {
  dismissAllInInbox,
  formatInboxSessionCount,
  formatRunAllSafe,
  inboxSafeNextSteps,
  nextStepsInboxRows
} from './next-steps-inbox'
import { buildInboxRunPlan, runInboxPlan, type InboxRunPlan } from './next-steps-inbox-run-plan'
import { NextStepsInboxRunReview } from './NextStepsInboxRunReview'
import {
  refreshPendingNextSteps,
  usePendingNextSteps,
  usePendingNextStepSets
} from './next-steps-pending-store'

/**
 * Every conversation with suggested next steps waiting, on one page: expand a row for its tray,
 * or answer them all at once. Bulk runs only ever send safe steps.
 */
export function NextStepsInbox() {
  const pending = usePendingNextStepSets()
  const sessions = useSidebarSessions()
  const known = pending.state === 'known' ? pending.sets : null
  const rows = useMemo(() => (known ? nextStepsInboxRows(known, sessions) : []), [known, sessions])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [plan, setPlan] = useState<InboxRunPlan | null>(null)
  if (pending.state === 'unknown') {
    // Why say so: an unreadable host is not "nothing waiting".
    return (
      <p
        className="shrink-0 border-b border-border px-3 py-2 text-xs text-muted-foreground"
        role="status"
      >
        {translate(
          'nextStepsInbox.unknown',
          'Suggested next steps could not be read. They will show again once the host answers.'
        )}
      </p>
    )
  }
  if (!rows.length) {
    return null
  }
  const runnable = rows.filter((row) => !row.missing && inboxSafeNextSteps(row.set).length > 0)

  const bulk = async (
    action: string,
    work: () => Promise<Parameters<typeof toastSessionBulkOutcomes>[1]>
  ): Promise<void> => {
    setBusy(true)
    try {
      toastSessionBulkOutcomes(action, await work())
    } catch (failure) {
      toast.error(action, {
        description: failure instanceof Error ? failure.message : String(failure)
      })
    } finally {
      setBusy(false)
      refreshPendingNextSteps()
    }
  }

  const confirm = (reviewed: InboxRunPlan): void => {
    // Checked against the host's newest answer, read at the moment of the click.
    const latest = usePendingNextSteps.getState()
    const current = latest.unknown || latest.revision === null ? null : (latest.sets ?? null)
    void bulk(translate('nextStepsInbox.runAllSafeAction', 'Run all safe'), () =>
      runInboxPlan(reviewed, current)
    ).finally(() => setPlan(null))
  }

  return (
    <section
      aria-label={translate('nextStepsInbox.title', 'Suggested next steps')}
      className="shrink-0 border-b border-border px-3 py-2"
      data-next-steps-inbox
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium">
          {translate('nextStepsInbox.title', 'Suggested next steps')}
        </span>
        <span className="text-muted-foreground">{formatInboxSessionCount(rows.length)}</span>
        <Button
          size="xs"
          className="ml-auto"
          disabled={busy || !runnable.length}
          // Opens the review; nothing is sent until the person confirms the exact prompts.
          onClick={() => setPlan(buildInboxRunPlan(rows))}
        >
          {formatRunAllSafe(runnable.length)}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void bulk(translate('nextStepsInbox.dismissAllAction', 'Dismiss suggestions'), () =>
              dismissAllInInbox(rows)
            )
          }
        >
          {translate('nextStepsInbox.dismissAll', 'Dismiss all')}
        </Button>
      </div>
      <ul className="mt-1 max-h-72 overflow-y-auto scrollbar-sleek">
        {rows.map((row) => {
          const open = expanded === row.key
          return (
            <li key={row.key} data-next-steps-inbox-row={row.key}>
              <Button
                variant="ghost"
                size="xs"
                className="w-full justify-start gap-2 font-normal"
                aria-expanded={row.missing ? undefined : open}
                disabled={row.missing}
                onClick={() => setExpanded(open ? null : row.key)}
              >
                {open && !row.missing ? <ChevronDown /> : <ChevronRight />}
                <span className="shrink-0 font-medium">{row.label}</span>
                <span className="shrink-0 text-muted-foreground">
                  {translate('nextStepsInbox.count', '✦{{n}}', {
                    n: row.set.suggestions.length
                  })}
                </span>
                <span className="min-w-0 truncate text-muted-foreground">
                  {row.set.suggestions[0]?.title}
                </span>
              </Button>
              {open && row.tabId !== null ? (
                <NextStepsTray
                  compact
                  paneKey={row.conversation.paneKey}
                  tabId={row.tabId}
                  conversation={row.conversation}
                  disabled={busy}
                />
              ) : null}
            </li>
          )
        })}
      </ul>
      <NextStepsInboxRunReview
        plan={plan}
        busy={busy}
        onConfirm={confirm}
        onCancel={() => setPlan(null)}
      />
    </section>
  )
}
