import type { FC } from 'react'
import { translate } from '@/i18n/i18n'
import type { UsageAccount, UsageWindow } from '../integration/fleet/fleetTypes'

const PROVIDER_COLOR: Record<string, string> = {
  claude: '#D97757',
  codex: '#10A37F',
  openai: '#10A37F',
  grok: '#64748B',
  gemini: '#4285F4'
}

function severityColor(sev?: string | null): string {
  switch ((sev || 'normal').toLowerCase()) {
    case 'critical':
      return '#ef4444'
    case 'warning':
      return '#f59e0b'
    default:
      return '#10b981'
  }
}

const UsageBar: FC<{ w: UsageWindow }> = ({ w }) => {
  const pct = Math.max(0, Math.min(100, Math.round(w.percent ?? 0)))
  const color = severityColor(w.severity)
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold text-zinc-500 truncate">
          {w.label || w.kind || translate('office.panels.projectView.usageWindow', 'Window')}
        </span>
        <span className="text-[10px] font-mono font-black" style={{ color }}>
          {translate('office.panels.projectView.usagePercent', '{{percent}}%', { percent: pct })}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-zinc-100 overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
    </div>
  )
}

export const ProviderCard: FC<{ account: UsageAccount }> = ({ account }) => {
  const provider = (account.provider || 'provider').toLowerCase()
  const color = PROVIDER_COLOR[provider] ?? '#71717a'
  const windows = account.windows ?? []
  return (
    <div className="bg-zinc-50 rounded-xl p-4 border border-zinc-100 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
          <span className="text-[11px] font-black uppercase tracking-widest text-darkDelegation truncate">
            {account.provider || translate('office.panels.projectView.unknownProvider', 'provider')}
          </span>
          {account.plan && (
            <span className="text-[9px] font-bold uppercase tracking-tight text-zinc-400 bg-white border border-zinc-100 rounded px-1.5 py-0.5">
              {account.plan}
            </span>
          )}
        </div>
        {account.stale && (
          <span className="text-[8px] font-black uppercase tracking-widest text-amber-500">
            {translate('office.panels.projectView.stale', 'stale')}
          </span>
        )}
      </div>

      {windows.length > 0 ? (
        <div className="flex flex-col gap-2.5">
          {windows.map((w) => (
            <UsageBar
              key={JSON.stringify([w.kind, w.scope_model, w.window_minutes, w.label])}
              w={w}
            />
          ))}
        </div>
      ) : (
        <p className="text-[10px] text-zinc-400 italic leading-relaxed">
          {account.reason ||
            translate(
              'office.panels.projectView.noUsageTelemetry',
              'No usage telemetry available.'
            )}
        </p>
      )}

      {account.provider_limit_state && (
        <div className="text-[9px] font-mono font-bold text-zinc-500 bg-white border border-zinc-100 rounded px-2 py-1">
          {account.provider_limit_state}
        </div>
      )}
    </div>
  )
}
