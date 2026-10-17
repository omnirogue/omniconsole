import { translate } from '@/i18n/i18n'
import { localGraphEventLanes, type LocalGraphView } from '@/lib/local-graph-view'

/**
 * One lane per step plus the run's own, filled from the events the runner already
 * stored. Nothing is fetched: a local Run's timeline is local by definition.
 */
export function LocalRunTimeline({ view }: { view: LocalGraphView }) {
  const lanes = localGraphEventLanes(view)
  const runLabel = translate('auto.components.local-run.Timeline.run', 'Run')
  return (
    <section
      aria-label={translate('auto.components.local-run.Timeline.label', 'Timeline')}
      className="grid gap-4 overflow-x-auto scrollbar-sleek"
      style={{ gridTemplateColumns: `repeat(${lanes.length}, minmax(16rem, 1fr))` }}
    >
      {lanes.map((lane) => (
        <section
          key={lane.node}
          aria-label={lane.node === 'run' ? runLabel : lane.node}
          className="space-y-2 rounded-lg border border-border p-3"
        >
          <h3 className="text-sm font-medium">{lane.node === 'run' ? runLabel : lane.node}</h3>
          {lane.events.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {translate('auto.components.local-run.Timeline.empty', 'Nothing recorded yet.')}
            </p>
          ) : (
            <ol className="space-y-2">
              {lane.events.map((event, index) => (
                <li
                  key={`${event.at}:${index}`}
                  className="whitespace-pre-wrap break-words border-l border-border pl-3 font-mono text-xs"
                >
                  <div className="text-muted-foreground">
                    {event.at} · {event.kind}
                  </div>
                  <div>{event.text}</div>
                </li>
              ))}
            </ol>
          )}
        </section>
      ))}
    </section>
  )
}
