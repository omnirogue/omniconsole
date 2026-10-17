import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { EvolveCompounding } from './EvolveCompounding'
import { EvolveDecisionCard } from './EvolveDecisionCard'
import { EvolveHostedProgressCard } from './EvolveHostedProgressCard'
import { EvolveRunHeader } from './EvolveRunHeader'
import { EvolveRunStatus } from './EvolveRunStatus'
import { evolveTime } from './evolve-run-text'
import { useEvolveRun } from './use-evolve-run'

/** One Evolve run, read from this computer's record and followed while it is active. */
export function EvolveRunView({ tabId, runId }: { tabId: string; runId: string }) {
  // A status push for this tab means the record changed: read it now, not at the next poll.
  const pushed = useAppStore((state) => state.localWorkflowStatusByTabId[tabId])
  const { run, readError, read } = useEvolveRun(runId, pushed)
  if (!run) {
    return readError ? (
      <div role="alert" className="space-y-2 text-sm">
        <p className="text-destructive">{readError}</p>
        <Button size="sm" variant="outline" onClick={() => void read()}>
          {translate('evolve.retry', 'Retry')}
        </Button>
      </div>
    ) : (
      <p role="status" className="text-sm text-muted-foreground">
        {translate('evolve.loading', 'Loading the Evolve run…')}
      </p>
    )
  }
  return (
    <div className="space-y-6">
      <EvolveRunHeader run={run} />
      {readError && (
        <p role="status" className="text-xs text-muted-foreground">
          {translate('evolve.readFailed', 'Last read failed: {{reason}}', { reason: readError })}
        </p>
      )}
      <EvolveRunStatus run={run} />
      <EvolveHostedProgressCard run={run} />
      <EvolveDecisionCard run={run} />
      {run.ledger && <EvolveCompounding ledger={run.ledger} />}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">{translate('evolve.events', 'Events')}</h3>
        {run.events.length > 0 ? (
          <ol className="space-y-1 text-xs">
            {run.events.map((event) => (
              // Events are append-only; one instant never carries the same text twice.
              <li key={`${event.at}-${event.text}`} className="flex gap-3">
                <time dateTime={event.at} className="shrink-0 text-muted-foreground tabular-nums">
                  {evolveTime(event.at)}
                </time>
                <span className="min-w-0 break-words">{event.text}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-xs text-muted-foreground">
            {translate('evolve.noEvents', 'Nothing recorded yet.')}
          </p>
        )}
      </section>
      {run.ledger && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            {translate('evolve.rawStatus', 'Raw ledger status (JSON)')}
          </summary>
          <pre className="mt-2 max-h-96 overflow-auto rounded-md border bg-muted/40 p-2 font-mono scrollbar-sleek">
            {JSON.stringify(run.ledger, null, 2)}
          </pre>
        </details>
      )}
    </div>
  )
}
