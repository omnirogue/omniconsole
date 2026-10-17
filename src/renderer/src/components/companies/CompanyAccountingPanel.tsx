import { useState } from 'react'
import { CreditCard, Download, Landmark, RefreshCw, Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import {
  ACCOUNTING_COMPANIES,
  type AccountingCompany,
  type AccountingSnapshot
} from '../../../../shared/console-accounting-contract'
import { CompaniesNotice, Figure, SectionTitle } from './CompaniesNotice'
import {
  companiesApi,
  companiesData,
  companiesErrorMessage,
  useCompaniesRead
} from './companies-client'
import {
  accountTotals,
  bankHealth,
  dateLabel,
  filterTransactions,
  isCashAccount,
  isCreditAccount,
  label,
  money,
  safeLink
} from './company-model'

function Tone({ text, tone }: { text: string; tone: string }) {
  return (
    <Badge variant={tone === 'error' ? 'destructive' : tone === 'ok' ? 'secondary' : 'outline'}>
      {text}
    </Badge>
  )
}

function Balances({ snapshot }: { snapshot: AccountingSnapshot }) {
  const definitions = [
    {
      field: 'cash_available_minor' as const,
      title: translate('companies.availableCash', 'Available cash')
    },
    {
      field: 'credit_available_minor' as const,
      title: translate('companies.availableCredit', 'Available card credit')
    },
    {
      field: 'credit_posted_minor' as const,
      title: translate('companies.postedCard', 'Posted card balance')
    }
  ]
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {definitions.map(({ field, title }) => {
        const totals = accountTotals(snapshot.bank.accounts, field)
        return (
          <Figure
            key={field}
            label={title}
            value={
              totals.length > 0
                ? totals.map((total) => money(total.amount, total.currency)).join(' · ')
                : translate('companies.unavailable', 'Unavailable')
            }
          />
        )
      })}
    </div>
  )
}

function Accounts({ snapshot }: { snapshot: AccountingSnapshot }) {
  const { bank } = snapshot
  if (bank.accounts.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {bank.status === 'not_connected'
          ? translate(
              'companies.bankNotConnected',
              'Connect this company’s bank account to see balances and transactions.'
            )
          : translate(
              'companies.bankNoAccounts',
              'Balances will appear after the first successful bank sync.'
            )}
      </p>
    )
  }
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {bank.accounts.map((account) => {
        const credit = isCreditAccount(account)
        const cash = isCashAccount(account)
        return (
          <article key={account.id} className="rounded-lg border p-3">
            <div className="flex items-center gap-2">
              {credit ? <CreditCard className="size-4" /> : <Landmark className="size-4" />}
              <div className="min-w-0">
                <h3 className="truncate text-sm font-medium">
                  {account.name || translate('companies.account', 'Account')}
                </h3>
                <span className="text-xs text-muted-foreground">
                  {label(account.kind)}
                  {account.mask ? ` · ••${account.mask}` : ''} · {account.currency}
                </span>
              </div>
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-2 text-xs">
              {credit ? (
                <>
                  <div>
                    <dt className="text-muted-foreground">
                      {translate('companies.creditAvailable', 'Credit available')}
                    </dt>
                    <dd className="tabular-nums">
                      {money(account.credit_available_minor, account.currency)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">
                      {translate('companies.postedCard', 'Posted card balance')}
                    </dt>
                    <dd className="tabular-nums">
                      {money(account.credit_posted_minor, account.currency)}
                    </dd>
                  </div>
                </>
              ) : null}
              {cash ? (
                <>
                  <div>
                    <dt className="text-muted-foreground">
                      {translate('companies.cashAvailable', 'Cash available')}
                    </dt>
                    <dd className="tabular-nums">
                      {money(account.cash_available_minor, account.currency)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">
                      {translate('companies.postedBalance', 'Posted balance')}
                    </dt>
                    <dd className="tabular-nums">
                      {money(account.cash_posted_minor, account.currency)}
                    </dd>
                  </div>
                </>
              ) : null}
            </dl>
          </article>
        )
      })}
    </div>
  )
}

