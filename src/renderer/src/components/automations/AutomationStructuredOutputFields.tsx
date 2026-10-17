import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import type { AutomationStructuredOutput } from '../../../../shared/automation-structured-output'
import type { AutomationDraft } from './AutomationEditorDialog'
import { AUTOMATION_EDITOR_SECTION_LABEL_CLASS, Field } from './automation-page-parts'

type AutomationStructuredOutputFieldsProps = {
  draft: AutomationDraft
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
  pickerTriggerClassName: string
}

type AdvertisingOutput = Extract<AutomationStructuredOutput, { contract: 'advertising.v1' }>

export function AutomationStructuredOutputFields({
  draft,
  onDraftChange,
  pickerTriggerClassName
}: AutomationStructuredOutputFieldsProps): React.JSX.Element {
  const output = draft.structuredOutput
  const outputLabel = translate(
    'auto.components.automations.structuredOutput.output',
    'Decision output'
  )
  const contractLabel = translate(
    'auto.components.automations.structuredOutput.contract',
    'Result format'
  )
  const companyLabel = translate('auto.components.automations.structuredOutput.company', 'Company')
  const accountLabel = translate(
    'auto.components.automations.structuredOutput.account',
    'Ad account ID'
  )

  function updateAdvertising(patch: Partial<AdvertisingOutput['advertising']>): void {
    onDraftChange((current) => {
      if (current.structuredOutput?.contract !== 'advertising.v1') {
        return current
      }
      return {
        ...current,
        structuredOutput: {
          ...current.structuredOutput,
          advertising: { ...current.structuredOutput.advertising, ...patch }
        }
      }
    })
  }

  return (
    <div className="space-y-3">
      <Field labelClassName={AUTOMATION_EDITOR_SECTION_LABEL_CLASS} label={outputLabel}>
        <Select
          value={output ? 'typesafe' : 'off'}
          onValueChange={(value) =>
            onDraftChange((current) => ({
              ...current,
              structuredOutput:
                value === 'off'
                  ? null
                  : (current.structuredOutput ?? {
                      provider: 'typesafe',
                      contract: 'classification.v1'
                    })
            }))
          }
        >
          <SelectTrigger aria-label={outputLabel} className={`w-full ${pickerTriggerClassName}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" side="bottom" align="start" sideOffset={4}>
            <SelectItem value="off">
              {translate('auto.components.automations.structuredOutput.off', 'Off')}
            </SelectItem>
            <SelectItem value="typesafe">
              {translate(
                'auto.components.automations.structuredOutput.typesafe',
                'Structured decisions (Typesafe)'
              )}
            </SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.automations.structuredOutput.description',
            'The selected agent still runs. When enabled, its result is checked before recommendations are shown. No automatic ad changes.'
          )}
        </p>
      </Field>
      {output ? (
        <Field labelClassName={AUTOMATION_EDITOR_SECTION_LABEL_CLASS} label={contractLabel}>
          <Select
            value={output.contract}
            onValueChange={(contract) => {
              if (contract !== 'classification.v1' && contract !== 'advertising.v1') {
                return
              }
              onDraftChange((current) => ({
                ...current,
                structuredOutput:
                  contract === 'classification.v1'
                    ? { provider: 'typesafe', contract }
                    : current.structuredOutput?.contract === 'advertising.v1'
                      ? current.structuredOutput
                      : {
                          provider: 'typesafe',
                          contract,
                          advertising: { company: 'omnirogue', accountId: '' }
                        }
              }))
            }}
          >
            <SelectTrigger
              aria-label={contractLabel}
              className={`w-full ${pickerTriggerClassName}`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" side="bottom" align="start" sideOffset={4}>
              <SelectItem value="classification.v1">
                {translate(
                  'auto.components.automations.structuredOutput.classification',
                  'Classification'
                )}
              </SelectItem>
              <SelectItem value="advertising.v1">
                {translate(
                  'auto.components.automations.structuredOutput.advertising',
                  'Advertising'
                )}
              </SelectItem>
            </SelectContent>
          </Select>
        </Field>
      ) : null}
      {output?.contract === 'advertising.v1' ? (
        <>
          <Field labelClassName={AUTOMATION_EDITOR_SECTION_LABEL_CLASS} label={companyLabel}>
            <Select
              value={output.advertising.company}
              onValueChange={(company) => {
                if (company === 'omnirogue' || company === 'betacorp') {
                  updateAdvertising({ company })
                }
              }}
            >
              <SelectTrigger
                aria-label={companyLabel}
                className={`w-full ${pickerTriggerClassName}`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" side="bottom" align="start" sideOffset={4}>
                <SelectItem value="omnirogue">
                  {translate('advertising.omnirogue', 'OmniRogue')}
                </SelectItem>
                <SelectItem value="betacorp">
                  {translate('advertising.betacorp', 'BetaCorp')}
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field labelClassName={AUTOMATION_EDITOR_SECTION_LABEL_CLASS} label={accountLabel}>
            <Input
              aria-label={accountLabel}
              required
              value={output.advertising.accountId}
              onChange={(event) => updateAdvertising({ accountId: event.target.value })}
              placeholder={translate(
                'auto.components.automations.structuredOutput.accountPlaceholder',
                'act_123456789'
              )}
            />
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.automations.structuredOutput.accountDescription',
                'Use the Meta account ID, including act_. Only this account is included.'
              )}
            </p>
          </Field>
        </>
      ) : null}
    </div>
  )
}
