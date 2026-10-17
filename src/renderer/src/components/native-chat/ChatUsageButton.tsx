import { useMemo, useState } from 'react'
import { BatteryFull, BatteryLow, BatteryMedium, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useHoverOpenPopover } from '@/components/next-step/use-hover-open-popover'
import { getTightestUsageSection, UsageRow } from '@/components/status-bar/UsageRosterPanel'
import { getProviderDisplayName } from '@/components/status-bar/usage-error-copy'
import { getUsageRosterRowState } from '@/components/status-bar/usage-roster-row-state'
import { getWindowSections } from '@/components/status-bar/tooltip'
import { useUsageProviders } from '@/components/status-bar/use-usage-providers'
import { useResetCountdownClock } from '@/hooks/useResetCountdownClock'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import type { AgentType } from '../../../../shared/agent-status-types'
import {
  clampUsedPercent,
  getDisplayedUsagePercentage
} from '../../../../shared/usage-percentage-display'

type Level = 'fine' | 'warn' | 'critical' | 'unknown'

/** The same thresholds the status-bar bars use: under 60 % used is fine, 80 % is critical. */
export function usageLevel(usedPercent: number | null): Level {
  if (usedPercent === null) {
    return 'unknown'
  }
  if (usedPercent >= 80) {
    return 'critical'
  }
  if (usedPercent >= 60) {
    return 'warn'
  }
  return 'fine'
}

const ICON_CLASS: Record<Level, string> = {
  fine: 'text-muted-foreground',
  warn: 'text-status-warning',
  critical: 'text-destructive',
  unknown: 'text-muted-foreground'
}
const ACCENT_CLASS: Record<Level, string> = {
  fine: 'border-l-border',
  warn: 'border-l-status-warning bg-status-warning-background',
  critical: 'border-l-destructive bg-destructive/5',
  unknown: 'border-l-border bg-muted/30'
}

function BatteryIcon({ level, className }: { level: Level; className?: string }) {
  const Icon = level === 'critical' ? BatteryLow : level === 'warn' ? BatteryMedium : BatteryFull
  return <Icon className={cn('size-4', ICON_CLASS[level], className)} />
}

/** The most-used window of a provider as a used percentage, or null without data. */
function worstUsed(provider: ProviderRateLimits): number | null {
  const tightest = getTightestUsageSection(provider)
  return tightest ? clampUsedPercent(tightest.window.usedPercent) : null
}

