import React from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import { count, money, ratio, UNKNOWN } from './advertising-format'
import type { CampaignGroup } from './advertising-model'
import type { SalesAdRow } from '../../../../shared/console-advertising-contract'

/** Every measure Sal reads, in the order he reads them. */
const COLUMNS = [
  { key: 'spend', label: () => translate('advertising.spend', 'Spend'), kind: 'money' },
  {
    key: 'budget',
    label: () => translate('advertising.dailyBudget', 'Daily budget'),
    kind: 'money'
  },
  {
    key: 'revenue',
    label: () => translate('advertising.metaRevenue', 'Meta revenue'),
    kind: 'money'
  },
  { key: 'roas', label: () => translate('advertising.roas', 'ROAS'), kind: 'ratio' },
  {
    key: 'link_clicks',
    label: () => translate('advertising.linkClicks', 'Link clicks'),
    kind: 'count'
  },
  { key: 'cpc_link', label: () => translate('advertising.cpcLink', 'Link CPC'), kind: 'money' },
  {
    key: 'registrations',
    label: () => translate('advertising.registrations', 'Registrations'),
    kind: 'count'
  },
  {
    key: 'cost_per_registration',
    label: () => translate('advertising.perRegistration', 'Cost / reg'),
    kind: 'money'
  },
  { key: 'leads', label: () => translate('advertising.leads', 'Leads'), kind: 'count' },
  { key: 'cpl', label: () => translate('advertising.cpl', 'Cost / lead'), kind: 'money' },
  { key: 'add_to_carts', label: () => translate('advertising.carts', 'Carts'), kind: 'count' },
  {
    key: 'cost_per_add_to_cart',
    label: () => translate('advertising.perCart', 'Cost / cart'),
    kind: 'money'
  },
  { key: 'checkouts', label: () => translate('advertising.checkouts', 'Checkouts'), kind: 'count' },
  {
    key: 'cost_per_checkout',
    label: () => translate('advertising.perCheckout', 'Cost / checkout'),
    kind: 'money'
  },
  { key: 'purchases', label: () => translate('advertising.purchases', 'Purchases'), kind: 'count' },
  {
    key: 'cost_per_purchase',
    label: () => translate('advertising.perPurchase', 'Cost / purchase'),
    kind: 'money'
  }
] as const

