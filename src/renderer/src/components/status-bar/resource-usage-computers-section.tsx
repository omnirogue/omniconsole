import React from 'react'
import { Server } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { HostResourceBadge } from '../host-resources/HostResourceBadge'
import { useHostResourceReadings } from '../host-resources/host-resource-poller'
import { useSidebarHostScopeOptions } from '../sidebar/use-sidebar-host-scope-options'

const isConnected = (health: string): boolean => health === 'local' || health === 'available'

/** One row per computer (this Mac first), with the same badge the sidebar host headers show. */
export function ResourceUsageComputersSection(): React.JSX.Element | null {
  const { hostOptions } = useSidebarHostScopeOptions()
  const readings = useHostResourceReadings(
    hostOptions.filter((host) => isConnected(host.health)).map((host) => host.id)
  )
  if (hostOptions.length === 0) {
    return null
  }
  return (
    <div className="border-b border-border/50 px-3 py-1.5" data-resource-computers="">
      <div className="pb-1 text-[10px] uppercase tracking-wide text-muted-foreground/80">
        {translate('hostResources.computersTitle', 'Computers')}
      </div>
      <ul className="space-y-0.5">
        {hostOptions.map((host) => (
          <li key={host.id} className="flex min-w-0 items-center gap-1.5 text-[11px]">
            <Server className="size-3 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-foreground">{host.label}</span>
            {isConnected(host.health) ? (
              <HostResourceBadge reading={readings.get(host.id) ?? null} />
            ) : (
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {translate('hostResources.notConnected', 'Not connected')}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
