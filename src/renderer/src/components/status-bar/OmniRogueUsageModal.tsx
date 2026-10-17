import React, { useCallback, useMemo } from 'react'
import { AlertTriangle, BarChart3, Cpu, Download, Layers, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { translate } from '@/i18n/i18n'
import type { OmniRogueCreditBalance } from '../../../../shared/omnirogue-account'
import {
  buildOmniRogueUsageCsv,
  buildOmniRogueUsageCsvFilename,
  formatOmniRogueCredits,
  formatOmniRogueShare,
  resolveOmniRogueLowBalance,
  summarizeOmniRogueUsage,
  type OmniRogueCacheSavings,
  type OmniRogueLowBalanceState,
  type OmniRogueUsageCapability,
  type OmniRogueUsageBreakdownRow,
  type OmniRogueUsageEntry
} from './omnirogue-usage-helpers'

const CAPABILITY_I18N_KEYS: Record<OmniRogueUsageCapability, string> = {
  'llm-gateway': 'omnirogueUsage.capability.llmGateway',
  'media-generation': 'omnirogueUsage.capability.mediaGeneration',
  'hosted-evolve-si': 'omnirogueUsage.capability.hostedEvolveSi',
  'discover-si': 'omnirogueUsage.capability.discoverSi'
}

export type OmniRogueUsageModalProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  entries: readonly OmniRogueUsageEntry[]
  balance?: OmniRogueCreditBalance | null
  /** Overrides the account's own low-balance threshold. */
  lowBalanceThreshold?: number
  periodLabel?: string
  loading?: boolean
  /** Receives the receipt instead of the default browser download. */
  onExportCsv?: (csv: string, filename: string) => void
  onTopUp?: () => void
  now?: () => Date
}

function UsageBreakdownList({
  rows,
  testId
}: {
  rows: readonly OmniRogueUsageBreakdownRow[]
  testId: string
}): React.ReactElement {
  return (
    <ul className="space-y-2">
      {rows.map((row) => {
        const percent = formatOmniRogueShare(row.share)
        return (
          <li key={row.key} data-testid={testId} data-key={row.key} className="space-y-1">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="truncate font-medium text-foreground">{row.label}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                <span data-testid={`${testId}-credits`} className="text-foreground">
                  {translate('omnirogueUsage.creditsAmount', '{{credits}} cr', {
                    credits: formatOmniRogueCredits(row.credits)
                  })}
                </span>
                <span className="mx-1.5 text-muted-foreground/60">·</span>
                <span data-testid={`${testId}-share`}>{percent}</span>
              </span>
            </div>
            <Progress
              value={Math.min(100, Math.max(0, row.share * 100))}
              aria-label={`${row.label} ${percent}`}
              className="h-1.5 bg-primary/15"
            />
          </li>
        )
      })}
    </ul>
  )
}

function UsageSection({
  icon,
  title,
  children
}: {
  icon: React.ReactNode
  title: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <section className="space-y-2.5 rounded-md border bg-muted/30 p-3">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  )
}

function CacheSavingsBadge({ cache }: { cache: OmniRogueCacheSavings }): React.ReactElement {
  const ratio = cache.hitRatio === null ? '—' : formatOmniRogueShare(cache.hitRatio)
  return (
    <div
      data-testid="omnirogue-usage-cache-badge"
      className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-500"
    >
      <Zap className="size-3 shrink-0" />
      <span data-testid="omnirogue-usage-cache-saved">
        {translate('omnirogueUsage.cacheSaved', 'Saved {{credits}} cr', {
          credits: formatOmniRogueCredits(cache.savedCredits)
        })}
      </span>
      <span className="text-emerald-500/60">·</span>
      <span data-testid="omnirogue-usage-cache-ratio">
        {translate('omnirogueUsage.cacheHitRatio', '{{ratio}} cache hits', { ratio })}
      </span>
    </div>
  )
}

function LowBalanceBanner({
  state,
  onTopUp
}: {
  state: OmniRogueLowBalanceState
  onTopUp?: () => void
}): React.ReactElement {
  return (
    <div
      role="alert"
      data-testid="omnirogue-usage-low-balance"
      className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5 text-[11px] text-amber-400"
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="font-semibold">
          {translate('omnirogueUsage.lowBalanceTitle', 'Low credit balance')}
        </p>
        <p className="leading-relaxed">
          {translate(
            'omnirogueUsage.lowBalanceBody',
            '{{available}} spendable credits left. You are warned at {{threshold}} credits or fewer.',
            {
              available: formatOmniRogueCredits(state.availableCredits),
              threshold: formatOmniRogueCredits(state.threshold)
            }
          )}
        </p>
      </div>
      {onTopUp ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-6 shrink-0 border-amber-500/40 px-2 text-[11px] text-amber-400 hover:bg-amber-500/15"
          onClick={onTopUp}
        >
          {translate('omnirogueUsage.topUp', 'Top Up')}
        </Button>
      ) : null}
    </div>
  )
}

