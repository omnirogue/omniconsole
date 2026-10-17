import { translate } from '@/i18n/i18n'
import type { ScorecardDocument } from '../../../../shared/console-scorecard-contract'
import { SectionTitle } from './CompaniesNotice'
import { billMoney, providerBillsView, type ProviderBillsRow } from './provider-bills-view'

/**
 * "API cost — provider bills vs logged": what the vendors billed beside what
 * both brands logged, estate-wide because the bills cover both brands. The
 * decisions live in provider-bills-view.ts; this only lays them out. Nothing is
 * drawn when the scorecard carried no `provider_bills` (a company-scoped reader).
 */

const CELL = 'px-2 py-1.5 text-right tabular-nums'

function BillFigure({
  label,
  value,
  title,
  tone
}: {
  label: string
  value: number | null
  title?: string | null
  tone?: string
}) {
  return (
    <div className="min-w-0" title={title ?? undefined}>
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd
        className={`mt-0.5 text-lg font-semibold tabular-nums ${
          value === null ? 'text-muted-foreground' : (tone ?? '')
        }`}
      >
        {billMoney(value)}
      </dd>
    </div>
  )
}

function Headline({ row }: { row: ProviderBillsRow }) {
  return (
    <div className="min-w-0 space-y-2" data-provider-bills-day={row.partial ? 'today' : 'complete'}>
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {row.label} · {row.date}
      </p>
      <dl className="grid grid-cols-3 gap-3">
        <BillFigure
          label={translate('companies.billedKnown', 'Billed (known vendors)')}
          value={row.billed}
          title={row.billedDetail}
        />
        <BillFigure
          label={translate('companies.loggedBoth', 'Logged (both brands)')}
          value={row.logged}
        />
        <BillFigure
          label={translate('companies.notLogged', 'Not logged')}
          value={row.notLogged}
          title={row.notLoggedDetail}
          tone="text-amber-700 dark:text-amber-400"
        />
      </dl>
      {row.notLoggedDetail ? (
        <p className="text-xs text-muted-foreground" data-provider-bills-gap>
          {translate('companies.notLoggedDetail', 'Not logged: {{detail}}', {
            detail: row.notLoggedDetail
          })}
        </p>
      ) : null}
    </div>
  )
}

export function ProviderBillsPanel({ scorecard }: { scorecard: ScorecardDocument | null }) {
  const view = scorecard
    ? providerBillsView(scorecard.provider_bills, scorecard.sources, scorecard.timezone)
    : null
  if (!view) {
    return null
  }
  const title = translate('companies.providerBills', 'API cost — provider bills vs logged')
  return (
    <section
      aria-label={title}
      className="space-y-4 rounded-xl border bg-card p-4"
      data-provider-bills
    >
      <SectionTitle title={title} sub={view.clockNote} />
      {view.headline.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {view.headline.map((row) => (
            <Headline key={row.date} row={row} />
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {translate('companies.noProviderBillDays', 'No provider-bill days in this read.')}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {translate(
          'companies.providerBillsScope',
          'Billed covers only vendors with a billing read; Logged covers every vendor, so Not logged is the per-vendor gap.'
        )}
      </p>
      {view.notConnected ? (
        <p className="text-xs" data-provider-bills-not-connected>
          {view.notConnected}
        </p>
      ) : null}
      {view.days.length > 0 ? (
        <table className="w-full text-xs" data-provider-bills-days>
          <caption className="sr-only">
            {translate(
              'companies.providerBillsCaption',
              'Provider bills vs logged API cost by UTC day'
            )}
          </caption>
          <thead className="text-[11px] text-muted-foreground">
            <tr>
              <th scope="col" className="px-2 py-1.5 text-left font-medium">
                {translate('companies.day', 'Day')}
              </th>
              <th scope="col" className={`${CELL} font-medium`}>
                {translate('companies.billed', 'Billed')}
              </th>
              <th scope="col" className={`${CELL} font-medium`}>
                {translate('companies.logged', 'Logged')}
              </th>
              <th scope="col" className={`${CELL} font-medium`}>
                {translate('companies.notLogged', 'Not logged')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {view.days.map((row) => (
              <tr key={row.date}>
                <th scope="row" className="px-2 py-1.5 text-left font-normal tabular-nums">
                  {row.date}
                  {row.partial ? (
                    <span className="ml-1 text-muted-foreground">{row.label}</span>
                  ) : null}
                </th>
                <td className={CELL} title={row.billedDetail ?? undefined}>
                  {billMoney(row.billed)}
                </td>
                <td className={CELL}>{billMoney(row.logged)}</td>
                <td className={CELL} title={row.notLoggedDetail ?? undefined}>
                  {billMoney(row.notLogged)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {view.basis || view.failures.length > 0 ? (
        <details className="text-[11px] text-muted-foreground" data-provider-bills-basis>
          <summary className="cursor-pointer">
            {view.failures.length > 0
              ? translate('companies.basisFailed', 'Basis · {{count}} source(s) failed', {
                  count: view.failures.length
                })
              : translate('companies.basis', 'Basis')}
          </summary>
          <ul className="mt-2 space-y-1">
            {view.basis ? <li>{view.basis}</li> : null}
            {view.failures.map((source) => (
              <li key={source.name}>
                {source.name}:{' '}
                {source.error ?? source.note ?? translate('companies.sourceFailed', 'failed')}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  )
}
