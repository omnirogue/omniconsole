import type React from 'react'
import { useState } from 'react'
import { translate } from '@/i18n/i18n'
import { companiesApi, useCompaniesRead } from '@/components/companies/companies-client'
import type { AddSiteRequest, BrowserProfile } from '../../../../shared/browser-logins-contract'
import { Button } from '../ui/button'
import { BrowserLoginsAddSiteForm } from './browser-logins-add-site-form'
import { browserLoginsApi, browserLoginsErrorLine } from './browser-logins-format'
import { BrowserLoginsReLoginPanel, type ReLoginSession } from './browser-logins-relogin-panel'
import { BrowserLoginsTable } from './browser-logins-table'

/**
 * Settings → Backoffice → Browser logins: the shared AirTop profiles the hub
 * keeps signed in on Sal's behalf. Every action here — opening the live view,
 * saving a fresh sign-in, verifying one still works — goes through the hub,
 * which decides who may touch which profile; this pane only shows what it
 * says and never a credential.
 */
export function BrowserLoginsSettingsPane(): React.JSX.Element {
  const list = useCompaniesRead(() => browserLoginsApi().list(), 'browser-logins:list')
  const me = useCompaniesRead(() => companiesApi().me(), 'me')
  const isAdmin = me.data?.user?.role === 'admin'
  const [session, setSession] = useState<ReLoginSession | null>(null)
  const [busyProfileId, setBusyProfileId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<unknown>(null)
  const [verifyAllReport, setVerifyAllReport] = useState<string | null>(null)
  const [verifyAllBusy, setVerifyAllBusy] = useState(false)

  const handleReLogin = (profile: BrowserProfile): void => {
    setBusyProfileId(profile.profile_id)
    setActionError(null)
    void browserLoginsApi()
      .open({ profile_id: profile.profile_id })
      .then((result) => {
        setBusyProfileId(null)
        if (!result.ok) {
          setActionError(result.error)
          return
        }
        setSession({
          profileId: profile.profile_id,
          service: profile.service,
          liveViewUrl: result.data.live_view_url ?? null,
          revision: result.data.revision
        })
      })
      .catch((reason: unknown) => {
        setBusyProfileId(null)
        setActionError(reason)
      })
  }

  const handleVerify = (profile: BrowserProfile): void => {
    setBusyProfileId(profile.profile_id)
    setActionError(null)
    void browserLoginsApi()
      .verify({ profile_id: profile.profile_id, expected_revision: profile.revision })
      .then((result) => {
        setBusyProfileId(null)
        if (!result.ok) {
          setActionError(result.error)
          return
        }
        list.reload()
      })
      .catch((reason: unknown) => {
        setBusyProfileId(null)
        setActionError(reason)
      })
  }

  const handleAdd = async (request: AddSiteRequest): Promise<{ ok: boolean; error?: unknown }> => {
    const result = await browserLoginsApi().add(request)
    if (result.ok) {
      list.reload()
      return { ok: true }
    }
    return { ok: false, error: result.error }
  }

  const handleVerifyAll = (): void => {
    setVerifyAllBusy(true)
    setVerifyAllReport(null)
    void browserLoginsApi()
      .verifyAll()
      .then((result) => {
        setVerifyAllBusy(false)
        if (!result.ok) {
          setActionError(result.error)
          return
        }
        setVerifyAllReport(JSON.stringify(result.data))
        list.reload()
      })
      .catch((reason: unknown) => {
        setVerifyAllBusy(false)
        setActionError(reason)
      })
  }

  return (
    <div className="flex flex-col gap-4" data-testid="browser-logins-pane">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">
            {translate('browserLogins.title', 'Browser logins')}
          </h2>
          <p className="text-xs text-muted-foreground">
            {translate(
              'browserLogins.subtitle',
              "Shared AirTop browser profiles. Each one is Sal's identity at that site — act as Sal would."
            )}
          </p>
        </div>
        {isAdmin ? (
          <Button variant="outline" size="sm" disabled={verifyAllBusy} onClick={handleVerifyAll}>
            {verifyAllBusy
              ? translate('browserLogins.verifyingAll', 'Verifying…')
              : translate('browserLogins.verifyAll', 'Verify all now')}
          </Button>
        ) : null}
      </div>
      {list.loading ? (
        <p className="text-sm text-muted-foreground">
          {translate('browserLogins.loading', 'Loading…')}
        </p>
      ) : null}
      {list.error ? (
        <p className="text-sm text-destructive" role="alert">
          {browserLoginsErrorLine(list.error)}
        </p>
      ) : null}
      {actionError ? (
        <p className="text-sm text-destructive" role="alert">
          {browserLoginsErrorLine(actionError)}
        </p>
      ) : null}
      {verifyAllReport ? (
        <p className="text-xs text-muted-foreground" role="status">
          {verifyAllReport}
        </p>
      ) : null}
      {list.data ? (
        <BrowserLoginsTable
          profiles={list.data.profiles}
          busyProfileId={busyProfileId}
          onReLogin={handleReLogin}
          onVerify={handleVerify}
        />
      ) : null}
      {session ? (
        <BrowserLoginsReLoginPanel
          session={session}
          onClose={() => setSession(null)}
          onSettled={() => list.reload()}
        />
      ) : null}
      <BrowserLoginsAddSiteForm onAdd={handleAdd} />
    </div>
  )
}
