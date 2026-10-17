import type { AutomationDraft } from './AutomationEditorDialog'
import type { AutomationTemplate } from './automation-templates'

export function applyAutomationTemplate(
  current: AutomationDraft,
  template: AutomationTemplate
): AutomationDraft {
  const {
    id: _id,
    category: _category,
    label: _label,
    description: _description,
    connectorPresets,
    ...fields
  } = template
  return {
    ...current,
    contextPaths: [],
    contextNotes: '',
    repos: [],
    scope: '',
    ...fields,
    tools: {
      ...(fields.tools ?? { skills: [], mcpServers: [], allowWrite: false }),
      mcpServers: [...new Set([...(fields.tools?.mcpServers ?? []), ...(connectorPresets ?? [])])]
    },
    templateConnectorPresets: connectorPresets ?? [],
    repositoryRequired: template.repositoryRequired ?? false,
    time: template.time ?? current.time,
    dayOfWeek: template.dayOfWeek ?? current.dayOfWeek,
    customSchedule: template.customSchedule ?? '',
    scheduleWarning: null
  }
}
