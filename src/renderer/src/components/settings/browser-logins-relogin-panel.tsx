import type React from 'react'
import { useCallback, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import {
  browserLoginsApi,
  browserLoginsErrorLine,
  browserLoginStatusLabel
} from './browser-logins-format'
import {
  nextBrowserLoginPollOutcome,
  useBrowserLoginStatusPolling,
  type BrowserLoginPollOutcome
} from './browser-logins-polling'

export type ReLoginSession = {
  profileId: string
  service: string
  liveViewUrl: string | null
  revision: number
}

/**
 * The re-login flow for one profile: the AirTop live view to sign in inside, an
 * "I've logged in" button that saves the session at the revision it was opened
 * at, then polls until the hub reports it verified, an error, or the 3-minute
 * budget runs out — whichever the hub says, shown verbatim, never guessed at.
 */
export function BrowserLoginsReLoginPanel({
  session,
  onClose,
  onSettled
}: {
  session: ReLoginSession
  onClose: () => void
  onSettled: () => void
}): React.JSX.Element {
  const [phase, setPhase] = useState<'live' | 'saving' | 'polling' | 'settled'>('live')
  const [resultText, setResultText] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  const finish = useCallback(
    (outcome: BrowserLoginPollOutcome, statusLabel: string) => {
      setPhase('settled')
      setResultText(
        outcome === 'timed_out'
          ? translate(
              'browserLogins.timedOut',
              'Still {{status}} after 3 minutes. Try again, or check the site directly.',
              { status: statusLabel }
            )
          : statusLabel
      )
      onSettled()
    },
    [onSettled]
  )

  const checkStatus = useCallback(async () => {
    const result = await browserLoginsApi().status({ profile_id: session.profileId })
    if (!result.ok) {
      throw result.error
    }
    return result.data.login_status
  }, [session.profileId])

  useBrowserLoginStatusPolling({
    active: phase === 'polling',
    checkStatus,
    onOutcome: (outcome, loginStatus) => {
      if (outcome === 'continue') {
        return
      }
      finish(outcome, browserLoginStatusLabel(loginStatus))
    }
  })

  const handleLoggedIn = useCallback(() => {
    setBusy(true)
    setError(null)
    void browserLoginsApi()
      .save({ profile_id: session.profileId, expected_revision: session.revision })
      .then((result) => {
        setBusy(false)
        if (!result.ok) {
          setError(result.error)
          return
        }
        const outcome = nextBrowserLoginPollOutcome(result.data.login_status, 0)
        if (outcome === 'continue') {
          setPhase('polling')
        } else {
          finish(outcome, browserLoginStatusLabel(result.data.login_status))
        }
      })
      .catch((reason: unknown) => {
        setBusy(false)
        setError(reason)
      })
  }, [session.profileId, session.revision, finish])

  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-border/60 p-3"
      data-testid="browser-logins-relogin-panel"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="text-sm font-medium">
          {translate('browserLogins.reLoginTitle', 'Re-login: {{service}}', {
            service: session.service
          })}
        </h4>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {translate('browserLogins.close', 'Close')}
        </Button>
      </div>
      {phase === 'live' && session.liveViewUrl ? (
        <>
          <iframe
            title={translate('browserLogins.liveViewTitle', 'Live view: {{service}}', {
              service: session.service
            })}
            src={session.liveViewUrl}
            sandbox="allow-scripts allow-forms allow-same-origin"
            allow="clipboard-read; clipboard-write"
            className="h-[480px] w-full rounded border-0 bg-background"
          />
          <a
            href={session.liveViewUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-muted-foreground underline"
          >
            {translate('browserLogins.openInBrowser', 'Open in browser')}
          </a>
          <Button onClick={handleLoggedIn} disabled={busy} size="sm" className="w-fit">
            {busy
              ? translate('browserLogins.saving', 'Saving…')
              : translate('browserLogins.imLoggedIn', "I've logged in")}
          </Button>
        </>
      ) : null}
      {phase === 'polling' ? (
        <p className="text-xs text-muted-foreground" role="status">
          {translate('browserLogins.checking', 'Checking the login…')}
        </p>
      ) : null}
      {phase === 'settled' && resultText ? (
        <p className="text-sm" role="status">
          {resultText}
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {browserLoginsErrorLine(error)}
        </p>
      ) : null}
    </div>
  )
}
