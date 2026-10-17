import { CheckCircle2, ExternalLink, KeyRound, Loader2, Sparkles, Unplug } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type {
  OmniRogueAccountState,
  PrimaryAiBillingMode
} from '../../../../shared/omnirogue-account'

export type OmniRogueAccountStepProps = {
  accountState: OmniRogueAccountState
  isBusy?: boolean
  selectedBilling: PrimaryAiBillingMode
  onConnectAccount: () => Promise<void> | void
  onDisconnectAccount: () => Promise<void> | void
  onOpenSignup: () => Promise<void> | void
  onUseOwnLogin: () => Promise<void> | void
}

export function OmniRogueAccountStep({
  accountState,
  isBusy = false,
  selectedBilling,
  onConnectAccount,
  onDisconnectAccount,
  onOpenSignup,
  onUseOwnLogin
}: OmniRogueAccountStepProps): React.JSX.Element {
  const isConnected = accountState.state === 'connected' || accountState.state === 'linked'
  const isConnecting = accountState.state === 'connecting' || accountState.state === 'linking' || isBusy

  return (
    <div className="flex flex-col gap-4" data-testid="onboarding-omnirogue-account-step">
      <div
        className={cn(
          'rounded-xl border p-5 transition-colors',
          isConnected
            ? 'border-emerald-500/40 bg-emerald-500/10'
            : 'border-violet-500/40 bg-violet-500/10'
        )}
      >
        <div className="flex items-start gap-3">
          <span
            className={cn(
              'mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg',
              isConnected
                ? 'bg-emerald-500/20 text-emerald-400'
                : 'bg-violet-500/20 text-violet-300'
            )}
          >
            {isConnected ? (
              <CheckCircle2 className="size-5" />
            ) : (
              <Sparkles className="size-5" />
            )}
          </span>
          <div className="space-y-1 text-sm text-muted-foreground">
            {translate(
              'primaryAi.billingOmniRogueCreditsDesc',
              'Zero-setup access across flagship models using your unified OmniRogue wallet.'
            )}
          </div>
        </div>

        {accountState.state === 'error' && accountState.lastError ? (
          <div
            role="alert"
            className="mt-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3.5 py-2.5 text-xs text-destructive"
          >
            {accountState.lastError}
          </div>
        ) : null}

        {isConnected ? (
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-500/30 bg-background/60 px-4 py-3">
            <div className="flex items-center gap-2.5 text-sm">
              <CheckCircle2 className="size-4 shrink-0 text-emerald-400" />
              <div>
                <div className="font-medium text-foreground">
                  {translate('omnirogueAccount.connectedBadge', 'Connected to OmniRogue')}
                </div>
                {accountState.email || accountState.orgName ? (
                  <div className="text-xs text-muted-foreground">
                    {[accountState.email, accountState.orgName].filter(Boolean).join(' · ')}
                  </div>
                ) : null}
              </div>
            </div>
            <button
              type="button"
              disabled={isBusy}
              onClick={() => void onDisconnectAccount()}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
            >
              <Unplug className="size-3.5" />
              {translate('omnirogueAccount.disconnectButton', 'Disconnect')}
            </button>
          </div>
        ) : (
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={isConnecting}
              onClick={() => void onConnectAccount()}
              className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-violet-500 disabled:opacity-60"
            >
              {isConnecting ? <Loader2 className="size-4 animate-spin" /> : null}
              {isConnecting
                ? translate('omnirogueAccount.connectingButton', 'Waiting for browser…')
                : translate('omnirogueAccount.connectButton', 'Connect OmniRogue Account')}
            </button>
            <button
              type="button"
              onClick={() => void onOpenSignup()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/80 px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              {translate('omnirogueAccount.createAccountButton', 'Create OmniRogue Account')}
              <ExternalLink className="size-3.5" />
            </button>
          </div>
        )}
      </div>

      <div
        className={cn(
          'flex flex-col justify-between gap-3 rounded-xl border p-4 sm:flex-row sm:items-center',
          selectedBilling === 'own-login' && !isConnected
            ? 'border-foreground/40 bg-muted/40'
            : 'border-border bg-muted/20'
        )}
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
            <KeyRound className="size-4" />
          </span>
          <p className="text-xs text-muted-foreground">
            {translate(
              'omnirogueAccount.skipToOwnLoginHint',
              'Open-source and local-only mode — bring your own Claude, Codex, Gemini, or Kimi CLI login.'
            )}
          </p>
        </div>
        <button
          type="button"
          aria-pressed={selectedBilling === 'own-login'}
          onClick={() => void onUseOwnLogin()}
          className="inline-flex shrink-0 items-center justify-center rounded-lg border border-border bg-background px-3.5 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted"
        >
          {translate('omnirogueAccount.skipToOwnLoginButton', 'Use my own local CLI login')}
        </button>
      </div>
    </div>
  )
}
