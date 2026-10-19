import { useEffect, useId, useRef, useState } from 'react'
import { CheckCircle2, ExternalLink, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import type {
  OmniRogueAccountState,
  PrimaryAiBillingMode
} from '../../../../shared/omnirogue-account'
import {
  getOmniRogueQuickStartState,
  resolveOmniRogueQuickStartLabels,
  type OmniRogueQuickStartLabels
} from './omnirogue-quickstart-helpers'

type QuickStartAction = 'connect' | 'signup' | 'continue' | 'own-login'
type QuickStartCallback = () => void | Promise<void>

export type OmniRogueQuickStartCardProps = {
  accountState: OmniRogueAccountState
  selectedBilling?: PrimaryAiBillingMode
  isBusy?: boolean
  labels?: Partial<OmniRogueQuickStartLabels>
  className?: string
  onConnectAccount: QuickStartCallback
  onOpenSignup: QuickStartCallback
  onUseOwnLogin: QuickStartCallback
  onContinue: QuickStartCallback
}

export function OmniRogueQuickStartCard({
  accountState,
  selectedBilling = 'omnirogue-credits',
  isBusy = false,
  labels,
  className,
  onConnectAccount,
  onOpenSignup,
  onUseOwnLogin,
  onContinue
}: OmniRogueQuickStartCardProps): React.JSX.Element {
  const headingId = useId()
  const descriptionId = useId()
  const copy = resolveOmniRogueQuickStartLabels(labels)
  const view = getOmniRogueQuickStartState(accountState, copy)
  const [pendingAction, setPendingAction] = useState<QuickStartAction | null>(null)
  // A failure belongs to the account state and billing choice it happened under,
  // so it clears itself when either changes.
  const failureScope = `${accountState.state}:${selectedBilling}`
  const [failedScope, setFailedScope] = useState<string | null>(null)
  const actionFailed = failedScope === failureScope
  const inFlight = useRef(false)
  const mounted = useRef(false)
  const isBlocked = isBusy || pendingAction !== null
  const usesOwnLogin = selectedBilling === 'own-login'
  const isAccountPending = view.isConnecting && !usesOwnLogin
  const canContinue = view.isConnected || usesOwnLogin
  const errorMessage = actionFailed ? copy.actionError : view.errorMessage

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  async function runAction(action: QuickStartAction, callback: QuickStartCallback): Promise<void> {
    if (inFlight.current || isBusy || (isAccountPending && action !== 'own-login')) {
      return
    }
    inFlight.current = true
    setPendingAction(action)
    setFailedScope(null)
    try {
      await callback()
    } catch {
      if (mounted.current) {
        setFailedScope(failureScope)
      }
    } finally {
      inFlight.current = false
      if (mounted.current) {
        setPendingAction(null)
      }
    }
  }

  const statusLabel = usesOwnLogin
    ? copy.ownLoginSelected
    : view.isConnected
      ? copy.connected
      : view.isConnecting
        ? copy.waiting
        : copy.disconnected
  const primaryLabel =
    pendingAction === 'connect' || isAccountPending
      ? copy.waiting
      : isBlocked
        ? copy.working
        : canContinue
          ? copy.continue
          : copy.connect

  return (
    <Card
      role="region"
      aria-labelledby={headingId}
      aria-describedby={descriptionId}
      aria-busy={isBlocked || isAccountPending}
      className={className}
    >
      <CardHeader>
        <CardTitle id={headingId} role="heading" aria-level={2}>
          {copy.title}
        </CardTitle>
        <CardDescription id={descriptionId}>{copy.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div role="status" aria-live="polite" aria-atomic="true" className="space-y-1 text-sm">
          <p className="flex items-center gap-2">
            {view.isConnected && !usesOwnLogin ? (
              <CheckCircle2 aria-hidden="true" className="size-4 shrink-0 text-status-success" />
            ) : null}
            {statusLabel}
          </p>
          {view.accountSummary ? (
            <p className="break-words text-xs text-muted-foreground">{view.accountSummary}</p>
          ) : null}
        </div>
        {errorMessage ? (
          <p role="alert" className="break-words text-sm text-destructive">
            {errorMessage}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            disabled={isBlocked || isAccountPending}
            className="h-auto min-h-9 whitespace-normal text-start"
            onClick={() =>
              void runAction(
                canContinue ? 'continue' : 'connect',
                canContinue ? onContinue : onConnectAccount
              )
            }
          >
            {isBlocked || isAccountPending ? (
              <Loader2 aria-hidden="true" className="size-4 motion-safe:animate-spin" />
            ) : null}
            {primaryLabel}
          </Button>
          {!view.isConnected && !usesOwnLogin ? (
            <Button
              type="button"
              variant="outline"
              disabled={isBlocked || isAccountPending}
              className="h-auto min-h-9 whitespace-normal text-start"
              onClick={() => void runAction('signup', onOpenSignup)}
            >
              {copy.signup}
              <ExternalLink aria-hidden="true" className="size-4" />
            </Button>
          ) : null}
        </div>
        <div className="space-y-2 border-t border-border pt-4">
          <p className="text-xs text-muted-foreground">{copy.ownLoginDescription}</p>
          <Button
            type="button"
            variant="ghost"
            aria-pressed={usesOwnLogin}
            disabled={isBlocked || usesOwnLogin}
            className="h-auto min-h-9 whitespace-normal text-start"
            onClick={() => void runAction('own-login', onUseOwnLogin)}
          >
            {copy.ownLogin}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
