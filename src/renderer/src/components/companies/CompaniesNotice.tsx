import { Building2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { HealthStatus } from '../../../../shared/console-company-health-contract'
import { companiesErrorMessage, needsOmniosSignIn } from './companies-client'

/**
 * Signed-out, unconfigured or refused reads all land here: the same notice the
 * Tasks and Inbox pages show, never a blank page and never a crash.
 */
export function CompaniesNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const signIn = needsOmniosSignIn(error)
  return (
    <div role="alert" className="m-6 max-w-xl space-y-3 rounded-lg border p-5 text-sm">
      <p className="flex items-center gap-2 font-medium">
        <Building2 className="size-4" />
        {signIn
          ? translate('companies.signInTitle', 'Sign in to OmniOS to see your companies')
          : translate('companies.errorTitle', 'Companies could not be loaded')}
      </p>
      <p className="text-destructive">{companiesErrorMessage(error)}</p>
      <p className="text-muted-foreground">
        {translate(
          'companies.connectionHelp',
          'Check Settings → Backoffice and your OmniConsole account, then retry. Nothing was changed.'
        )}
      </p>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          {translate('companies.retry', 'Retry')}
        </Button>
      ) : null}
    </div>
  )
}

const STATUS_LABEL: Record<HealthStatus, () => string> = {
  healthy: () => translate('companies.statusHealthy', 'Healthy'),
  warning: () => translate('companies.statusWarning', 'Needs attention'),
  critical: () => translate('companies.statusCritical', 'Needs action'),
  unknown: () => translate('companies.statusUnknown', 'Incomplete picture'),
  unconfigured: () => translate('companies.statusUnconfigured', 'No standard set')
}
const STATUS_VARIANT: Record<HealthStatus, 'secondary' | 'destructive' | 'outline'> = {
  healthy: 'secondary',
  warning: 'outline',
  critical: 'destructive',
  unknown: 'outline',
  unconfigured: 'outline'
}

export function HealthBadge({ status }: { status: HealthStatus }) {
  return (
    <Badge variant={STATUS_VARIANT[status]} className="shrink-0">
      {STATUS_LABEL[status]()}
    </Badge>
  )
}

/** A figure the source did not send prints "—", never 0. */
export function Figure({ label, value }: { label: string; value: string | number | null }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">
        {value === null || value === undefined ? '—' : value}
      </div>
    </div>
  )
}

export function SectionTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="text-sm font-semibold">{title}</h2>
      {sub ? <span className="text-xs text-muted-foreground">{sub}</span> : null}
    </div>
  )
}
