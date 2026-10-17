import { translate } from '@/i18n/i18n'
import {
  capacityStateLine,
  capacityWindowLines,
  formatCapacityReadingTime
} from '@/lib/account-capacity-format'
import type {
  AccountCapacityRow,
  AccountSignedOutReason
} from '../../../../shared/provider-account-capacity'

function signedOutReasonLine(reason: AccountSignedOutReason): string {
  switch (reason) {
    case 'expired':
      return translate('accountCapacity.reason.expired', 'The saved sign-in expired')
    case 'revoked':
      return translate('accountCapacity.reason.revoked', 'The sign-in was revoked')
    case 'no-login':
      return translate('accountCapacity.reason.noLogin', 'No sign-in found on this computer')
  }
}

export function AccountCapacityWindows({ row }: { row: AccountCapacityRow }): React.JSX.Element {
  const state = capacityStateLine(row)
  const updated =
    row.readingAt === null
      ? undefined
      : translate('settings.accountBalances.updated', 'Updated {{time}}', {
          time: formatCapacityReadingTime(row.readingAt)
        })
  const reason =
    row.signedOutReason === null
      ? undefined
      : translate('settings.accountBalances.signOutReason', 'Sign-in status: {{reason}}', {
          reason: signedOutReasonLine(row.signedOutReason)
        })
  return (
    <div className="min-w-32 text-right text-xs tabular-nums" title={updated}>
      {capacityWindowLines(row).map((line) => (
        <div key={line}>{line}</div>
      ))}
      {state ? (
        <div className="text-muted-foreground" title={reason}>
          {state}
        </div>
      ) : null}
    </div>
  )
}
