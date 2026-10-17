import React from 'react'
import { SectionTitle } from '@/components/companies/CompaniesNotice'
import { translate } from '@/i18n/i18n'
import { money, rangeLabel, stamp } from './advertising-format'
import { stripeCashWindow } from './advertising-model'
import {
  SALES_COMPANIES,
  type SalesCompany,
  type SalesRangeDays
} from '../../../../shared/console-advertising-contract'

const ACCOUNT_NAME: Record<SalesCompany, () => string> = {
  omnirogue: () => translate('advertising.omnirogue', 'OmniRogue'),
  betacorp: () => translate('advertising.betacorp', 'BetaCorp')
}
const ACCOUNTS: readonly SalesCompany[] = SALES_COMPANIES

export function StripeCashPanel({
  scorecard,
  rangeDays,
  error
}: {
  scorecard: Parameters<typeof stripeCashWindow>[0]
  rangeDays: SalesRangeDays
  error: unknown
}): React.JSX.Element {
  return (
    <section
      className="space-y-2 rounded-xl border bg-card p-4"
      aria-label={translate('advertising.stripeRegion', 'Stripe cash collected')}
    >
      <SectionTitle
        title={translate('advertising.stripeCash', 'Stripe cash collected')}
        sub={rangeLabel(rangeDays)}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {ACCOUNTS.map((company) => (
          <div key={company} className="flex items-end justify-between gap-3 rounded-lg border p-3">
            <div className="min-w-0">
              <p className="truncate text-xs font-medium">{ACCOUNT_NAME[company]()}</p>
              <p className="text-[11px] text-muted-foreground">
                {translate('advertising.stripeNote', 'All channels, rebills included{{split}}', {
                  split:
                    company === 'omnirogue'
                      ? translate('advertising.stripeNoSplit', ' · Enterprise and DTC not split')
                      : ''
                })}
              </p>
            </div>
            <strong className="shrink-0 text-lg tabular-nums">
              {money(stripeCashWindow(scorecard, company, rangeDays))}
            </strong>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">
        {translate(
          'advertising.stripeSeparate',
          'Stripe cash is separate from Meta-attributed revenue and is never added to it.'
        )}
        {error
          ? ` ${translate('advertising.stripeUnavailable', 'The cash scorecard is unavailable.')}`
          : scorecard
            ? ` ${translate(
                'advertising.stripeCollected',
                'Collected {{when}} · {{today}} · {{zone}}.',
                {
                  when: stamp(scorecard.generated_at, scorecard.timezone ?? undefined),
                  today: scorecard.today,
                  zone:
                    scorecard.timezone ?? translate('advertising.zoneUnknown', 'timezone unknown')
                }
              )}`
            : ''}
      </p>
    </section>
  )
}

/** What the window covered, what it missed, and what is therefore withheld. */
