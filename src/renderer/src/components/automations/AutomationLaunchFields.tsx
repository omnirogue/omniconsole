import { translate } from '@/i18n/i18n'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { getAgentSessionOptionCatalog } from '../../../../shared/agent-session-option-catalog'
import { automationEffortOptions } from '../../../../shared/automation-launch-preferences'
import { useAutomationLaunchAccounts } from './use-automation-launch-accounts'
import type { AutomationDraft } from './AutomationEditorDialog'
import { Field, AUTOMATION_EDITOR_SECTION_LABEL_CLASS } from './automation-page-parts'

type Props = {
  draft: AutomationDraft
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
}

export function AutomationLaunchFields({ draft, onDraftChange }: Props): React.JSX.Element {
  const accounts = useAutomationLaunchAccounts(draft.projectId)
  const preferences = draft.launchPreferences ?? {}
  const catalog = getAgentSessionOptionCatalog(draft.agentId)
  const set = (key: 'model' | 'effort' | 'codexAccountId', value: string): void => {
    onDraftChange((current) => ({
      ...current,
      launchPreferences: {
        ...current.launchPreferences,
        ...(key === 'model' ? { effort: undefined } : {}),
        [key]: value === 'inherit' ? undefined : value
      }
    }))
  }
  const inherit = translate('automations.launch.inherit', 'Inherit config')
  const fields = [
    {
      key: 'model' as const,
      label: translate('automations.launch.model', 'Model'),
      placeholder: inherit,
      choices: catalog?.models.map((model) => ({ value: model.id, label: model.label })) ?? []
    },
    {
      key: 'effort' as const,
      label: translate('automations.launch.effort', 'Reasoning effort'),
      placeholder: inherit,
      choices: automationEffortOptions(draft.agentId, preferences.model)
    },
    ...(draft.agentId === 'codex'
      ? [
          {
            key: 'codexAccountId' as const,
            label: translate('automations.launch.account', 'Account'),
            placeholder: translate('automations.launch.balanced', 'Balanced (default)'),
            choices: accounts
          }
        ]
      : [])
  ]
  return (
    <Field
      label={translate('automations.launch.title', 'Launch')}
      labelClassName={AUTOMATION_EDITOR_SECTION_LABEL_CLASS}
    >
      <div className="space-y-3">
        {fields.map((field) => (
          <Field key={field.key} label={field.label}>
            <Select
              value={preferences[field.key] ?? 'inherit'}
              onValueChange={(value) => set(field.key, value)}
            >
              <SelectTrigger className="h-9 w-full" aria-label={field.label}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inherit">{field.placeholder}</SelectItem>
                {preferences[field.key] &&
                !field.choices.some((choice) => choice.value === preferences[field.key]) ? (
                  <SelectItem value={preferences[field.key]!}>{preferences[field.key]}</SelectItem>
                ) : null}
                {field.choices.map((choice) => (
                  <SelectItem key={choice.value} value={String(choice.value)}>
                    {choice.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ))}
      </div>
    </Field>
  )
}