function cellOf(row: SalesAdRow, key: (typeof COLUMNS)[number]['key']): number | null {
  if (key === 'budget') {
    return row.daily_budget
  }
  const value = row[key as keyof SalesAdRow]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function Cell({
  row,
  column
}: {
  row: SalesAdRow
  column: (typeof COLUMNS)[number]
}): React.JSX.Element {
  const value = cellOf(row, column.key)
  // Why: a CPL without a mapped Lead event is not a CPL — say so rather than print a number.
  const unmapped = (column.key === 'cpl' || column.key === 'leads') && row.lead_event === null
  const text = unmapped
    ? UNKNOWN
    : column.kind === 'money'
      ? money(value)
      : column.kind === 'ratio'
        ? ratio(value)
        : count(value)
  return (
    <td
      className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums"
      data-empty={text === UNKNOWN ? '' : undefined}
      title={
        unmapped
          ? translate('advertising.noLeadEvent', 'This account maps no Meta Lead event.')
          : undefined
      }
    >
      <span className={text === UNKNOWN ? 'text-muted-foreground' : undefined}>{text}</span>
    </td>
  )
}

/**
 * Campaigns, each with its live ad sets beneath and its active/total ad-set count
 * on the campaign row. Figures come straight from the signed read; nothing is
 * recomputed here except the expand state.
 */
export function AdCampaignTable({
  groups,
  liveOnly,
  currency
}: {
  groups: readonly CampaignGroup[]
  liveOnly: boolean
  currency: string | null
}): React.JSX.Element {
  const [open, setOpen] = React.useState<ReadonlySet<string>>(() => new Set<string>())
  const toggle = React.useCallback((id: string) => {
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])
  if (groups.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">
        {liveOnly
          ? translate(
              'advertising.noLiveCampaigns',
              'No live campaigns in this window. Account totals above still include spend before any pause.'
            )
          : translate('advertising.noCampaigns', 'No campaigns were reported for this window.')}
      </p>
    )
  }
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full min-w-[1100px] text-left text-xs" data-testid="ad-campaign-table">
        <thead className="bg-muted/50">
          <tr>
            <th scope="col" className="sticky left-0 z-10 bg-muted/50 px-2 py-2 font-medium">
              {translate('advertising.object', 'Campaign / ad set')}
            </th>
            {COLUMNS.map((column) => (
              <th scope="col" key={column.key} className="px-2 py-2 text-right font-medium">
                {column.label()}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => {
            const expanded = open.has(group.campaignId)
            return (
              <React.Fragment key={group.campaignId}>
                <tr className="border-t bg-muted/20" data-campaign={group.campaignId}>
                  <th
                    scope="row"
                    className="sticky left-0 z-10 max-w-[340px] bg-muted/20 px-2 py-1.5 font-medium"
                  >
                    <button
                      type="button"
                      onClick={() => toggle(group.campaignId)}
                      aria-expanded={expanded}
                      className="flex w-full min-w-0 items-center gap-1.5 text-left hover:underline"
                    >
                      {expanded ? (
                        <ChevronDown className="size-3 shrink-0" aria-hidden />
                      ) : (
                        <ChevronRight className="size-3 shrink-0" aria-hidden />
                      )}
                      <span className="truncate">{group.name}</span>
                      <Badge variant="secondary" className="shrink-0 text-[10px] font-normal">
                        {translate('advertising.adSetCount', '{{active}} / {{total}} ad sets', {
                          active: String(group.activeAdSets),
                          total: String(group.totalAdSets)
                        })}
                      </Badge>
                      {group.unknownAdSets > 0 ? (
                        <Badge variant="outline" className="shrink-0 text-[10px] font-normal">
                          {translate('advertising.statusUnknownCount', '{{count}} status unknown', {
                            count: group.unknownAdSets
                          })}
                        </Badge>
                      ) : null}
                    </button>
                  </th>
                  {group.campaign !== null ? (
                    // Bound first: the narrowing is lost inside the map callback.
                    ((campaign) =>
                      COLUMNS.map((column) => (
                        <Cell key={column.key} row={campaign} column={column} />
                      )))(group.campaign)
                  ) : (
                    <td
                      colSpan={COLUMNS.length}
                      className="px-2 py-1.5 text-right text-muted-foreground"
                    >
                      {translate(
                        'advertising.campaignRowMissing',
                        'The campaign row was not in this report.'
                      )}
                    </td>
                  )}
                </tr>
                {expanded
                  ? group.adSets.map((entry) => (
                      <tr key={entry.row.platform_id} className="border-t">
                        <th
                          scope="row"
                          className="sticky left-0 z-10 max-w-[340px] bg-background px-2 py-1.5 pl-7 font-normal"
                        >
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate">{entry.row.name}</span>
                            {entry.paused ? (
                              <Badge variant="outline" className="shrink-0 text-[10px] font-normal">
                                {translate('advertising.paused', 'Paused')}
                              </Badge>
                            ) : null}
                            {!entry.row.status || !entry.row.effective_status ? (
                              <Badge variant="outline" className="shrink-0 text-[10px] font-normal">
                                {translate('advertising.statusUnknown', 'Status unknown')}
                              </Badge>
                            ) : null}
                          </span>
                        </th>
                        {COLUMNS.map((column) => (
                          <Cell key={column.key} row={entry.row} column={column} />
                        ))}
                      </tr>
                    ))
                  : null}
                {expanded && group.adSets.length === 0 ? (
                  <tr className="border-t">
                    <td
                      colSpan={COLUMNS.length + 1}
                      className="px-2 py-1.5 pl-7 text-muted-foreground"
                    >
                      {liveOnly
                        ? translate(
                            'advertising.noLiveAdSets',
                            'No live ad sets under this campaign in this window.'
                          )
                        : translate('advertising.noAdSets', 'No ad sets were reported.')}
                    </td>
                  </tr>
                ) : null}
              </React.Fragment>
            )
          })}
        </tbody>
      </table>
      {currency !== null && currency !== 'USD' ? (
        <p
          role="alert"
          className="border-t bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-400"
        >
          {translate(
            'advertising.currencyNotUsd',
            'This account reports in {{currency}}; figures are not USD.',
            {
              currency
            }
          )}
        </p>
      ) : null}
    </div>
  )
}
