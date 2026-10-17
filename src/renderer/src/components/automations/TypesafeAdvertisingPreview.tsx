import { translate } from '@/i18n/i18n'
import type { TypedAdvertisingActionPreview } from '../../../../shared/advertising-action-provider-contract'

export function TypesafeAdvertisingPreview({
  preview
}: {
  preview: TypedAdvertisingActionPreview
}) {
  const impact = preview.financial_impact
  const ceiling =
    impact.daily_budget_ceiling === null
      ? translate('auto.components.automations.TypesafeAdvertisingActions.unknown', 'Unknown')
      : String(impact.daily_budget_ceiling)
  return (
    <div className="space-y-1 text-xs">
      <p className="text-sm font-medium">{preview.summary}</p>
      {preview.protocol_version === 'local-human-action.v1' ? (
        <p className="text-muted-foreground">
          {translate(
            'auto.components.automations.TypesafeAdvertisingActions.localAuthority',
            'Local Meta status action · Separate host authorization · Not a signed backend action.'
          )}
        </p>
      ) : null}
      <p className="break-words">
        {translate(
          'auto.components.automations.TypesafeAdvertisingActions.previewTarget',
          'Native object: {{id}} · Account: {{account}}',
          {
            id: preview.snapshot.objectId,
            account: preview.snapshot.adAccountId
          }
        )}
      </p>
      <p>
        {translate(
          'auto.components.automations.TypesafeAdvertisingActions.transition',
          'Status: {{from}} → {{to}}',
          {
            from: preview.transition.from,
            to: preview.transition.to
          }
        )}
      </p>
      <p>
        {translate(
          'auto.components.automations.TypesafeAdvertisingActions.budgetCeiling',
          'Daily budget ceiling: {{currency}} {{amount}}',
          {
            currency:
              impact.currency ??
              translate(
                'auto.components.automations.TypesafeAdvertisingActions.unknownCurrency',
                'Unknown currency'
              ),
            amount: ceiling
          }
        )}
      </p>
      <p className="text-muted-foreground">
        {translate(
          'auto.components.automations.TypesafeAdvertisingActions.budgetImpact',
          'Configured budget is unchanged. Delivery and profit are not guaranteed.'
        )}
      </p>
      {preview.protocol_version === 'local-human-action.v1' ? (
        <p className="text-muted-foreground">
          {translate(
            'auto.components.automations.TypesafeAdvertisingActions.localVerificationLimit',
            'Independent readback checks the target status and unchanged budgets. It does not prove this request caused the observed state. Reversing it requires a new approval.'
          )}
        </p>
      ) : null}
      <p className="break-words text-muted-foreground">
        {translate(
          'auto.components.automations.TypesafeAdvertisingActions.previewVersion',
          'Source version: {{version}} · Preview expires: {{expiresAt}}',
          {
            version: preview.expected_version,
            expiresAt: preview.expires_at
          }
        )}
      </p>
    </div>
  )
}
