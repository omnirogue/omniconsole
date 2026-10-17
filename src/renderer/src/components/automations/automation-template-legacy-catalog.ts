import type { AutomationTemplate } from './automation-templates'
import { translate } from '@/i18n/i18n'
export function legacyAutomationTemplates(): AutomationTemplate[] {
  return [
    {
      id: 'repo-health-weekday',
      category: translate(
        'auto.components.automations.automation.templates.repoHealth.category',
        'Repo health'
      ),
      label: translate(
        'auto.components.automations.automation.templates.b84757677d',
        'Weekday repo audit'
      ),
      description: translate(
        'auto.components.automations.automation.templates.a7fbd32ddb',
        'Check dependencies, failing tests, and risky open changes each weekday.'
      ),
      name: translate(
        'auto.components.automations.automation.templates.repoHealth.name',
        'Weekday repo audit'
      ),
      prompt: translate(
        'auto.components.automations.automation.templates.repoHealth.prompt',
        'Review the repository health. Check dependency updates, failing tests, lint/typecheck status, and risky open changes. Summarize findings and suggest the next action.'
      ),
      preset: 'weekdays',
      time: '09:00',
      missedRunGraceMinutes: '720'
    },
    {
      id: 'release-prep-weekly',
      category: translate(
        'auto.components.automations.automation.templates.releasePrep.category',
        'Release prep'
      ),
      label: translate(
        'auto.components.automations.automation.templates.39ed39280a',
        'Release readiness'
      ),
      description: translate(
        'auto.components.automations.automation.templates.513401db93',
        'Prepare a weekly release risk summary from the current project state.'
      ),
      name: translate(
        'auto.components.automations.automation.templates.releasePrep.name',
        'Release readiness review'
      ),
      prompt: translate(
        'auto.components.automations.automation.templates.releasePrep.prompt',
        'Prepare a release readiness summary. Look for blockers, unmerged risky changes, missing validation, and documentation gaps. End with a concise release/no-release recommendation.'
      ),
      preset: 'weekly',
      time: '14:00',
      dayOfWeek: '4',
      missedRunGraceMinutes: '1440'
    }
  ]
}
