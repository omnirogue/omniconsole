import { useMemo } from 'react'
import { Check, Cpu, KeyRound, Sparkles } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { getAgentSessionOptionCatalog } from '../../../../shared/agent-session-option-catalog'
import type { PrimaryAiBillingMode } from '../../../../shared/omnirogue-account'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  FLAGSHIP_PRIMARY_AI_MODELS,
  type FlagshipPrimaryAiModelOption
} from './use-onboarding-flow-types'

export type PrimaryAiPickerStepProps = {
  selectedAgent: TuiAgent | null
  selectedBilling: PrimaryAiBillingMode
  onSelectBilling: (mode: PrimaryAiBillingMode) => void
  selectedModel: string | undefined
  onSelectModel: (modelId: string, agent?: TuiAgent) => void
  accountConnected?: boolean
}

export function PrimaryAiPickerStep({
  selectedAgent,
  selectedBilling,
  onSelectBilling,
  selectedModel,
  onSelectModel,
  accountConnected = false
}: PrimaryAiPickerStepProps): React.JSX.Element {
  const modelOptions = useMemo<readonly FlagshipPrimaryAiModelOption[]>(() => {
    if (!selectedAgent) {
      return FLAGSHIP_PRIMARY_AI_MODELS
    }
    const catalog = getAgentSessionOptionCatalog(selectedAgent)
    if (!catalog) {
      return FLAGSHIP_PRIMARY_AI_MODELS
    }
    const existingIds = new Set(FLAGSHIP_PRIMARY_AI_MODELS.map((m) => m.id))
    const extraCatalogModels: FlagshipPrimaryAiModelOption[] = catalog.models
      .filter((m) => !existingIds.has(m.id))
      .map((m) => ({
        id: m.id,
        label: m.label,
        providerLabel: selectedAgent,
        agent: selectedAgent
      }))
    return [...FLAGSHIP_PRIMARY_AI_MODELS, ...extraCatalogModels]
  }, [selectedAgent])

  return (
    <div
      className="flex shrink-0 flex-col gap-3 rounded-xl border border-border bg-muted/15 p-3.5"
      data-testid="primary-ai-picker-step"
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <button
          type="button"
          data-testid="primary-ai-billing-omnirogue-credits"
          aria-pressed={selectedBilling === 'omnirogue-credits'}
          onClick={() => onSelectBilling('omnirogue-credits')}
          className={cn(
            'relative flex items-start gap-2.5 rounded-lg border p-3 text-left transition-all',
            selectedBilling === 'omnirogue-credits'
              ? 'border-violet-500/60 bg-violet-500/10 ring-2 ring-violet-500/25'
              : 'border-border bg-background/60 hover:bg-muted/50'
          )}
        >
          <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-violet-500/20 text-violet-400">
            <Sparkles className="size-3.5" />
          </span>
          <div className="min-w-0 flex-1 pr-5">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <span className="truncate">
                {translate(
                  'primaryAi.billingOmniRogueCredits',
                  'OmniRogue Cloud Credits (Recommended)'
                )}
              </span>
              {accountConnected ? (
                <span className="shrink-0 rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
                  {translate('primaryAi.connected', 'Connected')}
                </span>
              ) : null}
            </div>
            <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
              {translate(
                'primaryAi.billingOmniRogueCreditsDesc',
                'Zero-setup access across flagship models using your unified OmniRogue wallet.'
              )}
            </div>
          </div>
          {selectedBilling === 'omnirogue-credits' ? (
            <span className="absolute right-2 top-2 grid size-4 place-items-center rounded-full bg-violet-500 text-white">
              <Check className="size-2.5" strokeWidth={3} />
            </span>
          ) : null}
        </button>

        <button
          type="button"
          data-testid="primary-ai-billing-own-login"
          aria-pressed={selectedBilling === 'own-login'}
          onClick={() => onSelectBilling('own-login')}
          className={cn(
            'relative flex items-start gap-2.5 rounded-lg border p-3 text-left transition-all',
            selectedBilling === 'own-login'
              ? 'border-violet-500/60 bg-violet-500/10 ring-2 ring-violet-500/25'
              : 'border-border bg-background/60 hover:bg-muted/50'
          )}
        >
          <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
            <KeyRound className="size-3.5" />
          </span>
          <div className="min-w-0 flex-1 pr-5">
            <div className="truncate text-xs font-semibold text-foreground">
              {translate('primaryAi.billingOwnLogin', 'Use my own local CLI login')}
            </div>
            <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
              {translate(
                'primaryAi.billingOwnLoginDesc',
                'Authenticate directly with your local CLI subscription or API key.'
              )}
            </div>
          </div>
          {selectedBilling === 'own-login' ? (
            <span className="absolute right-2 top-2 grid size-4 place-items-center rounded-full bg-violet-500 text-white">
              <Check className="size-2.5" strokeWidth={3} />
            </span>
          ) : null}
        </button>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          <Cpu className="size-3" />
          <span>{translate('primaryAi.defaultModelHeading', 'Flagship Default Model')}</span>
        </div>
        <div className="flex flex-wrap gap-1.5" data-testid="primary-ai-models-list">
          {modelOptions.map((model) => {
            const isSelected = selectedModel === model.id
            return (
              <button
                key={model.id}
                type="button"
                data-testid={`primary-ai-model-${model.id}`}
                aria-pressed={isSelected}
                onClick={() => onSelectModel(model.id, model.agent)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-all',
                  isSelected
                    ? 'border-violet-500/60 bg-violet-500/15 font-medium text-foreground ring-1 ring-violet-500/30'
                    : 'border-border bg-background/60 text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                )}
              >
                <span>{model.label}</span>
                <span className="font-mono text-[10px] opacity-70">{model.id}</span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
