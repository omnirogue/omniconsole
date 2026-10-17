import React from 'react'
import { Megaphone, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { rangeLabel } from './advertising-format'
import {
  SALES_RANGE_DAYS,
  type SalesRangeDays
} from '../../../../shared/console-advertising-contract'

/** The page's own chrome: what it is, which window, and one refresh for every read. */
export function AdvertisingHeader({
  rangeDays,
  onRange,
  busy,
  onRefresh
}: {
  rangeDays: SalesRangeDays
  onRange: (value: SalesRangeDays) => void
  busy: boolean
  onRefresh: () => void
}): React.JSX.Element {
  return (
    <header className="flex flex-wrap items-center justify-between gap-4 border-b px-6 py-5">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Megaphone className="size-5" aria-hidden />
          {translate('advertising.nav', 'Advertising')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {translate(
            'advertising.subtitle',
            'Today first, in the account timezone. Spend, budget, Meta revenue and Stripe cash are four different facts.'
          )}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">{translate('advertising.window', 'Window')}</span>
          <select
            aria-label={translate('advertising.windowLabel', 'Date window')}
            value={rangeDays}
            onChange={(event) => onRange(Number(event.target.value) as SalesRangeDays)}
            className="rounded-md border bg-background px-2 py-1 text-xs"
          >
            {SALES_RANGE_DAYS.map((value) => (
              <option key={value} value={value}>
                {rangeLabel(value)}
              </option>
            ))}
          </select>
        </label>
        <Button
          size="sm"
          variant="outline"
          onClick={onRefresh}
          disabled={busy}
          aria-label={translate('advertising.refresh', 'Refresh')}
        >
          <RefreshCw className={cn('size-3.5', busy && 'animate-spin')} aria-hidden />
          {translate('advertising.refresh', 'Refresh')}
        </Button>
      </div>
    </header>
  )
}

/** Stripe cash, beside Meta revenue and never added to it. */
