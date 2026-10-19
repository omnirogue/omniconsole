import { Check, CircleAlert, CircleHelp, CircleSlash } from 'lucide-react'
import type {
  DeliverableCheck,
  DeliverableVerdict
} from '../../../../../shared/deliverable-verification-types'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { cn } from '@/lib/utils'
import {
  deliverableHostLabel,
  deliverableSourceLabel,
  deliverableStatusLine,
  deliverableVerdictLabel
} from './session-deliverables-model'
import { useSessionDeliverables } from './use-session-deliverables'

// Why warning only for Missing: a found file is not completion evidence, so it stays neutral.
const VERDICT_CHIP: Record<DeliverableVerdict, string> = {
  verified: 'border-border text-muted-foreground',
  missing: 'border-status-warning-border bg-status-warning-background text-status-warning',
  unverifiable: 'border-border text-muted-foreground',
  declined: 'border-border text-muted-foreground'
}

const VERDICT_ICON: Record<DeliverableVerdict, typeof Check> = {
  verified: Check,
  missing: CircleAlert,
  unverifiable: CircleHelp,
  declined: CircleSlash
}

function DeliverableRow({ check }: { check: DeliverableCheck }): React.JSX.Element {
  const Icon = VERDICT_ICON[check.verdict]
  return (
    <li
      className="flex min-w-0 items-start gap-2 px-2 py-1 text-xs"
      title={check.path ?? check.target}
    >
      <span
        className={cn(
          'inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] font-medium',
          VERDICT_CHIP[check.verdict]
        )}
      >
        <Icon className="size-3" aria-hidden />
        {deliverableVerdictLabel(check.verdict)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{check.target}</span>
        <span className="block truncate text-muted-foreground">
          {deliverableSourceLabel(check)} · {check.detail}
        </span>
      </span>
    </li>
  )
}

/** The newest deliverable check for the on-screen session; nothing when it has none. */
export function SessionDeliverables({
  session,
  active
}: {
  session: SidebarSession | null
  active: boolean
}): React.JSX.Element | null {
  const { records, markFalseAlarm } = useSessionDeliverables(session, active)
  const latest = records[0]
  if (!latest) {
    return null
  }
  const hasMissing = latest.checks.some((check) => check.verdict === 'missing')
  return (
    <section className="mb-2 rounded-md border border-border p-1.5" data-session-deliverables="">
      <div className="flex items-center justify-between gap-2 px-2 pb-1">
        <p className="text-[11px] font-medium text-muted-foreground">
          {translate('deliverableCheck.panel.title', 'Deliverables')}
          <span className="font-normal">
            {' '}
            · {deliverableStatusLine(latest)} ·{' '}
            {translate('deliverableCheck.panel.checkedOn', 'checked on {{host}}', {
              host: deliverableHostLabel(latest.host)
            })}
          </span>
        </p>
        {hasMissing && latest.falseAlarmAt === undefined ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="shrink-0 text-xs text-muted-foreground"
            onClick={() => markFalseAlarm(latest.id)}
          >
            {translate('deliverableCheck.panel.notAProblem', 'Not a problem')}
          </Button>
        ) : null}
      </div>
      <ul className="space-y-0.5">
        {latest.checks.map((check) => (
          <DeliverableRow key={`${check.source}:${check.target}`} check={check} />
        ))}
      </ul>
    </section>
  )
}
