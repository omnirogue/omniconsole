import { translate } from '@/i18n/i18n'
import { SessionDataStatusLine } from '@/components/session-data-status'
import type { SessionDataSnapshot } from '@/lib/session-data-snapshot-store'
import type { SessionStatistics } from '@/lib/session-statistics'
import type { SessionStatisticsData } from './use-session-statistics-snapshot'

const EMPTY_HOST_LABELS: ReadonlyMap<string, string> = new Map()

export const SESSION_STATISTICS_VIEW_ID = 'session-statistics'

export function SessionStatisticsView({
  snapshot,
  hostLabels = EMPTY_HOST_LABELS,
  embedded = false
}: {
  snapshot: SessionDataSnapshot<SessionStatisticsData>
  hostLabels?: ReadonlyMap<string, string>
  embedded?: boolean
}): React.JSX.Element {
  const columns: [keyof SessionStatistics, string][] = [
    ['needsYou', translate('commandCenter.stats.needsYou', 'Needs you')],
    ['working', translate('commandCenter.stats.working', 'Working')],
    ['waiting', translate('commandCenter.stats.waiting', 'Waiting')],
    ['doneToday', translate('commandCenter.stats.doneToday', 'Done today')],
    ['idle', translate('commandCenter.stats.idle', 'Idle')],
    ['done', translate('commandCenter.stats.done', 'Done')],
    ['stopped', translate('commandCenter.stats.stopped', 'Stopped')],
    ['unverifiable', translate('commandCenter.stats.unverifiable', 'Unverifiable')],
    ['total', translate('commandCenter.stats.total', 'Total')]
  ]
  return (
    <section
      className="h-full min-h-0 overflow-auto scrollbar-sleek p-3"
      data-pane-view-id={SESSION_STATISTICS_VIEW_ID}
    >
      {!embedded ? (
        <h1 className="mb-3 text-base font-semibold">
          {translate('commandCenter.stats.title', 'Session statistics')}
        </h1>
      ) : null}
      <SessionDataStatusLine
        status={snapshot.status}
        issue={snapshot.issue}
        lastSuccessAt={snapshot.lastSuccessAt}
      />
      {snapshot.status === 'healthy-empty' ? (
        <p className="text-sm text-muted-foreground">
          {translate('commandCenter.stats.empty', 'No sessions are listed.')}
        </p>
      ) : null}
      {snapshot.data.byHost.size ? (
        <table className="w-full text-left text-xs">
          <caption className="sr-only">
            {translate('commandCenter.stats.title', 'Session statistics')}
          </caption>
          <thead>
            <tr>
              <th scope="col" className="p-2">
                {translate('commandCenter.stats.host', 'Computer')}
              </th>
              {columns.map(([key, label]) => (
                <th scope="col" key={key} className="p-2">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...snapshot.data.byHost].map(([hostId, counts]) => (
              <tr key={hostId} className="border-t">
                <th scope="row" className="p-2 font-medium">
                  {hostLabels.get(hostId) ??
                    (hostId === 'local'
                      ? translate('commandCenter.stats.local', 'This computer')
                      : hostId === 'unverifiable'
                        ? translate('commandCenter.stats.unknownHost', 'Unknown computer')
                        : hostId)}
                </th>
                {columns.map(([key]) => (
                  <td key={key} className="p-2 tabular-nums">
                    {counts[key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t">
              <th scope="row" className="p-2">
                {translate('commandCenter.stats.total', 'Total')}
              </th>
              {columns.map(([key]) => (
                <td key={key} className="p-2 tabular-nums">
                  {snapshot.data.total[key]}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      ) : null}
    </section>
  )
}
