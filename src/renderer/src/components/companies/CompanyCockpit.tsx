import { translate } from '@/i18n/i18n'
import { Figure } from './CompaniesNotice'
import { keyedByContent } from './company-model'

type Json = Record<string, unknown>

const asRecord = (value: unknown): Json | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null
const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null
const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/** A list item's readable face — the first naming field the hub put on it. */
function itemLabel(item: unknown): string {
  const record = asRecord(item)
  if (record) {
    for (const key of ['title', 'name', 'goal', 'label', 'summary', 'id']) {
      const value = record[key]
      if (typeof value === 'string' && value.trim()) {
        return value
      }
    }
    return JSON.stringify(record)
  }
  return typeof item === 'string' ? item : JSON.stringify(item)
}

function bucket(value: unknown): { count: number | null; top: unknown[]; hasMore: boolean } {
  const record = asRecord(value) ?? {}
  return {
    count: asNumber(record.count),
    top: asList(record.top),
    hasMore: record.has_more === true
  }
}

function TopList({ title, items, hasMore }: { title: string; items: unknown[]; hasMore: boolean }) {
  if (items.length === 0) {
    return null
  }
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      <ul className="space-y-1">
        {keyedByContent(items.slice(0, 8), itemLabel).map(({ key, item }) => (
          <li key={key} className="truncate text-xs">
            {itemLabel(item)}
          </li>
        ))}
        {hasMore || items.length > 8 ? (
          <li className="text-[11px] text-muted-foreground">
            {translate('companies.moreOnHub', 'more on the hub than shown here')}
          </li>
        ) : null}
      </ul>
    </div>
  )
}

/**
 * The hub's cockpit as facts: what is a person's, what the fleet is on, what is
 * stuck, how the missions stand, whether the domains are ready and dispatch is
 * running. A field the hub did not send prints "—", never 0.
 */
export function CompanyCockpit({ value }: { value: Json }) {
  const human = bucket(value.human_work)
  const ai = bucket(value.ai_work)
  const waiting = bucket(value.waiting_blocked)
  const missions = asRecord(value.missions) ?? {}
  const byState = asRecord(missions.by_state) ?? {}
  const stateEntries = Object.entries(byState).filter(([, count]) => asNumber(count) !== null)
  const missionTotal = stateEntries.reduce((sum, [, count]) => sum + (asNumber(count) ?? 0), 0)
  const ratio = asNumber(value.domains_ratio)
  return (
    <div data-testid="company-cockpit-summary" className="space-y-4">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Figure label={translate('companies.humanWork', 'Human work')} value={human.count} />
        <Figure label={translate('companies.aiWork', 'AI work')} value={ai.count} />
        <Figure
          label={translate('companies.waitingBlocked', 'Waiting / blocked')}
          value={waiting.count}
        />
        <Figure
          label={translate('companies.missions', 'Missions')}
          value={stateEntries.length > 0 ? missionTotal : null}
        />
        <Figure
          label={translate('companies.domainsReady', 'Domains ready')}
          value={
            value.domains_ready === true
              ? translate('companies.yes', 'yes')
              : value.domains_ready === false
                ? translate('companies.no', 'no')
                : null
          }
        />
        <Figure
          label={translate('companies.dispatch', 'Dispatch')}
          value={
            value.dispatch_paused === true
              ? translate('companies.paused', 'paused')
              : value.dispatch_paused === false
                ? translate('companies.running', 'running')
                : null
          }
        />
      </div>
      {stateEntries.length > 0 || ratio !== null ? (
        <p className="text-xs text-muted-foreground">
          {stateEntries
            .map(([state, count]) => `${state.replaceAll('_', ' ')} ${asNumber(count)}`)
            .join(' · ')}
          {ratio !== null
            ? `${stateEntries.length > 0 ? ' · ' : ''}${translate(
                'companies.domainsReadyRatio',
                '{{percent}}% of domains ready',
                { percent: Math.round(ratio * 100) }
              )}`
            : ''}
        </p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <TopList
          title={translate('companies.humanWorkTop', 'Human work · top')}
          items={human.top}
          hasMore={human.hasMore}
        />
        <TopList
          title={translate('companies.aiWorkTop', 'AI work · top')}
          items={ai.top}
          hasMore={ai.hasMore}
        />
        <TopList
          title={translate('companies.waitingTop', 'Waiting / blocked · top')}
          items={waiting.top}
          hasMore={waiting.hasMore}
        />
        <TopList
          title={translate('companies.missionsTop', 'Missions · top')}
          items={asList(missions.top)}
          hasMore={false}
        />
        <TopList
          title={translate('companies.objectives', 'Objectives')}
          items={asList(value.objectives)}
          hasMore={false}
        />
      </div>
      <details data-testid="company-cockpit-raw" className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">
          {translate('companies.rawHubSummary', 'Raw hub summary')}
        </summary>
        <pre className="scrollbar-sleek mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3">
          {JSON.stringify(value, null, 2)}
        </pre>
      </details>
    </div>
  )
}
