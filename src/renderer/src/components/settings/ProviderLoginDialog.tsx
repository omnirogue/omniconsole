import { useEffect, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import {
  assertRuntimeEnvironmentCapability,
  callRuntimeRpc,
  getActiveRuntimeTarget
} from '@/runtime/runtime-rpc-client'
import type { ProviderLoginState } from '../../../../shared/provider-login-types'
import type { AccountsPaneSectionModel } from './accounts-pane-types'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'

export function ProviderLoginDialog({
  provider,
  accountId,
  model,
  onClose,
  onComplete
}: {
  provider: 'claude' | 'codex'
  accountId?: string
  model: AccountsPaneSectionModel
  onClose: () => void
  onComplete: () => void
}): React.JSX.Element {
  const [state, setState] = useState<ProviderLoginState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const callbacks = useRef({ onClose, onComplete })
  callbacks.current = { onClose, onComplete }
  const [owner] = useState(() => getActiveRuntimeTarget(model.settings))
  const [request] = useState(() => ({
    provider,
    accountId,
    runtime: model.accountRuntime.runtime,
    wslDistro: model.accountRuntime.wslDistro ?? null
  }))
  const sessionId = useRef<string | null>(null)
  const title = provider === 'claude' ? 'Claude' : 'Codex'
  useEffect(() => {
    let disposed = false
    let finished = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const call = <T,>(method: string, params: unknown): Promise<T> =>
      callRuntimeRpc<T>(owner, method, params, {
        timeoutMs: 15_000,
        suppressFeatureInteraction: true
      })
    const cancel = (id: string): void => {
      void call('accounts.login.cancel', { id }).catch(() => {})
    }
    const receive = (next: ProviderLoginState): void => {
      if (disposed) {
        if (!finished) {
          cancel(next.id)
        }
        return
      }
      setState(next)
      if (next.status === 'complete') {
        finished = true
        callbacks.current.onComplete()
        callbacks.current.onClose()
      } else if (next.status === 'error' || next.status === 'cancelled') {
        finished = true
        setError(
          next.error ??
            translate(
              'settings.providerLogin.cancelled',
              'Sign-in was cancelled or expired. Close this dialog and try again.'
            )
        )
      } else {
        timer = setTimeout(() => {
          void call<ProviderLoginState>('accounts.login.status', { id: next.id })
            .then(receive)
            .catch(() => {
              if (!disposed) {
                setError(
                  translate(
                    'settings.providerLogin.disconnected',
                    'Could not contact the account computer. Sign-in status is unknown. Reconnect and try again.'
                  )
                )
              }
            })
        }, 1000)
      }
    }
    const startTimer = setTimeout(() => {
      void (async () => {
        if (owner.kind === 'environment') {
          await assertRuntimeEnvironmentCapability(
            owner.environmentId,
            'accounts.login-link.v1',
            translate(
              'settings.providerLogin.updateHost',
              'Update OmniConsole on the remote computer to sign in here.'
            )
          )
        }
        if (disposed) {
          return
        }
        const next = await call<ProviderLoginState>('accounts.login.start', request)
        sessionId.current = next.id
        receive(next)
      })().catch((cause: unknown) => {
        if (!disposed) {
          setError(
            cause instanceof Error
              ? cause.message
              : translate('settings.providerLogin.failed', 'Could not start sign-in. Try again.')
          )
        }
      })
    }, 0)
    return () => {
      clearTimeout(startTimer)
      disposed = true
      clearTimeout(timer)
      if (!finished && sessionId.current) {
        cancel(sessionId.current)
      }
    }
  }, [owner, request])
  const submitCode = async (): Promise<void> => {
    if (!state || submitting) {
      return
    }
    setSubmitting(true)
    try {
      await callRuntimeRpc(
        owner,
        'accounts.login.submitCode',
        { id: state.id, code: code.trim() },
        { suppressFeatureInteraction: true }
      )
      setCode('')
    } catch {
      setError(
        translate(
          'settings.providerLogin.codeFailed',
          'Could not submit the code. Check the code and connection, then try again.'
        )
      )
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {translate('settings.providerLogin.title', 'Sign in to {{provider}}', {
              provider: title
            })}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'settings.providerLogin.owner',
              'This account will be saved on {{computer}}.',
              { computer: model.accountRuntime.label }
            )}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {state?.authorizationUrl
              ? translate(
                  'settings.providerLogin.waiting',
                  'Finish signing in in your browser. This dialog updates when the account is ready.'
                )
              : translate('settings.providerLogin.starting', 'Preparing your sign-in link…')}
          </p>
        )}
        {state?.userCode ? (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">
              {translate(
                'settings.providerLogin.deviceCode',
                'Enter this code on the sign-in page'
              )}
            </p>
            <code className="select-all font-mono text-sm">{state.userCode}</code>
          </div>
        ) : null}
        {state?.authorizationUrl ? (
          <Button
            onClick={() => {
              void window.api.shell
                .openUrl(state.authorizationUrl!)
                .catch(() =>
                  setError(
                    translate(
                      'settings.providerLogin.browserFailed',
                      'Could not open your browser. Try again.'
                    )
                  )
                )
            }}
          >
            {translate('settings.providerLogin.open', 'Open {{provider}} sign-in', {
              provider: title
            })}
          </Button>
        ) : null}
        {state?.canSubmitCode ? (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault()
              void submitCode()
            }}
          >
            <label htmlFor="provider-login-code" className="text-xs text-muted-foreground">
              {translate(
                'settings.providerLogin.pasteCode',
                'If the browser gives you a code, paste it here'
              )}
            </label>
            <Input
              id="provider-login-code"
              autoComplete="off"
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
            <Button type="submit" size="sm" disabled={!code.trim() || submitting}>
              {translate('settings.providerLogin.continue', 'Continue')}
            </Button>
          </form>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {translate('settings.providerLogin.close', 'Close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