function Transactions({ snapshot }: { snapshot: AccountingSnapshot }) {
  const [search, setSearch] = useState('')
  const [shown, setShown] = useState(25)
  const { bank } = snapshot
  const rows = filterTransactions(bank.transactions, search, '', '')
  const coverage =
    bank.coverage.from && bank.coverage.to
      ? `${dateLabel(bank.coverage.from)} – ${dateLabel(bank.coverage.to)}`
      : translate('companies.periodUnavailable', 'Period not available')
  return (
    <section
      className="space-y-2"
      aria-label={translate('companies.transactions', 'Bank transactions')}
    >
      <SectionTitle
        title={translate('companies.transactions', 'Bank transactions')}
        sub={translate('companies.transactionCount', '{{shown}} of {{total}} loaded', {
          shown: rows.length,
          total: bank.transactions.length
        })}
      />
      <p className="text-xs text-muted-foreground">
        {coverage}
        {bank.coverage.complete
          ? ''
          : ` · ${translate('companies.historyIncomplete', 'history incomplete')}`}
      </p>
      <div className="flex items-center gap-2">
        <Search className="size-3.5 text-muted-foreground" aria-hidden />
        <Input
          aria-label={translate('companies.searchTransactions', 'Search transactions')}
          placeholder={translate('companies.searchPlaceholder', 'Search merchant or transaction…')}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value)
            setShown(25)
          }}
          className="h-8 max-w-xs"
        />
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {bank.transactions.length > 0
            ? translate('companies.noMatches', 'No transactions match this search.')
            : translate('companies.noTransactions', 'No transactions loaded.')}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 text-left">{translate('companies.date', 'Date')}</th>
                <th className="py-1 text-left">
                  {translate('companies.description', 'Description')}
                </th>
                <th className="py-1 text-left">{translate('companies.status', 'Status')}</th>
                <th className="py-1 text-right">{translate('companies.amount', 'Amount')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, shown).map((row) => {
                const source = safeLink(row.source_url)
                return (
                  <tr key={row.id} className="border-t">
                    <td className="py-1 whitespace-nowrap">{dateLabel(row.occurred_at)}</td>
                    <td className="py-1">
                      {source ? (
                        <button
                          type="button"
                          className="text-left text-primary underline-offset-4 hover:underline"
                          onClick={() => void window.api.shell.openUrl(source)}
                        >
                          {row.description || translate('companies.transaction', 'Transaction')}
                        </button>
                      ) : (
                        row.description || translate('companies.transaction', 'Transaction')
                      )}
                    </td>
                    <td className="py-1">{label(row.status)}</td>
                    <td className="py-1 text-right tabular-nums">
                      {row.amount_minor !== null && row.amount_minor > 0 ? '+' : ''}
                      {money(row.amount_minor, row.currency)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > shown ? (
        <Button variant="outline" size="sm" onClick={() => setShown((value) => value + 25)}>
          {translate('companies.showMore', 'Show more transactions')}
        </Button>
      ) : null}
    </section>
  )
}

/** Save the signed bank export the transport fetched; the bytes never leave main unsigned. */
async function saveTransactionsCsv(company: AccountingCompany): Promise<void> {
  const exported = companiesData(await companiesApi().transactionsCsv({ company }))
  const url = URL.createObjectURL(new Blob([exported.csv], { type: 'text/csv' }))
  const link = document.createElement('a')
  link.href = url
  link.download = exported.filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** One company's money: bank balances, its accounts, its activity — read-only, plus a refresh. */
export function CompanyAccountingPanel({ company }: { company: AccountingCompany }) {
  const query = useCompaniesRead(
    () => companiesApi().accounting({ company }),
    `accounting:${company}`
  )
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState<'sync' | 'csv' | null>(null)
  if (query.error) {
    return <CompaniesNotice error={query.error} onRetry={query.reload} />
  }
  const snapshot = query.data
  const health = snapshot ? bankHealth(snapshot.bank) : null
  return (
    <div className="space-y-4" data-company-accounting={company}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionTitle
          title={translate('companies.accounting', 'Accounting')}
          sub={ACCOUNTING_COMPANIES[company]}
        />
        <div className="flex items-center gap-2">
          {health ? <Tone text={health.text} tone={health.tone} /> : null}
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={() => {
              setBusy('sync')
              setNotice('')
              void companiesApi()
                .syncAccounting({ company })
                .then((result) => {
                  setNotice(
                    result.ok
                      ? translate(
                          'companies.refreshQueued',
                          'Bank refresh requested. This view updates when the new data arrives.'
                        )
                      : result.error.message
                  )
                  if (result.ok) {
                    query.reload()
                  }
                })
                .finally(() => setBusy(null))
            }}
          >
            <RefreshCw className="size-3.5" />
            {translate('companies.syncBank', 'Refresh bank data')}
          </Button>
          {snapshot && snapshot.bank.transactions.length > 0 ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => {
                setBusy('csv')
                setNotice('')
                void saveTransactionsCsv(company)
                  .catch((reason: unknown) => setNotice(companiesErrorMessage(reason)))
                  .finally(() => setBusy(null))
              }}
            >
              <Download className="size-3.5" />
              {translate('companies.downloadCsv', 'Download CSV')}
            </Button>
          ) : null}
        </div>
      </div>
      {notice ? (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      ) : null}
      {!snapshot ? (
        <p role="status" className="text-sm text-muted-foreground">
          {query.loading
            ? translate('companies.loadingAccounting', 'Loading accounting…')
            : translate('companies.accountingUnavailable', 'Accounting data is unavailable.')}
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {snapshot.bank.last_synced_at
              ? translate('companies.bankAsOf', 'Bank data as of {{when}}', {
                  when: dateLabel(snapshot.bank.last_synced_at, true)
                })
              : translate('companies.bankNeverSynced', 'Bank data has not synced yet')}
          </p>
          {snapshot.bank.error ? (
            <p role="alert" className="text-xs text-destructive">
              {snapshot.bank.error}
            </p>
          ) : null}
          <Balances snapshot={snapshot} />
          <Accounts snapshot={snapshot} />
          <p className="text-xs text-muted-foreground">
            {translate('companies.booksStatus', 'Books: {{status}}', {
              status: label(snapshot.books.status)
            })}
            {snapshot.books.company_name ? ` · ${snapshot.books.company_name}` : ''}
            {snapshot.books.note ? ` · ${snapshot.books.note}` : ''}
          </p>
          <Transactions snapshot={snapshot} />
          <p className="text-xs text-muted-foreground">
            {translate(
              'companies.accountingFootnote',
              'Bank activity includes transfers; revenue and profit come from the company’s books.'
            )}
          </p>
        </>
      )}
    </div>
  )
}
