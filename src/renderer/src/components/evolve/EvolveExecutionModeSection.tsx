import { translate } from '@/i18n/i18n'
import type { HostedEvolveExecutionTier } from '../../../../shared/evolve-workflow'
import type { HostedEvolveQuote } from '../../../../shared/evolve-workflow-draft'
import { BuildReviewSetupRow } from '../build-review/BuildReviewSetupRow'

export type EvolveExecutionModeSectionProps = {
  tabId: string
  isHosted: boolean
  hostedTier: HostedEvolveExecutionTier
  hostedQuote: HostedEvolveQuote
  onSelectMode: (mode: 'local_or_fleet' | 'hosted') => void
  onSelectTier: (tier: HostedEvolveExecutionTier) => void
}

export function EvolveExecutionModeSection({
  tabId,
  isHosted,
  hostedTier,
  hostedQuote,
  onSelectMode,
  onSelectTier
}: EvolveExecutionModeSectionProps) {
  const rowId = (field: string) => `evolve-${tabId}-${field}`
  return (
    <>
      <BuildReviewSetupRow
        labelId={rowId('execution-mode-label')}
        label={translate('evolveHosted.executionModeLabel', 'Execution mode')}
      >
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup">
          <button
            type="button"
            role="radio"
            aria-checked={!isHosted}
            data-testid="evolve-mode-local"
            onClick={() => onSelectMode('local_or_fleet')}
            className={`rounded-md border p-2.5 text-left transition-colors ${
              !isHosted
                ? 'border-primary bg-primary/5 text-foreground'
                : 'border-border bg-background text-muted-foreground hover:text-foreground'
            }`}
          >
            <div className="text-xs font-medium">
              {translate(
                'evolveHosted.localModeTitle',
                'Local AI (Your Machine / Fleet Subscription)'
              )}
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">
              {translate(
                'evolveHosted.localModeDescription',
                'Runs on your fleet or this computer using your existing CLI subscriptions.'
              )}
            </div>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={isHosted}
            data-testid="evolve-mode-hosted"
            onClick={() => onSelectMode('hosted')}
            className={`rounded-md border p-2.5 text-left transition-colors ${
              isHosted
                ? 'border-primary bg-primary/5 text-foreground'
                : 'border-border bg-background text-muted-foreground hover:text-foreground'
            }`}
          >
            <div className="text-xs font-medium">
              {translate(
                'evolveHosted.hostedModeTitle',
                'Hosted AI Super Intelligence (Paid Cloud Ensemble — 3–4 Frontier Families + Knockout Tournament + Blind Audit)'
              )}
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">
              {translate(
                'evolveHosted.blindAuditGuarantee',
                'Beats your local winner in blind cross-family audit before promoting'
              )}
            </div>
          </button>
        </div>
      </BuildReviewSetupRow>
      {isHosted && (
        <BuildReviewSetupRow
          labelId={rowId('hosted-tier-label')}
          label={translate('evolveHosted.tierLabel', 'Cloud tier')}
        >
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid="evolve-tier-hosted-pro"
                onClick={() => onSelectTier('hosted_pro')}
                className={`rounded border px-2.5 py-1 text-xs font-medium transition-colors ${
                  hostedTier === 'hosted_pro'
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'border-border text-muted-foreground hover:text-foreground'
                }`}
              >
                {translate('evolveHosted.tierPro', 'Hosted Pro')}
              </button>
              <button
                type="button"
                data-testid="evolve-tier-hosted-si"
                onClick={() => onSelectTier('hosted_super_intelligence')}
                className={`rounded border px-2.5 py-1 text-xs font-medium transition-colors ${
                  hostedTier === 'hosted_super_intelligence'
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'border-border text-muted-foreground hover:text-foreground'
                }`}
              >
                {translate('evolveHosted.tierSuperIntelligence', 'Hosted Super Intelligence')}
              </button>
              <span
                data-testid="evolve-estimated-credits-badge"
                className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-xs font-semibold text-foreground"
              >
                {translate(
                  'evolveHosted.estimatedCreditsBadge',
                  'Estimated Credits: {{credits}}',
                  { credits: String(hostedQuote.estimatedCredits) }
                )}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {hostedTier === 'hosted_pro'
                ? translate(
                    'evolveHosted.tierProDescription',
                    '2 frontier model families + blind audit verification'
                  )
                : translate(
                    'evolveHosted.tierSuperIntelligenceDescription',
                    '3–4 frontier families + knockout tournament + blind cross-family audit'
                  )}
            </p>
          </div>
        </BuildReviewSetupRow>
      )}
    </>
  )
}
