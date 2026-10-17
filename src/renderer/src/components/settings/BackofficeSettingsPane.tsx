import type React from 'react'
import { useEffect, useState } from 'react'

import type { BackofficeEnv } from '../../../../shared/backoffice-connection'
import {
  DEFAULT_BACKOFFICE_LOCAL_URL,
  DEFAULT_BACKOFFICE_PRODUCTION_URL,
  normalizeBackofficeEnv,
  normalizeBackofficeUrl
} from '../../../../shared/backoffice-connection'
import { cn } from '@/lib/utils'
import { useAppStore } from '../../store'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { translate } from '@/i18n/i18n'

type TestState =
  | { phase: 'idle' }
  | { phase: 'testing' }
  | { phase: 'ok'; detail: string }
  | { phase: 'error'; message: string }

type UrlDraft = { draft: string; error: string | null }

/**
 * Settings → Backoffice: which control plane this IDE talks to.
 *
 * Two named environments (Local / Production) with user-editable base URLs.
 * Sign-in itself lives in the OmniConsole Account pane — this pane decides
 * WHERE that sign-in and every task/QA/inbox call goes.
 */
export function BackofficeSettingsPane(): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)

  const env = normalizeBackofficeEnv(settings?.backofficeEnv)
  const localSource = settings?.backofficeLocalUrl ?? DEFAULT_BACKOFFICE_LOCAL_URL
  // Show what resolveBackofficeBaseUrl will actually use: an unset or cleared
  // production URL means the live console, so the field is pre-filled with it
  // rather than looking unconfigured.
  const productionSource = settings?.backofficeProductionUrl?.trim()
    ? settings.backofficeProductionUrl
    : DEFAULT_BACKOFFICE_PRODUCTION_URL

  const [localDraft, setLocalDraft] = useState<UrlDraft>({ draft: localSource, error: null })
  const [productionDraft, setProductionDraft] = useState<UrlDraft>({
    draft: productionSource,
    error: null
  })
  const [test, setTest] = useState<TestState>({ phase: 'idle' })

  useEffect(() => {
    setLocalDraft((current) =>
      current.draft === localSource ? current : { draft: localSource, error: null }
    )
  }, [localSource])
  useEffect(() => {
    setProductionDraft((current) =>
      current.draft === productionSource ? current : { draft: productionSource, error: null }
    )
  }, [productionSource])

  const commitUrl = (which: BackofficeEnv): void => {
    const isProduction = which === 'production'
    const draft = isProduction ? productionDraft.draft : localDraft.draft
    const setDraft = isProduction ? setProductionDraft : setLocalDraft
    if (isProduction && draft.trim() === '') {
      void updateSettings({ backofficeProductionUrl: '' })
      setDraft({ draft: '', error: null })
      return
    }
    const normalized = normalizeBackofficeUrl(draft, { requireHttps: isProduction })
    if (!normalized.ok) {
      setDraft({ draft, error: normalized.message })
      return
    }
    setDraft({ draft: normalized.value, error: null })
    void updateSettings(
      isProduction
        ? { backofficeProductionUrl: normalized.value }
        : { backofficeLocalUrl: normalized.value }
    )
  }

  const activeDraft = env === 'production' ? productionDraft.draft : localDraft.draft

  const runTest = async (): Promise<void> => {
    setTest({ phase: 'testing' })
    const result = await window.api.backoffice.testConnection({
      url: activeDraft,
      requireHttps: env === 'production'
    })
    if (result.ok) {
      setTest({ phase: 'ok', detail: result.detail })
    } else {
      setTest({ phase: 'error', message: result.message })
    }
  }

  const envButton = (value: BackofficeEnv, label: string): React.JSX.Element => (
    <Button
      variant={env === value ? 'default' : 'outline'}
      size="sm"
      aria-pressed={env === value}
      onClick={() => {
        setTest({ phase: 'idle' })
        void updateSettings({ backofficeEnv: value })
      }}
    >
      {label}
    </Button>
  )

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Label>{translate('auto.components.settings.backoffice.environment', 'Environment')}</Label>
        <div className="flex gap-2">
          {envButton('local', translate('auto.components.settings.backoffice.local', 'Local'))}
          {envButton(
            'production',
            translate('auto.components.settings.backoffice.production', 'Production')
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.backoffice.envHelp',
            'Every backoffice call — sign-in, tasks, QA, inbox — goes to the active environment.'
          )}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="backoffice-local-url">
          {translate('auto.components.settings.backoffice.localUrl', 'Local URL')}
        </Label>
        <Input
          id="backoffice-local-url"
          value={localDraft.draft}
          placeholder={DEFAULT_BACKOFFICE_LOCAL_URL}
          spellCheck={false}
          onChange={(event) => setLocalDraft({ draft: event.target.value, error: null })}
          onBlur={() => commitUrl('local')}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commitUrl('local')
            }
          }}
        />
        {localDraft.error ? <p className="text-xs text-destructive">{localDraft.error}</p> : null}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="backoffice-production-url">
          {translate('auto.components.settings.backoffice.productionUrl', 'Production URL')}
        </Label>
        <Input
          id="backoffice-production-url"
          value={productionDraft.draft}
          placeholder={DEFAULT_BACKOFFICE_PRODUCTION_URL}
          spellCheck={false}
          onChange={(event) => setProductionDraft({ draft: event.target.value, error: null })}
          onBlur={() => commitUrl('production')}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commitUrl('production')
            }
          }}
        />
        {productionDraft.error ? (
          <p className="text-xs text-destructive">{productionDraft.error}</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.backoffice.httpsHelp',
              'HTTPS is required — sign-in tokens ride this connection.'
            )}
          </p>
        )}
      </div>

      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          disabled={test.phase === 'testing' || !activeDraft.trim()}
          onClick={() => void runTest()}
        >
          {test.phase === 'testing'
            ? translate('auto.components.settings.backoffice.testing', 'Testing…')
            : translate('auto.components.settings.backoffice.test', 'Test connection')}
        </Button>
        {test.phase === 'ok' ? (
          <span className={cn('text-xs', 'text-emerald-500')}>
            {translate('auto.components.settings.backoffice.reachable', 'Reachable')} —{' '}
            {test.detail}
          </span>
        ) : null}
        {test.phase === 'error' ? (
          <span className="text-xs text-destructive">{test.message}</span>
        ) : null}
      </div>

      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.backoffice.signInHint',
          'Sign in and out under Settings → OmniConsole Account; the account pane uses the environment chosen here.'
        )}
      </p>
    </div>
  )
}
