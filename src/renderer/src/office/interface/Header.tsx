import { Building2 } from 'lucide-react'
import React from 'react'
import { useNow } from '@/hooks/use-now'
import { translate } from '@/i18n/i18n'
import { useFleetStore } from '../integration/fleet/fleetStore'
import { useJobsStore } from '../integration/fleet/jobsStore'

function connectionLabel(connected: boolean, seconds: number | null): string {
  if (!connected) {
    return translate('office.panels.Header.connecting', 'connecting…')
  }
  if (seconds === null) {
    return translate('office.panels.Header.live', 'live')
  }
  return translate('office.panels.Header.liveAge', 'live · {{seconds}}s', { seconds })
}

/**
 * Fleet Office inner header — Omni Console branding.
 *
 * The office is mounted INSIDE the console's AppShell (which already renders the
 * sidebar + top breadcrumb), so this is a slim contextual bar: it names the view
 * and shows the live FleetBridge connection state. No external author, logo,
 * version, or "Manage Teams" chrome — this is our system, our data.
 */
const Header: React.FC = () => {
  const { connected, lastUpdated } = useFleetStore()
  // The count the operator sees is now JOB count (titled work), not raw process
  // count. Characters in the 3D scene still track sessions.
  const jobs = useJobsStore((s) => s.jobs)
  const live = (jobs ?? []).length
  const now = useNow(1000, connected && lastUpdated != null)
  const ago = lastUpdated != null ? Math.max(0, Math.round((now - lastUpdated) / 1000)) : null

  return (
    <header className="h-12 border-b border-zinc-100 flex items-center justify-between px-5 bg-white shrink-0 relative z-40">
      <div className="flex items-center gap-2.5 min-w-0">
        <div className="w-7 h-7 rounded-lg bg-indigo-500/10 text-indigo-500 flex items-center justify-center shrink-0">
          <Building2 size={16} strokeWidth={2.2} />
        </div>
        <div className="flex flex-col leading-tight min-w-0">
          <span className="text-[13px] font-semibold text-zinc-800 truncate">
            {translate('office.panels.Header.title', 'Fleet Office')}
          </span>
          <span className="text-[10px] font-medium text-zinc-400 uppercase tracking-wider">
            {translate('office.panels.Header.liveOperations', 'Live operations')}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-3 text-[11px] font-medium">
        <span className="text-zinc-400">
          {live === 1
            ? translate('office.panels.Header.oneJob', '{{count}} job', { count: live })
            : translate('office.panels.Header.jobs', '{{count}} jobs', { count: live })}
        </span>
        <div className="w-px h-4 bg-zinc-200" />
        <span className="flex items-center gap-1.5">
          <span
            className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-zinc-300'}`}
          />
          <span className={connected ? 'text-emerald-600' : 'text-zinc-400'}>
            {connectionLabel(connected, ago)}
          </span>
        </span>
      </div>
    </header>
  )
}

export default Header
