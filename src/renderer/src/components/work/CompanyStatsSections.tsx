import React from 'react'
import { translate } from '@/i18n/i18n'
import { ApiCostBreakdown } from './ApiCostBreakdown'
import { DivisionGrid } from './DivisionGrid'
import { QuickBooksPanel } from './QuickBooksPanel'
import { financeStats } from './finance-stats'
import { operationsStats } from './operations-stats'
import { StatGrid, StatSection } from './StatTile'
import { failedSources, listCoverage } from '../../../../shared/console-scorecard-contract'
import type {
  FinanceCompany,
  OpsCompany,
  OpsTaskBrief,
  ScorecardCompany,
  ScorecardDocument
} from '../../../../shared/console-scorecard-contract'

/** Finance and admin, with the API-cost detail and the QuickBooks link beside it. */
export function FinanceStatsSection({
  company,
  finance,
  booksNote,
  slug,
  revision
}: {
  company: ScorecardCompany | undefined
  finance: FinanceCompany | undefined
  booksNote: string | null
  slug: string
  revision: number
}): React.JSX.Element {
  return (
    <StatSection
      title={translate('work.financeAdmin', 'Finance and admin')}
      subtitle={translate(
        'work.financeSub',
        'revenue → API cost → provider → model → feature → margin'
      )}
      failed={failedSources(finance?.sources ?? company?.sources)}
      note={booksNote}
    >
      <StatGrid stats={financeStats(company, finance)} />
      <div className="space-y-2 border-t pt-3">
        <h4 className="text-xs font-medium">
          {translate('work.whereCostWent', 'Where the AI spend went')}
        </h4>
        <ApiCostBreakdown today={finance?.api_cost_today} sevenDays={finance?.api_cost_7d} />
      </div>
      <QuickBooksPanel slug={slug} revision={revision} />
    </StatSection>
  )
}

/** One capped list of cards, saying how much of how many it shows. */
function TaskList({
  title,
  items,
  whole,
  tone
}: {
  title: string
  items: readonly OpsTaskBrief[]
  whole: number | null | undefined
  tone?: 'bad'
}): React.JSX.Element | null {
  if (items.length === 0) {
    return null
  }
  const coverage = listCoverage(items.length, whole)
  return (
    <div className="min-w-0 space-y-1">
      <h4 className="text-xs font-medium">
        {title}
        <span className="ml-1.5 font-normal text-muted-foreground">
          {coverage.capped
            ? translate('work.listCapped', '{{shown}} of {{whole}}', {
                shown: coverage.shown,
                whole: coverage.whole ?? coverage.shown
              })
            : coverage.shown}
        </span>
      </h4>
      <ul className="space-y-0.5">
        {items.slice(0, 8).map((item) => (
          <li key={item.id} className="flex min-w-0 items-baseline gap-2 text-xs">
            <span
              className={`min-w-0 truncate ${tone === 'bad' ? 'text-rose-600 dark:text-rose-400' : ''}`}
            >
              {item.title || item.id}
            </span>
            {item.domain ? (
              <span className="shrink-0 text-[10px] text-muted-foreground">{item.domain}</span>
            ) : null}
          </li>
        ))}
        {items.length > 8 ? (
          <li className="text-[11px] text-muted-foreground">
            {translate('work.moreRows', '{{count}} more rows', { count: items.length - 8 })}
          </li>
        ) : null}
      </ul>
    </div>
  )
}

