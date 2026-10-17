import type { AutomationRun } from '../../../../shared/automations-types'
import { ROUTINE_DELIVERY_UNCONFIRMED } from '../../../../shared/routine-delivery-state'
import { translate } from '@/i18n/i18n'
import { automationDeliveryLabel } from './automation-delivery-label'

export function AutomationDeliveryResults({ run }: { run?: AutomationRun }) {
  if (!run?.deliveryResults?.length) {
    return null
  }
  return (
    <div className="space-y-1 text-xs" data-routine-delivery-results>
      {run.deliveryResults.map((result) => {
        const unconfirmed = result.error === ROUTINE_DELIVERY_UNCONFIRMED
        const target = ['chat', 'desktop', 'email'].includes(result.kind)
          ? null
          : result.target === 'owner'
            ? translate('routines.notify.owner', 'Routine owner')
            : result.target
        return (
          <div
            key={`${result.kind}:${result.target}`}
            className={result.ok || unconfirmed ? 'text-muted-foreground' : 'text-destructive'}
          >
            {automationDeliveryLabel(result.kind)}
            {target ? ` · ${target}` : ''}:{' '}
            {result.ok
              ? translate('routines.delivery.delivered', 'Delivered')
              : unconfirmed
                ? translate(
                    'routines.delivery.unconfirmed',
                    'Unconfirmed. This attempt will not be repeated automatically.'
                  )
                : translate('routines.delivery.failed', 'Failed: {{reason}}', {
                    reason: result.error ?? ''
                  })}
          </div>
        )
      })}
    </div>
  )
}
