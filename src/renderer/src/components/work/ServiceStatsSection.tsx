import React from 'react'
import { translate } from '@/i18n/i18n'
import { serviceStats } from './service-stats'
import { StatGrid, StatSection } from './StatTile'
import { failedSources } from '../../../../shared/console-scorecard-contract'
import type { CsCompany } from '../../../../shared/console-scorecard-contract'

export function ServiceStatsSection({
  service
}: {
  service: CsCompany | undefined
}): React.JSX.Element {
  const sentiment = service?.sentiment
  return (
    <StatSection
      title={translate('work.customerService', 'Customer service')}
      subtitle={translate(
        'work.serviceSub',
        'received → replied → backlog → response times → sentiment → conversations'
      )}
      failed={failedSources(service?.sources)}
      note={
        sentiment
          ? translate(
              'work.sentimentMethod',
              'Sentiment: {{method}}, over {{days}} days, {{sample}} tickets sampled.',
              {
                method: sentiment.method || translate('work.methodUnstated', 'method not stated'),
                days: sentiment.window_days ?? '—',
                sample: sentiment.sample ?? '—'
              }
            )
          : null
      }
    >
      {service === undefined ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'work.noDesk',
            'This company has no support desk this console can read, which is not the same as a quiet desk.'
          )}
        </p>
      ) : (
        <>
          <StatGrid stats={serviceStats(service)} />
          {sentiment && sentiment.categories.length > 0 ? (
            <div className="space-y-1 border-t pt-3">
              <h4 className="text-xs font-medium">
                {translate('work.whatTheyWriteAbout', 'What they write about')}
              </h4>
              <ul className="flex flex-wrap gap-1.5">
                {sentiment.categories.slice(0, 10).map((category) => (
                  <li
                    key={category.name}
                    className="rounded-full border px-2 py-0.5 text-[11px] tabular-nums"
                  >
                    {category.name} · {category.n}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {service.recent_tickets.length > 0 ? (
            <div className="space-y-1 border-t pt-3">
              <h4 className="text-xs font-medium">
                {translate('work.recentConversations', 'Recent conversations')}
              </h4>
              <ul className="space-y-0.5">
                {service.recent_tickets.slice(0, 10).map((ticket) => (
                  <li key={ticket.id} className="flex min-w-0 items-baseline gap-2 text-xs">
                    <span className="min-w-0 truncate">{ticket.subject || ticket.id}</span>
                    {ticket.category ? (
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {ticket.category}
                      </span>
                    ) : null}
                    {ticket.needs_human ? (
                      <span className="shrink-0 text-[10px] text-amber-700 dark:text-amber-400">
                        {translate('work.needsHuman', 'needs a human')}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {service.people.length > 0 ? (
            <div className="space-y-1 border-t pt-3">
              <h4 className="text-xs font-medium">{translate('work.whoReplied', 'Who replied')}</h4>
              <ul className="space-y-0.5">
                {service.people.slice(0, 8).map((person) => (
                  <li
                    key={person.actor}
                    className="flex items-baseline justify-between gap-2 text-xs"
                  >
                    <span className="min-w-0 truncate">{person.actor}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                      {translate('work.personSends', '{{sends}} sends · {{touched}} tickets', {
                        sends: person.sends ?? '—',
                        touched: person.tickets_touched ?? '—'
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </StatSection>
  )
}
