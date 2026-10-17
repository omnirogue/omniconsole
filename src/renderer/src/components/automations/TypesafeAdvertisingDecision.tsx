import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import {
  advertisingDecisionKind,
  type AdvertisingDecisionKind,
  type BoundAdvertisingDecision
} from '../../../../shared/typesafe-advertising'
import type { AutomationHostTarget } from './automation-host-client'
import type { AutomationOwnerRef } from '../../../../shared/automation-owner-ref'
import { TypesafeAdvertisingActionControls } from './TypesafeAdvertisingActionControls'

function decisionLabel(kind: AdvertisingDecisionKind): string {
  const labels: Record<AdvertisingDecisionKind, string> = {
    KEEP_RUNNING: translate(
      'auto.components.automations.TypesafeAdvertisingActions.keepRunning',
      'Keep running'
    ),
    TURN_ON: translate('auto.components.automations.TypesafeAdvertisingActions.turnOn', 'Turn on'),
    PAUSE: translate('auto.components.automations.TypesafeAdvertisingActions.pause', 'Pause'),
    INCREASE_BUDGET: translate(
      'auto.components.automations.TypesafeAdvertisingActions.increaseBudget',
      'Recommend budget increase'
    ),
    DECREASE_BUDGET: translate(
      'auto.components.automations.TypesafeAdvertisingActions.decreaseBudget',
      'Recommend budget decrease'
    ),
    NO_ACTION: translate(
      'auto.components.automations.TypesafeAdvertisingActions.noAction',
      'No action'
    )
  }
  return labels[kind]
}

function percentage(value: number): string {
  return new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 }).format(
    value
  )
}

export function TypesafeAdvertisingDecision({
  decision,
  target,
  automationId,
  runId,
  ownerRef,
  disabled
}: {
  decision: BoundAdvertisingDecision
  target: AutomationHostTarget
  automationId: string
  runId: string
  ownerRef?: AutomationOwnerRef | null
  disabled: boolean
}) {
  const { evidence } = decision
  const actionLabel = decisionLabel(decision.kind)
  const executable =
    !decision.recommendationOnly && (decision.kind === 'PAUSE' || decision.kind === 'TURN_ON')
  const localStatusProposal =
    decision.evidence.source === 'local.meta.graph' &&
    decision.recommendationOnly &&
    decision.requiresHumanApproval &&
    decision.target.objectType !== 'campaign' &&
    (decision.kind === 'PAUSE' || decision.kind === 'TURN_ON')
  const objectLabel =
    decision.target.objectType === 'campaign'
      ? translate('auto.components.automations.TypesafeAdvertisingActions.campaign', 'Campaign')
      : decision.target.objectType === 'adset'
        ? translate('auto.components.automations.TypesafeAdvertisingActions.adset', 'Ad set')
        : translate('auto.components.automations.TypesafeAdvertisingActions.ad', 'Ad')
  return (
    <article className="space-y-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{actionLabel}</Badge>
        {!executable ? (
          <span className="text-xs text-muted-foreground">
            {translate(
              'auto.components.automations.TypesafeAdvertisingActions.recommendationOnly',
              'Recommendation only'
            )}
          </span>
        ) : null}
      </div>
      <div className="space-y-1">
        <p className="break-words text-sm font-medium">
          {evidence.name || decision.target.nativeId}
        </p>
        <p className="break-words text-xs text-muted-foreground">
          {translate(
            'auto.components.automations.TypesafeAdvertisingActions.object',
            '{{type}}: {{id}} · Account: {{account}} · Company: {{company}}',
            {
              type: objectLabel,
              id: decision.target.nativeId,
              account: decision.target.accountId,
              company: decision.target.company
            }
          )}
        </p>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.automations.TypesafeAdvertisingActions.status',
            'Status: {{status}} · Effective status: {{effectiveStatus}}',
            {
              status: evidence.status,
              effectiveStatus: evidence.effectiveStatus
            }
          )}
        </p>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.automations.TypesafeAdvertisingActions.window',
            'Evidence: {{start}}–{{stop}} ({{timezone}}) · Fetched: {{fetchedAt}}',
            {
              start: evidence.dateStart,
              stop: evidence.dateStop,
              timezone: evidence.timezone,
              fetchedAt: evidence.fetchedAt
            }
          )}
        </p>
      </div>
      <p className="text-sm">{decision.reasoningSummary}</p>
      {evidence.budgetOwnerId ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.automations.TypesafeAdvertisingActions.budgetOwner',
            'Budget owner: {{id}}',
            {
              id: evidence.budgetOwnerId
            }
          )}
        </p>
      ) : null}
      {evidence.limitations?.length ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.automations.TypesafeAdvertisingActions.limitations',
            'Evidence limits: {{limitations}}',
            {
              limitations: evidence.limitations.join(' ')
            }
          )}
        </p>
      ) : null}
      <p className="text-xs">
        {translate(
          'auto.components.automations.TypesafeAdvertisingActions.confidence',
          'Decision confidence: {{confidence}}',
          {
            confidence: percentage(decision.confidence)
          }
        )}
      </p>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">
          {translate(
            'auto.components.automations.TypesafeAdvertisingActions.probabilities',
            'Decision probabilities'
          )}
        </summary>
        <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
          {advertisingDecisionKind.options.map((kind) => (
            <div key={kind} className="contents">
              <dt>{decisionLabel(kind)}</dt>
              <dd>{percentage(decision.probabilities[kind])}</dd>
            </div>
          ))}
        </dl>
      </details>
      {localStatusProposal ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.automations.TypesafeAdvertisingActions.localProposal',
            'Proposal only. Reviewing a status action requires separate local action authorization and your approval of an exact preview.'
          )}
        </p>
      ) : null}
      {executable || localStatusProposal ? (
        <TypesafeAdvertisingActionControls
          decision={decision}
          actionLabel={actionLabel}
          target={target}
          automationId={automationId}
          runId={runId}
          ownerRef={ownerRef}
          disabled={disabled}
        />
      ) : null}
    </article>
  )
}
