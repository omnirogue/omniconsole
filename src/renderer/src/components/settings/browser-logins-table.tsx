import type React from 'react'
import { translate } from '@/i18n/i18n'
import type { BrowserProfile } from '../../../../shared/browser-logins-contract'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import {
  browserLoginStatusLabel,
  browserLoginStatusTone,
  siteHost,
  type BrowserLoginStatusTone
} from './browser-logins-format'

const TONE_VARIANT: Record<
  BrowserLoginStatusTone,
  'default' | 'secondary' | 'destructive' | 'outline'
> = {
  good: 'default',
  attention: 'secondary',
  bad: 'destructive',
  neutral: 'outline'
}

export function BrowserLoginsTable({
  profiles,
  busyProfileId,
  onReLogin,
  onVerify
}: {
  profiles: BrowserProfile[]
  busyProfileId: string | null
  onReLogin: (profile: BrowserProfile) => void
  onVerify: (profile: BrowserProfile) => void
}): React.JSX.Element {
  if (profiles.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {translate('browserLogins.none', 'No shared browser profiles yet.')}
      </p>
    )
  }
  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-border/60">
      <table className="w-full text-sm" data-testid="browser-logins-table">
        <thead>
          <tr className="border-b border-border/60 text-left text-xs text-muted-foreground">
            <th className="px-3 py-2 font-medium">
              {translate('browserLogins.column.service', 'Service')}
            </th>
            <th className="px-3 py-2 font-medium">
              {translate('browserLogins.column.company', 'Company')}
            </th>
            <th className="px-3 py-2 font-medium">
              {translate('browserLogins.column.status', 'Status')}
            </th>
            <th className="px-3 py-2 font-medium">
              {translate('browserLogins.column.verified', 'Verified')}
            </th>
            <th className="px-3 py-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          {profiles.map((profile) => {
            const canOpen = profile.actions.includes('open')
            const canVerify = profile.actions.includes('verify')
            const isBusy = busyProfileId === profile.profile_id
            return (
              <tr key={profile.profile_id} className="border-t border-border/50 first:border-t-0">
                <td className="px-3 py-2">
                  <div className="font-medium">{profile.service}</div>
                  <div className="text-xs text-muted-foreground">{siteHost(profile.url)}</div>
                  {profile.notes ? (
                    <div className="text-xs text-muted-foreground">{profile.notes}</div>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {profile.company_slug ?? profile.company_id ?? ''}
                </td>
                <td className="px-3 py-2">
                  <Badge variant={TONE_VARIANT[browserLoginStatusTone(profile.login_status)]}>
                    {browserLoginStatusLabel(profile.login_status)}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {profile.verified_at ?? translate('browserLogins.never', 'Never')}
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!canOpen || isBusy}
                      onClick={() => onReLogin(profile)}
                    >
                      {translate('browserLogins.reLogin', 'Re-login')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!canVerify || isBusy}
                      onClick={() => onVerify(profile)}
                    >
                      {translate('browserLogins.verify', 'Verify')}
                    </Button>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