function defaultNow(): Date {
  return new Date()
}

function downloadOmniRogueUsageCsv(csv: string, filename: string): void {
  // BOM so Excel decodes non-ASCII descriptions as UTF-8.
  const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

export function OmniRogueUsageModal({
  open,
  onOpenChange,
  entries,
  balance,
  lowBalanceThreshold,
  periodLabel,
  loading = false,
  onExportCsv,
  onTopUp,
  now = defaultNow
}: OmniRogueUsageModalProps): React.ReactElement {
  const summary = useMemo(() => summarizeOmniRogueUsage(entries), [entries])
  const lowBalance = resolveOmniRogueLowBalance(balance, lowBalanceThreshold)
  // Not memoized: labels must follow a UI-language switch while the modal is open.
  const capabilityRows = summary.byCapability.map((row) => ({
    ...row,
    label: translate(CAPABILITY_I18N_KEYS[row.key], row.label)
  }))
  const hasEntries = entries.length > 0

  const handleExport = useCallback(() => {
    const csv = buildOmniRogueUsageCsv(entries)
    const filename = buildOmniRogueUsageCsvFilename(now())
    if (onExportCsv) {
      onExportCsv(csv, filename)
    } else {
      downloadOmniRogueUsageCsv(csv, filename)
    }
  }, [entries, now, onExportCsv])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="omnirogue-usage-modal"
        className="scrollbar-sleek max-h-[85vh] gap-3 overflow-y-auto sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <BarChart3 className="size-4 text-primary" />
            {translate('omnirogueUsage.title', 'OmniRogue Usage')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {periodLabel
              ? translate('omnirogueUsage.descriptionPeriod', 'Credit spend for {{period}}', {
                  period: periodLabel
                })
              : translate('omnirogueUsage.description', 'Credit spend by capability and model')}
          </DialogDescription>
        </DialogHeader>

        {lowBalance?.isLow ? <LowBalanceBanner state={lowBalance} onTopUp={onTopUp} /> : null}

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 p-3">
          <div>
            <div className="text-[11px] text-muted-foreground">
              {translate('omnirogueUsage.totalSpent', 'Credits spent')}
            </div>
            <div
              data-testid="omnirogue-usage-total"
              className="text-lg font-semibold tabular-nums text-foreground"
            >
              {loading ? '—' : formatOmniRogueCredits(summary.totalCredits)}
            </div>
          </div>
          {loading ? null : <CacheSavingsBadge cache={summary.cache} />}
        </div>

        {loading ? (
          <p
            data-testid="omnirogue-usage-loading"
            className="py-4 text-center text-xs text-muted-foreground"
          >
            {translate('omnirogueUsage.loading', 'Loading usage…')}
          </p>
        ) : !hasEntries ? (
          <p
            data-testid="omnirogue-usage-empty"
            className="py-4 text-center text-xs text-muted-foreground"
          >
            {translate('omnirogueUsage.empty', 'No credit usage in this period yet.')}
          </p>
        ) : (
          <>
            <UsageSection
              icon={<Layers className="size-3.5 text-primary" />}
              title={translate('omnirogueUsage.byCapability', 'Spend by capability')}
            >
              <UsageBreakdownList rows={capabilityRows} testId="omnirogue-usage-capability-row" />
            </UsageSection>
            <UsageSection
              icon={<Cpu className="size-3.5 text-primary" />}
              title={translate('omnirogueUsage.byModel', 'Spend by model')}
            >
              {summary.byModel.length > 0 ? (
                <UsageBreakdownList rows={summary.byModel} testId="omnirogue-usage-model-row" />
              ) : (
                <p className="text-xs text-muted-foreground">
                  {translate('omnirogueUsage.byModelEmpty', 'No model-billed usage yet.')}
                </p>
              )}
            </UsageSection>
          </>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={() => onOpenChange(false)}
          >
            {translate('omnirogueUsage.close', 'Close')}
          </Button>
          <Button
            type="button"
            size="sm"
            data-testid="omnirogue-usage-export"
            className="h-7 gap-1.5 text-xs"
            disabled={loading || !hasEntries}
            onClick={handleExport}
          >
            <Download className="size-3" />
            {translate('omnirogueUsage.exportCsv', 'Export CSV receipt')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
