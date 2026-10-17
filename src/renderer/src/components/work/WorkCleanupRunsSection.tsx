import React, { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  SESSION_CLEANUP_RPC,
  type CleanupAdmission,
  type CleanupRunRow,
  type CleanupRunsView
} from '../../../../shared/session-cleanup-run'
import { WorkSectionTitle } from './WorkSectionTitle'
import {
  cleanupClock,
  cleanupNowOutcome,
  cleanupPhaseLabel,
  cleanupRunPhase,
  cleanupSourceLabel
} from './cleanup-runs-model'

/** How often an open Work page re-reads a cleanup that is still going. */
const ACTIVE_POLL_MS = 15_000

function useCleanupRuns(): {
  view: CleanupRunsView | null
  error: string | null
  reload: () => void
} {
  const [view, setView] = useState<CleanupRunsView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const reload = useCallback(() => setRevision((value) => value + 1), [])
  useEffect(() => {
    let live = true
    callRuntimeRpc<CleanupRunsView | null>({ kind: 'local' }, SESSION_CLEANUP_RPC.runs, undefined)
      .then((next) => {
        if (live) {
          setView(next)
          setError(null)
        }
      })
      .catch((reason: unknown) => {
        if (live) {
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      })
    return () => {
      live = false
    }
  }, [revision])
  const active = Boolean(view?.active)
  useEffect(() => {
    if (!active) {
      return
    }
    const timer = setInterval(reload, ACTIVE_POLL_MS)
    return () => clearInterval(timer)
  }, [active, reload])
  return { view, error, reload }
}

function RunRow({ run }: { run: CleanupRunRow }): React.JSX.Element {
  return (
    <li className="rounded-lg border bg-card px-3 py-2" data-cleanup-run={run.runId}>
      <div className="text-sm font-medium">
        {`${cleanupSourceLabel(run.source)} · ${cleanupClock(run.createdAt)} · ${cleanupPhaseLabel(cleanupRunPhase(run.status))}`}
      </div>
      {run.report ? (
        <p className="mt-1 line-clamp-4 whitespace-pre-line text-xs text-muted-foreground">
          {run.report}
        </p>
      ) : run.error ? (
        <p className="mt-1 text-xs text-destructive">{run.error}</p>
      ) : null}
    </li>
  )
}

/**
 * One-off cleanup sessions: the app starts one when leftovers pile up (at most 3 a day, one at a
 * time, only with capacity), and Clean up now starts one on request. Each reports here and closes.
 */
export function WorkCleanupRunsSection(): React.JSX.Element {
  const { view, error, reload } = useCleanupRuns()
  const [starting, setStarting] = useState(false)
  const running = Boolean(view?.active)
  const cleanUpNow = (): void => {
    setStarting(true)
    void callRuntimeRpc<CleanupAdmission>({ kind: 'local' }, SESSION_CLEANUP_RPC.now, undefined)
      .then((admission) => {
        const outcome = cleanupNowOutcome(admission)
        if (outcome.tone === 'success') {
          toast.success(outcome.message)
        } else {
          toast.warning(outcome.message)
        }
      })
      .catch((reason: unknown) =>
        toast.error(reason instanceof Error ? reason.message : String(reason))
      )
      .finally(() => {
        setStarting(false)
        reload()
      })
  }
  return (
    <section
      aria-label={translate('work.cleanup.title', 'Cleanup runs')}
      data-work-cleanup={view?.runs.length ?? 0}
    >
      <WorkSectionTitle
        title={translate('work.cleanup.title', 'Cleanup runs')}
        sub={
          view && !view.automaticOn
            ? translate('work.cleanup.automaticOff', 'Automatic cleanup is off')
            : view
              ? translate('work.cleanup.today', '{{count}} of {{cap}} automatic today', {
                  count: view.automaticToday,
                  cap: view.dailyCap
                })
              : undefined
        }
        action={
          <Button size="xs" variant="outline" disabled={starting || running} onClick={cleanUpNow}>
            {running
              ? translate('work.cleanup.running', 'Cleaning up…')
              : translate('work.cleanup.now', 'Clean up now')}
          </Button>
        }
      />
      <ul className="space-y-1.5">
        {view?.active && !view.active.run ? (
          <li className="rounded-lg border border-dashed px-3 py-2 text-sm">
            {`${cleanupSourceLabel(view.active.source)} · ${cleanupClock(view.active.takenAt)} · ${cleanupPhaseLabel('starting')}`}
          </li>
        ) : null}
        {(view?.runs ?? []).map((run) => (
          <RunRow key={run.runId} run={run} />
        ))}
        {(view?.skipped ?? []).map((skip) => (
          <li
            key={`${skip.reason}:${skip.at}`}
            className="px-3 text-xs text-muted-foreground"
            data-cleanup-skip={skip.reason}
          >
            {translate('work.cleanup.skipped', 'Skipped: {{detail}} · {{when}}', {
              detail: skip.detail,
              when: cleanupClock(skip.at)
            })}
            {skip.count > 1 ? ` ×${skip.count}` : ''}
            {skip.why ? ` · ${skip.why}` : ''}
          </li>
        ))}
      </ul>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {!error && view && view.runs.length === 0 && !view.active ? (
        <p className="text-sm text-muted-foreground">
          {translate('work.cleanup.none', 'No cleanup has run yet.')}
        </p>
      ) : null}
    </section>
  )
}
