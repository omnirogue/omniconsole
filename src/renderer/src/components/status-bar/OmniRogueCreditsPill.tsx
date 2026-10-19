import React, { useCallback, useEffect, useState } from 'react'
import { Coins, ExternalLink, Plug, RefreshCw, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type {
  OmniRogueAccountState,
  OmniRogueCreditBalance
} from '../../../../shared/omnirogue-account'
import {
  OmniRoguePreviewToolButtons,
  OmniRoguePreviewToolPanels,
  type OmniRoguePreviewTool
} from './OmniRoguePreviewTools'

export type OmniRogueCreditsPillProps = {
  iconOnly?: boolean
}

function formatCreditsCount(value: number): string {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: value % 1 === 0 ? 0 : 2
  }).format(value)
}

export function OmniRogueCreditsPill({
  iconOnly = false
}: OmniRogueCreditsPillProps): React.ReactElement | null {
  const [account, setAccount] = useState<OmniRogueAccountState | null>(null)
  const [balance, setBalance] = useState<OmniRogueCreditBalance | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [linking, setLinking] = useState(false)
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [previewTool, setPreviewTool] = useState<OmniRoguePreviewTool | null>(null)
  const previewsEnabled = useAppStore(
    (state) => state.settings?.experimentalOmniSiPreviews === true
  )

  const creditsApi = typeof window !== 'undefined' ? window.api?.omnirogue?.credits : undefined
  const accountApi = typeof window !== 'undefined' ? window.api?.omnirogue?.account : undefined

  useEffect(() => {
    if (!creditsApi) {
      return
    }
    let disposed = false
    void creditsApi
      .getBalance()
      .then((initial) => {
        if (!disposed) {
          setBalance(initial)
        }
      })
      .catch(() => {})

    const unsubscribe = creditsApi.onBalanceChanged((next) => {
      if (!disposed) {
        setBalance(next)
      }
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [creditsApi])

  useEffect(() => {
    if (!accountApi) {
      return
    }
    let disposed = false
    void accountApi
      .getStatus()
      .then((initial) => {
        if (!disposed) {
          setAccount(initial)
        }
      })
      .catch(() => {})

    const unsubscribe = accountApi.onStatusChanged((next) => {
      if (!disposed) {
        setAccount(next)
        if (next.state === 'linked') {
          void creditsApi?.refreshBalance().catch(() => {})
        }
      }
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [accountApi, creditsApi])

  const handleRefresh = useCallback(async () => {
    if (!creditsApi || refreshing) {
      return
    }
    setRefreshing(true)
    try {
      const next = await creditsApi.refreshBalance()
      setBalance(next)
    } finally {
      setRefreshing(false)
    }
  }, [creditsApi, refreshing])

  const handleTopUp = useCallback(async () => {
    await creditsApi?.openTopUp()
  }, [creditsApi])

  const handleConnect = useCallback(async () => {
    if (!accountApi || linking) {
      return
    }
    setLinking(true)
    try {
      const next = await accountApi.link()
      setAccount(next)
      if (next.state === 'linked') {
        const updated = await creditsApi?.refreshBalance()
        if (updated !== undefined) {
          setBalance(updated)
        }
      }
    } finally {
      setLinking(false)
    }
  }, [accountApi, creditsApi, linking])

  if (!creditsApi) {
    return null
  }

  const isLinked = account?.state === 'linked' || balance !== null
  const threshold = balance?.lowBalanceThreshold ?? 100
  const isLowBalance = balance !== null && balance.availableCredits <= threshold

  const pillLabel =
    balance !== null
      ? `${formatCreditsCount(balance.availableCredits)} cr`
      : isLinked
        ? translate('omnirogueCredits.title', 'OmniRogue Credits')
        : translate('omnirogueCredits.connect', 'Connect OmniRogue')

  const openPreviewTool = (tool: OmniRoguePreviewTool) => {
    setPopoverOpen(false)
    setPreviewTool(tool)
  }

  return (
    <>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="omnirogue-credits-pill"
            aria-label={pillLabel}
            className={`inline-flex h-5 cursor-pointer items-center gap-1.5 rounded px-1.5 text-[11px] font-medium transition-colors ${
              isLowBalance
                ? 'bg-amber-500/15 text-amber-400 hover:bg-amber-500/25'
                : isLinked
                  ? 'bg-primary/10 text-foreground hover:bg-accent/80'
                  : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground'
            }`}
          >
            <Coins className="size-3 shrink-0 text-primary" />
            {iconOnly ? null : <span className="max-w-[18ch] truncate">{pillLabel}</span>}
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="end" sideOffset={6} className="w-72 p-3">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <Sparkles className="size-3.5 text-primary" />
                <span className="text-xs font-semibold">
                  {translate('omnirogueCredits.title', 'OmniRogue Credits')}
                </span>
              </div>
              {balance?.plan ? (
                <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                  {balance.plan}
                </span>
              ) : null}
            </div>

            {isLinked ? (
              <>
                <div className="rounded-md border bg-muted/40 p-2.5">
                  <div className="text-[11px] text-muted-foreground">
                    {translate('omnirogueCredits.spendableCredits', 'Spendable Credits')}
                  </div>
                  <div className="mt-0.5 flex items-baseline justify-between gap-2">
                    <span
                      className={`text-lg font-semibold tabular-nums ${
                        isLowBalance ? 'text-amber-400' : 'text-foreground'
                      }`}
                      data-testid="omnirogue-credits-balance-value"
                    >
                      {balance !== null ? formatCreditsCount(balance.availableCredits) : '—'}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {balance?.currency ?? translate('omnirogueCredits.currency', 'credits')}
                    </span>
                  </div>
                  {isLowBalance ? (
                    <p className="mt-1 text-[11px] text-amber-400">
                      {translate('omnirogueCredits.lowBalance', 'Low credit balance')}
                    </p>
                  ) : null}
                </div>

                <div className="flex items-center justify-between rounded-md border border-primary/20 bg-primary/5 px-2.5 py-1.5 text-[11px]">
                  <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                    <Plug className="size-3 text-primary" />
                    {translate('omnirogueCredits.unifiedMcp', 'Unified MCP')}
                  </span>
                  <span className="font-medium text-primary">
                    {translate('omnirogueCredits.unifiedMcpActive', 'Auto-Provisioned')}
                  </span>
                </div>

                {previewsEnabled ? <OmniRoguePreviewToolButtons onOpen={openPreviewTool} /> : null}

                <div className="flex items-center gap-2 pt-0.5">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 flex-1 gap-1.5 text-xs"
                    disabled={refreshing}
                    onClick={() => void handleRefresh()}
                  >
                    <RefreshCw className={`size-3 ${refreshing ? 'animate-spin' : ''}`} />
                    {translate('omnirogueCredits.refresh', 'Refresh')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 flex-1 gap-1.5 text-xs"
                    onClick={() => void handleTopUp()}
                  >
                    {translate('omnirogueCredits.topUp', 'Top Up Credits')}
                    <ExternalLink className="size-3" />
                  </Button>
                </div>
              </>
            ) : (
              <div className="space-y-2.5">
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {translate(
                    'omnirogueCredits.connectSubtitle',
                    'Link your OmniRogue account for Unified Credits, Creative Generation, Evolve, Discover & Decisions.'
                  )}
                </p>
                <Button
                  type="button"
                  size="sm"
                  className="h-7 w-full text-xs"
                  disabled={linking}
                  onClick={() => void handleConnect()}
                >
                  {translate('omnirogueCredits.connect', 'Connect OmniRogue')}
                </Button>
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
      {previewsEnabled ? (
        <OmniRoguePreviewToolPanels tool={previewTool} onClose={() => setPreviewTool(null)} />
      ) : null}
    </>
  )
}
