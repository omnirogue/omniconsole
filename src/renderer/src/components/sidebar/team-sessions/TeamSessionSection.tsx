import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { LedgerNowResult } from '@/lib/session-ledger-types'
import { ledgerSectionRows } from './session-ledger-rows'
import { TeamSessionRow } from './TeamSessionRow'

export function TeamSessionSection({
  title,
  result,
  live,
  retry
}: {
  title: string
  result: LedgerNowResult | null
  live: boolean
  retry: () => void
}) {
  const rows = ledgerSectionRows(result, live)
  return (
    <section aria-label={title}>
      <h3 className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {!result ? (
        <div
          role="status"
          aria-label={translate('sessionLedger.loading', 'Loading team sessions')}
          className="space-y-2 px-4 py-2"
        >
          {[0, 1, 2].map((key) => (
            <div
              key={key}
              className="h-8 animate-pulse rounded-md bg-muted motion-reduce:animate-none"
            />
          ))}
        </div>
      ) : !result.ok ? (
        <div className="px-4 py-2 text-xs text-muted-foreground">
          <p>
            {result.reason === 'signed-out'
              ? translate('sessionLedger.signedOut', 'Sign in to see your team')
              : translate('sessionLedger.unavailable', 'Team sessions unavailable')}
          </p>
          {result.reason !== 'signed-out' ? (
            <Button variant="ghost" size="xs" onClick={retry}>
              {translate('sessionLedger.retry', 'Retry')}
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          <ul>
            {rows.map((row) => (
              <TeamSessionRow key={row.ledger_id} row={row} serverTime={result.server_time} />
            ))}
          </ul>
          {rows.length === 0 ? (
            <p className="px-4 py-2 text-xs text-muted-foreground">
              {live
                ? translate('sessionLedger.empty', 'No sessions')
                : translate('sessionLedger.emptyToday', 'No finished sessions yet today')}
            </p>
          ) : null}
        </>
      )}
    </section>
  )
}
