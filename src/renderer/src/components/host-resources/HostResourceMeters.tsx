import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import {
  deriveHostResourceView,
  formatDetailGb,
  type HostResourceReading
} from '../../../../shared/host-resource-model'
import { useHostResourceClock } from './host-resource-poller'

function Meter({ label, value, warning }: { label: string; value: number; warning: boolean }) {
  return (
    <div className="space-y-1">
      <div className="text-xs tabular-nums text-muted-foreground">{label}</div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(Math.min(100, Math.max(0, value)))}
        className="h-1 rounded-full bg-muted overflow-hidden"
      >
        <div
          className={cn(
            'h-full rounded-full',
            warning ? 'bg-status-warning' : 'bg-muted-foreground'
          )}
          style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
        />
      </div>
    </div>
  )
}

export function HostResourceMeters({ reading }: { reading: HostResourceReading | null }) {
  const now = useHostResourceClock()
  const view = deriveHostResourceView(reading, now)
  if (!view || view.ageSeconds === null || view.ageSeconds > 90) {
    return (
      <span className="text-xs text-muted-foreground">
        {translate('computerPicker.resourcesUnavailable', 'Capacity unavailable')}
      </span>
    )
  }
  const usedMemory = view.totalBytes > 0 ? 100 * (1 - view.freeBytes / view.totalBytes) : 0
  return (
    <div className="w-full space-y-2" data-host-resource-meters={reading?.hostKey}>
      <Meter
        label={translate(
          'computerPicker.memory',
          'Memory: {{used}}% used · {{free}} / {{total}} GB available',
          {
            used: Math.round(usedMemory),
            free: formatDetailGb(view.freeGb),
            total: formatDetailGb(view.totalGb)
          }
        )}
        value={usedMemory}
        warning={usedMemory >= 85}
      />
      <Meter
        label={translate('computerPicker.cpu', 'CPU load {{load}}/core · {{cores}} cores', {
          load: view.loadPerCore.toFixed(2),
          cores: view.cpuCoreCount
        })}
        value={view.loadPerCore * 100}
        warning={view.band !== 'ok'}
      />
      <span className="text-xs text-muted-foreground">
        {view.liveSessions === null
          ? translate('computerPicker.sessionsUnknown', 'Live sessions unavailable')
          : translate('computerPicker.sessions', '{{count}} live sessions', {
              count: view.liveSessions
            })}
      </span>
    </div>
  )
}
