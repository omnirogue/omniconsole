import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, ChevronDown, Cpu, Sparkles, Terminal, Zap } from 'lucide-react'
import { useAppStore } from '@/store'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { sendRuntimePtyInput } from '@/runtime/runtime-terminal-inspection'
import { selectTerminalTabAgentTypesByLeaf } from '../terminal-pane/terminal-tab-agent-type-index'
import {
  OMNIROGUE_GATEWAY_MODELS,
  type OmniRogueBillingMode,
  type OmniRogueGatewayModelOption,
  type OmniRogueGatewaySession
} from '../../../../shared/omnirogue-account'
import { isTuiAgent, type TuiAgent } from '../../../../shared/tui-agent'

type ModelSwitcherDropdownProps = {
  worktreeId: string
  groupId: string
}

type StatusFeedback = {
  kind: 'live-slash' | 'next-session' | 'billing-restart'
  message: string
}

export function ModelSwitcherDropdown({
  worktreeId,
  groupId
}: ModelSwitcherDropdownProps): React.JSX.Element | null {
  const activeTerminalTabId = useAppStore((s) => {
    const group = s.groupsByWorktree[worktreeId]?.find((g) => g.id === groupId)
    const groupActiveTabId = group?.activeTabId ?? null
    if (groupActiveTabId) {
      const tab = s.unifiedTabsByWorktree[worktreeId]?.find((t) => t.id === groupActiveTabId)
      if (tab) {
        return tab.contentType === 'terminal' ? tab.entityId : null
      }
    }
    return s.activeTabIdByWorktree[worktreeId] ?? null
  })

  const activePtyId = useAppStore((s) => {
    if (!activeTerminalTabId) {
      return null
    }
    const layout = s.terminalLayoutsByTabId[activeTerminalTabId]
    if (layout?.activeLeafId && layout.ptyIdsByLeafId?.[layout.activeLeafId]) {
      return layout.ptyIdsByLeafId[layout.activeLeafId] ?? null
    }
    const firstLeafPty = layout?.ptyIdsByLeafId
      ? Object.values(layout.ptyIdsByLeafId).find((id) => Boolean(id))
      : null
    if (firstLeafPty) {
      return firstLeafPty
    }
    const fromTabList = s.ptyIdsByTabId[activeTerminalTabId]?.[0] ?? null
    if (fromTabList) {
      return fromTabList
    }
    const tab = s.tabsByWorktree[worktreeId]?.find((t) => t.id === activeTerminalTabId)
    return tab?.ptyId ?? null
  })

  const detectedPaneAgent = useAppStore((s): TuiAgent | null => {
    if (!activeTerminalTabId) {
      return null
    }
    const byLeaf = selectTerminalTabAgentTypesByLeaf(
      s.agentStatusByPaneKey,
      activeTerminalTabId,
      s.paneForegroundAgentByPaneKey
    )
    const activeLeafId = s.terminalLayoutsByTabId[activeTerminalTabId]?.activeLeafId
    if (activeLeafId) {
      const leafAgent = byLeaf[activeLeafId]
      if (isTuiAgent(leafAgent)) {
        return leafAgent
      }
    }
    for (const candidate of Object.values(byLeaf)) {
      if (isTuiAgent(candidate)) {
        return candidate
      }
    }
    const tab = s.tabsByWorktree[worktreeId]?.find((t) => t.id === activeTerminalTabId)
    return tab?.launchAgent ?? null
  })

  const storePrimaryAgent = useAppStore((s) => s.settings?.primaryAi?.agent ?? null)
  const storePrimaryModel = useAppStore((s) => s.settings?.primaryAi?.model ?? null)
  const storePrimaryBilling = useAppStore((s) => s.settings?.primaryAi?.billing ?? null)

  const [gatewaySession, setGatewaySession] = useState<OmniRogueGatewaySession | null>(null)
  const [feedback, setFeedback] = useState<StatusFeedback | null>(null)

  const refreshGatewaySession = useCallback(() => {
    const gatewayApi = window.api?.omnirogue?.gateway
    if (!gatewayApi?.getSession) {
      return
    }
    void gatewayApi
      .getSession()
      .then((session) => {
        setGatewaySession(session)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    refreshGatewaySession()
    const gatewayApi = window.api?.omnirogue?.gateway
    if (!gatewayApi?.onSessionChanged) {
      return
    }
    return gatewayApi.onSessionChanged((session) => {
      setGatewaySession(session)
    })
  }, [refreshGatewaySession])

  const models: readonly OmniRogueGatewayModelOption[] = useMemo(
    () => gatewaySession?.availableModels ?? OMNIROGUE_GATEWAY_MODELS,
    [gatewaySession?.availableModels]
  )

  const effectiveBilling: OmniRogueBillingMode =
    // Why: never assume credits billing before the main process answers; picking a model must not
    // silently opt an own-login user into gateway routing (which also disables account auth stripping).
    gatewaySession?.billing ?? storePrimaryBilling ?? 'own-login'

  const effectiveModelId =
    gatewaySession?.model ?? storePrimaryModel ?? OMNIROGUE_GATEWAY_MODELS[0].id

  const effectiveAgent: TuiAgent =
    detectedPaneAgent ?? gatewaySession?.agent ?? storePrimaryAgent ?? 'claude'

  const activeModelOption = useMemo(
    () => models.find((option) => option.id === effectiveModelId) ?? null,
    [models, effectiveModelId]
  )

  const hasLiveTuiSession = Boolean(activePtyId && detectedPaneAgent)

  const dispatchSlashModelCommand = useCallback(
    (modelId: string): boolean => {
      if (!activePtyId) {
        return false
      }
      const currentSettings = useAppStore.getState().settings
      return sendRuntimePtyInput(currentSettings, activePtyId, `/model ${modelId}\r`)
    },
    [activePtyId]
  )

  const handleSelectModel = useCallback(
    async (option: OmniRogueGatewayModelOption): Promise<void> => {
      const targetAgent: TuiAgent =
        detectedPaneAgent ?? option.defaultAgent ?? option.recommendedAgents[0] ?? effectiveAgent
      const sentLive =
        hasLiveTuiSession && option.supportsSlashModel
          ? dispatchSlashModelCommand(option.id)
          : false

      useAppStore.getState().updateSettings({
        primaryAi: {
          agent: targetAgent,
          billing: effectiveBilling,
          model: option.id
        }
      })

      try {
        const nextSession = await window.api?.omnirogue?.gateway?.switchModel?.({
          agent: targetAgent,
          model: option.id,
          billing: effectiveBilling,
          ptyId: sentLive && activePtyId ? activePtyId : undefined
        })
        if (nextSession) {
          setGatewaySession(nextSession)
        }
      } catch {
        // Renderer settings update already persisted via store.updateSettings
      }

      setFeedback({
        kind: sentLive ? 'live-slash' : 'next-session',
        message: sentLive
          ? translate('modelSwitcher.sentSlashModelNotice', 'Sent /model {{model}} to active session', {
              model: option.id
            })
          : translate('modelSwitcher.savedNextSessionNotice', 'Saved {{model}} for next session', {
              model: option.label
            })
      })
    },
    [activePtyId, detectedPaneAgent, dispatchSlashModelCommand, effectiveAgent, effectiveBilling, hasLiveTuiSession]
  )

  const handleSelectBilling = useCallback(
    async (nextBilling: string): Promise<void> => {
      const normalizedBilling: OmniRogueBillingMode =
        nextBilling === 'own-login' ? 'own-login' : 'omnirogue-credits'
      if (normalizedBilling === effectiveBilling) {
        return
      }

      useAppStore.getState().updateSettings({
        primaryAi: {
          agent: effectiveAgent,
          billing: normalizedBilling,
          model: effectiveModelId
        }
      })

      try {
        const nextSession = await window.api?.omnirogue?.gateway?.setBillingMode?.({
          billing: normalizedBilling
        })
        if (nextSession) {
          setGatewaySession(nextSession)
        }
      } catch {
        // Renderer settings update already persisted via store.updateSettings
      }

      setFeedback({
        kind: 'billing-restart',
        message: translate(
          'modelSwitcher.billingRestartNotice',
          'Billing & gateway URL changes apply on next CLI session launch'
        )
      })
    },
    [effectiveAgent, effectiveBilling, effectiveModelId]
  )

  if (!activeTerminalTabId) {
    return null
  }

  const buttonLabel = activeModelOption?.label ?? effectiveModelId
  const isGatewayMode = effectiveBilling === 'omnirogue-credits'

  return (
    <DropdownMenu onOpenChange={(open) => open && refreshGatewaySession()}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-testid="terminal-model-switcher-trigger"
              className="my-auto flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              aria-label={translate('modelSwitcher.title', 'Switch model')}
            >
              {isGatewayMode ? (
                <Sparkles className="size-3.5 text-amber-500 dark:text-amber-400" />
              ) : (
                <Cpu className="size-3.5" />
              )}
              <span className="max-w-[132px] truncate text-[12px] font-medium text-foreground/90">
                {buttonLabel}
              </span>
              <span
                className={
                  isGatewayMode
                    ? 'rounded bg-amber-500/15 px-1 py-0.5 text-[10px] font-medium leading-none text-amber-600 dark:text-amber-300'
                    : 'rounded bg-muted px-1 py-0.5 text-[10px] font-medium leading-none text-muted-foreground'
                }
              >
                {isGatewayMode
                  ? translate('modelSwitcher.gatewayBadge', 'Gateway')
                  : translate('modelSwitcher.ownLoginBadge', 'Own Login')}
              </span>
              <ChevronDown className="size-3 opacity-70" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {translate('modelSwitcher.tooltip', 'Switch active CLI model or billing source')}
        </TooltipContent>
      </Tooltip>

      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="flex items-center justify-between">
          <span>{translate('modelSwitcher.billingSectionLabel', 'Billing & Routing')}</span>
          {isGatewayMode ? (
            <span className="text-[10px] font-normal text-muted-foreground">
              {gatewaySession?.tokenAvailable
                ? translate('modelSwitcher.tokenReady', 'obp_ token ready')
                : translate('modelSwitcher.tokenMissing', 'Sign in to OmniRogue for gateway routing')}
            </span>
          ) : null}
        </DropdownMenuLabel>

        <DropdownMenuRadioGroup value={effectiveBilling} onValueChange={handleSelectBilling}>
          <DropdownMenuRadioItem
            value="omnirogue-credits"
            onSelect={(e) => e.preventDefault()}
            className="flex flex-col items-start gap-0.5 py-1.5"
          >
            <div className="flex w-full items-center gap-1.5 font-medium">
              <Zap className="size-3.5 text-amber-500 dark:text-amber-400" />
              <span>
                {translate(
                  'modelSwitcher.omnirogueCreditsLabel',
                  'OmniRogue Credits (Unified Gateway)'
                )}
              </span>
            </div>
            <span className="text-[11px] font-normal text-muted-foreground">
              {translate(
                'modelSwitcher.omnirogueCreditsDescription',
                'Routes CLI traffic via api.omnirogue.com using your obp_ key'
              )}
            </span>
          </DropdownMenuRadioItem>

          <DropdownMenuRadioItem
            value="own-login"
            onSelect={(e) => e.preventDefault()}
            className="flex flex-col items-start gap-0.5 py-1.5"
          >
            <div className="flex w-full items-center gap-1.5 font-medium">
              <Terminal className="size-3.5 text-muted-foreground" />
              <span>{translate('modelSwitcher.ownLoginLabel', 'Own CLI Login')}</span>
            </div>
            <span className="text-[11px] font-normal text-muted-foreground">
              {translate(
                'modelSwitcher.ownLoginDescription',
                'Uses your local CLI subscription or API login directly'
              )}
            </span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />

        <DropdownMenuLabel className="flex items-center justify-between">
          <span>{translate('modelSwitcher.modelsSectionLabel', 'Models')}</span>
          <span className="text-[10px] font-normal text-muted-foreground">
            {hasLiveTuiSession
              ? translate(
                  'modelSwitcher.liveSessionHint',
                  'Active session ({{agent}}): selecting a model sends /model immediately',
                  { agent: detectedPaneAgent ?? effectiveAgent }
                )
              : translate(
                  'modelSwitcher.nextSessionHint',
                  'No active TUI detected: selection applies to next session'
                )}
          </span>
        </DropdownMenuLabel>

        {models.map((option) => {
          const isSelected = option.id === effectiveModelId
          return (
            <DropdownMenuItem
              key={option.id}
              onSelect={() => void handleSelectModel(option)}
              className="flex items-center justify-between gap-2 py-1.5"
            >
              <div className="flex min-w-0 flex-col">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-medium">{option.label}</span>
                  <span className="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
                    {option.id}
                  </span>
                </div>
                <span className="truncate text-[11px] text-muted-foreground">
                  {option.description}
                </span>
              </div>
              {isSelected ? <Check className="size-3.5 shrink-0 text-foreground" /> : null}
            </DropdownMenuItem>
          )
        })}

        {activePtyId && !hasLiveTuiSession ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                const sent = dispatchSlashModelCommand(effectiveModelId)
                if (sent) {
                  setFeedback({
                    kind: 'live-slash',
                    message: translate(
                      'modelSwitcher.sentSlashModelNotice',
                      'Sent /model {{model}} to active session',
                      { model: effectiveModelId }
                    )
                  })
                }
              }}
              className="text-[11px] text-muted-foreground"
            >
              <Terminal className="size-3.5" />
              <span>
                {translate(
                  'modelSwitcher.sendSlashCommandNow',
                  'Send /model {{model}} to terminal now',
                  { model: effectiveModelId }
                )}
              </span>
            </DropdownMenuItem>
          </>
        ) : null}

        {feedback ? (
          <>
            <DropdownMenuSeparator />
            <div
              className={
                feedback.kind === 'billing-restart'
                  ? 'rounded-md bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-300'
                  : 'rounded-md bg-muted/60 px-2 py-1.5 text-[11px] text-muted-foreground'
              }
            >
              {feedback.message}
            </div>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
