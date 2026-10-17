import { translate } from '@/i18n/i18n'
import type { SessionDataIssue, SessionDataStatus } from '@/lib/session-data-snapshot-store'

export function SessionDataStatusLine({
  status,
  issue,
  lastSuccessAt
}: {
  status: SessionDataStatus
  issue: SessionDataIssue | null
  lastSuccessAt: number | null
}): React.JSX.Element | null {
  if (status === 'healthy' || status === 'healthy-empty') {
    return null
  }
  const reason =
    issue === 'signed-out' || status === 'signed-out'
      ? translate('work.data.signedOut', 'Sign in to OmniOS to refresh this list.')
      : translate('work.data.unavailable', 'This list could not be refreshed.')
  return (
    <p role="status" className="mb-2 text-xs text-muted-foreground">
      {status === 'loading' ? translate('work.loading', 'Loading…') : reason}
      {status === 'stale' && lastSuccessAt !== null ? (
        <>
          {' '}
          {translate('work.data.stale', 'Showing the last successful list from {{time}}.', {
            time: new Date(lastSuccessAt).toLocaleTimeString()
          })}
        </>
      ) : null}
    </p>
  )
}
