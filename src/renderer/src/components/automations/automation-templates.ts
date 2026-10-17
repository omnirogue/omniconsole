import type { AutomationSchedulePreset } from '../../../../shared/automations-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AutomationDraft } from './AutomationEditorDialog'
import { builtInAutomationTemplates } from './automation-template-catalog'
import { legacyAutomationTemplates } from './automation-template-legacy-catalog'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export type AutomationTemplate = Partial<AutomationDraft> & {
  repositoryRequired?: boolean
  connectorPresets?: string[]
  id: string
  category: string
  label: string
  description: string
  name: string
  prompt: string
  preset: AutomationSchedulePreset
  time?: string
  dayOfWeek?: string
  agentId?: TuiAgent
  missedRunGraceMinutes?: string
}

export const getAutomationTemplates = createLocalizedCatalog((): AutomationTemplate[] => [
  ...builtInAutomationTemplates(),
  ...legacyAutomationTemplates().map((template) => ({
    ...template,
    outputFormat: 'markdown' as const,
    delivery: [{ kind: 'chat' as const }],
    notify: { onFinish: true, onlyWhenNotable: true, channels: [{ kind: 'desktop' as const }] },
    trigger: { kind: 'schedule' as const }
  }))
])