/** The current chat's provider stays visible; hover reveals the full account roster. */
export function ChatUsageButton({ agent }: { agent?: AgentType }): React.JSX.Element {
  const { providers, display, refresh, isRefreshing } = useUsageProviders(agent)
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  const [open, setOpen] = useState(false)
  const [refreshFailed, setRefreshFailed] = useState(false)
  const hover = useHoverOpenPopover({ open, onOpenChange: setOpen })
  const rows = useMemo(
    () =>
      [...providers]
        .map((provider) => ({ provider, used: worstUsed(provider) }))
        .sort(
          (a, b) =>
            Number(b.provider.provider === agent) - Number(a.provider.provider === agent) ||
            (b.used ?? -1) - (a.used ?? -1)
        ),
    [agent, providers]
  )
  const now = useResetCountdownClock(
    open
      ? providers.flatMap((provider) =>
          getWindowSections(provider).map((section) => section.window?.resetsAt ?? null)
        )
      : []
  )
  const active = rows.find((row) => row.provider.provider === agent)
  const unavailable =
    refreshFailed ||
    active?.provider.status === 'error' ||
    active?.provider.status === 'unavailable'
  const used = unavailable ? null : (active?.used ?? null)
  const level = usageLevel(used)
  const label = translate('chatUsage.label', 'Usage')
  const failedLabel = translate('auto.components.status.bar.tooltip.e740f92596', 'Refresh failed')
  const status = refreshFailed
    ? failedLabel
    : active
      ? getUsageRosterRowState(active.provider, false).statusLabel
      : translate(
          'auto.components.status.bar.UsageRosterPanel.usageUnavailable',
          'Usage unavailable'
        )
  const summary =
    active && used !== null
      ? translate('chatUsage.summary', '{{name}} · {{percent}}% {{kind}}', {
          name: getProviderDisplayName(active.provider.provider),
          percent: getDisplayedUsagePercentage(used, display),
          kind:
            display === 'remaining'
              ? translate('chatUsage.left', 'left')
              : translate('chatUsage.used', 'used')
        })
      : translate('chatUsage.providerStatus', '{{name}} · {{status}}', {
          name: getProviderDisplayName(agent || label),
          status
        })
  const refreshUsage = async (): Promise<void> => {
    setRefreshFailed(false)
    try {
      await refresh()
    } catch {
      setRefreshFailed(true)
    }
  }
  const openDetails = (): void => {
    hover.onOpenChange(false)
    openSettingsTarget({ pane: 'stats', repoId: null })
    openSettingsPage()
  }
  const openAccounts = (): void => {
    hover.onOpenChange(false)
    openSettingsTarget({ pane: 'accounts', repoId: null })
    openSettingsPage()
  }
  return (
    <Popover open={open} onOpenChange={hover.onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`${label} · ${summary}`}
          data-chat-usage
          data-chat-usage-level={level}
          className="min-w-0 max-w-56 shrink gap-1.5 px-2 text-xs pointer-coarse:h-11"
          {...hover.anchorProps}
          onClick={(event) => {
            event.preventDefault()
            hover.anchorProps.onClick()
          }}
        >
          <BatteryIcon level={level} />
          <span className="truncate tabular-nums">{summary}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        {...hover.contentProps}
        side="top"
        align="start"
        className="w-[min(380px,calc(100vw-1rem))] p-0"
        data-chat-usage-panel
      >
        <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
          <BatteryIcon level={level} />
          <span className="text-sm font-medium">{label}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{summary}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={translate('chatUsage.refresh', 'Refresh usage')}
            disabled={isRefreshing}
            onClick={() => void refreshUsage()}
          >
            <RefreshCw className={cn('size-3.5', isRefreshing && 'animate-spin')} />
          </Button>
        </div>
        {refreshFailed ? (
          <p role="alert" className="px-3 pt-2 text-xs text-destructive">
            {translate('chatUsage.refreshFailed', 'Unable to refresh usage. Try again.')}
          </p>
        ) : null}
        {rows.length === 0 ? (
          <div className="space-y-2 px-3 py-3 text-xs text-muted-foreground">
            <p>{translate('chatUsage.empty', 'No model accounts are set up yet.')}</p>
            <Button type="button" variant="outline" size="sm" onClick={openAccounts}>
              {translate('chatUsage.setUp', 'Set up accounts')}
            </Button>
          </div>
        ) : (
          <ul
            className="scrollbar-sleek max-h-[60vh] space-y-1.5 overflow-y-auto p-2"
            data-chat-usage-rows
          >
            {rows.map(({ provider, used }) => {
              const stale =
                refreshFailed || provider.status === 'error' || provider.status === 'unavailable'
              const rowLevel = usageLevel(stale ? null : used)
              return (
                <li
                  key={provider.provider}
                  data-chat-usage-provider={provider.provider}
                  data-chat-usage-level={rowLevel}
                  className={cn(
                    'rounded-md border border-border/60 border-l-4 px-2.5 py-2',
                    ACCENT_CLASS[rowLevel]
                  )}
                >
                  <UsageRow
                    p={provider}
                    display={display}
                    state={getUsageRosterRowState(provider, used !== null)}
                    showSignInAction={false}
                    now={now}
                    mode="verbose"
                  />
                  {stale && used !== null ? (
                    <p className="pl-[30px] pt-1 text-xs text-status-warning">
                      {translate('chatUsage.lastKnown', 'Last known usage · {{status}}', {
                        status: refreshFailed
                          ? failedLabel
                          : getUsageRosterRowState(provider, false).statusLabel
                      })}
                    </p>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
        <div className="flex items-center justify-end border-t border-border/60 px-2 py-1.5">
          <Button type="button" variant="ghost" size="xs" onClick={openDetails}>
            {translate('chatUsage.details', 'All usage details')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