/** Operations: what is live, what is stuck, what shipped, and who is working. */
export function OperationsStatsSection({
  operations,
  document,
  slug
}: {
  operations: OpsCompany | undefined
  /** Passed so the division cards can reach the sources their headlines depend on. */
  document: ScorecardDocument | null | undefined
  slug: string
}): React.JSX.Element {
  const domains = operations?.tasks?.by_domain ?? []
  const reasons = operations?.tasks?.blocked_reasons ?? []
  const routines = operations?.routines
  const repos = operations?.github ?? []
  return (
    <StatSection
      title={translate('work.operations', 'Operations')}
      subtitle={translate(
        'work.operationsSub',
        'projects → objectives → tasks → pull requests → QA → deployments → who is working'
      )}
      failed={failedSources(operations?.sources)}
      note={
        routines
          ? translate(
              'work.routinesLine',
              'Routines: {{active}} active · {{paused}} paused · {{pending}} pending · {{failing}} failing.',
              {
                active: routines.active ?? '—',
                paused: routines.paused ?? '—',
                pending: routines.pending ?? '—',
                failing: routines.failing ?? '—'
              }
            )
          : null
      }
    >
      {operations === undefined ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'work.noOpsBlock',
            'The collector has not sent an operations block for this company yet.'
          )}
        </p>
      ) : (
        <>
          <StatGrid stats={operationsStats(operations)} />
          <div className="space-y-2 border-t pt-3">
            <h4 className="text-xs font-medium">
              {translate('work.divisions', 'Divisions')}
              <span className="ml-1.5 font-normal text-muted-foreground">
                {translate(
                  'work.divisionsSub',
                  'one figure each, withheld when its source did not answer'
                )}
              </span>
            </h4>
            <DivisionGrid document={document} slug={slug} />
          </div>
          {domains.length > 0 ? (
            <div className="overflow-x-auto border-t pt-3">
              <table className="w-full min-w-[360px] text-left text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th scope="col" className="py-1 font-medium">
                      {translate('work.domain', 'Domain')}
                    </th>
                    {['live', 'inProgress', 'blocked'].map((key) => (
                      <th scope="col" key={key} className="py-1 text-right font-medium">
                        {key === 'live'
                          ? translate('work.live', 'Live')
                          : key === 'inProgress'
                            ? translate('work.inProgress', 'In progress')
                            : translate('work.blocked', 'Blocked')}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {domains.map((domain) => (
                    <tr key={domain.name} className="border-t">
                      <th scope="row" className="py-1 font-normal">
                        {domain.name}
                      </th>
                      <td className="py-1 text-right tabular-nums">{domain.live}</td>
                      <td className="py-1 text-right tabular-nums">{domain.in_progress}</td>
                      <td
                        className={`py-1 text-right tabular-nums ${domain.blocked > 0 ? 'text-rose-600 dark:text-rose-400' : ''}`}
                      >
                        {domain.blocked}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="border-t pt-3 text-[11px] text-muted-foreground">
              {translate(
                'work.noDomainSplit',
                'The collector did not split this company’s work by domain.'
              )}
            </p>
          )}
          <div className="grid gap-4 border-t pt-3 sm:grid-cols-2">
            <TaskList
              title={translate('work.liveNow', 'What is live right now')}
              items={operations.top_live ?? []}
              whole={operations.tasks?.live}
            />
            <TaskList
              title={translate('work.waitingPerson', 'Waiting on a person')}
              items={operations.waiting_on_human ?? []}
              whole={operations.waiting_on_human_count}
            />
            <TaskList
              title={translate('work.waitingAgent', 'Waiting on an agent')}
              items={operations.waiting_on_ai ?? []}
              whole={operations.waiting_on_ai_count}
            />
            <TaskList
              title={translate('work.qaWaiting', 'QA waiting on a verdict')}
              items={operations.qa?.items ?? []}
              whole={operations.qa?.count}
            />
            <TaskList
              title={translate('work.doneSeven', 'Finished in the last 7 days')}
              items={operations.recently_done ?? []}
              whole={operations.recently_done_count}
            />
            {reasons.length > 0 ? (
              <div className="min-w-0 space-y-1">
                <h4 className="text-xs font-medium">
                  {translate('work.whyBlocked', 'Why work is blocked')}
                </h4>
                <ul className="space-y-0.5">
                  {reasons.slice(0, 6).map((reason) => (
                    <li
                      key={reason.reason}
                      className="flex items-baseline justify-between gap-2 text-xs text-rose-600 dark:text-rose-400"
                    >
                      <span className="min-w-0 truncate">{reason.reason}</span>
                      <span className="shrink-0 tabular-nums">{reason.n}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {(operations.sessions_working ?? []).length > 0 ? (
              <div className="min-w-0 space-y-1">
                <h4 className="text-xs font-medium">
                  {translate('work.agentsWorking', 'Agents working right now')}
                </h4>
                <ul className="space-y-0.5">
                  {(operations.sessions_working ?? []).slice(0, 8).map((session) => (
                    <li key={session.id} className="min-w-0 truncate text-xs">
                      {session.title || session.id}
                      {session.model ? (
                        <span className="ml-1.5 text-[10px] text-muted-foreground">
                          {session.model}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
          {repos.length > 0 ? (
            <div className="space-y-1 border-t pt-3">
              <h4 className="text-xs font-medium">
                {translate('work.development', 'Development')}
              </h4>
              <ul className="space-y-0.5">
                {repos.map((repo) => (
                  <li
                    key={repo.repo}
                    className="flex min-w-0 flex-wrap items-baseline gap-2 text-xs"
                  >
                    <span className="min-w-0 truncate font-medium">{repo.repo}</span>
                    <span className="text-[11px] text-muted-foreground tabular-nums">
                      {translate(
                        'work.repoLine',
                        '{{open}} open PRs · {{merged}} merged 7d · {{issues}} open issues · {{commits}} commits 7d',
                        {
                          open: repo.open_prs ?? '—',
                          merged: repo.merged_7d ?? '—',
                          issues: repo.open_issues ?? '—',
                          commits: repo.commits_7d ?? '—'
                        }
                      )}
                    </span>
                    {repo.main_ci?.conclusion === 'failure' ? (
                      <span className="text-[11px] text-rose-600 dark:text-rose-400">
                        {translate('work.ciRed', 'main CI failing')}
                      </span>
                    ) : null}
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

/** Customer service, with its sentiment method stated beside every percentage. */
