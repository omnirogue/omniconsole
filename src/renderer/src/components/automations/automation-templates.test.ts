import { describe, expect, it } from 'vitest'
import {
  automationDefinitionContext,
  automationDefinitionContextSchema
} from '../../../../shared/automation-definition-context'
import { buildAutomationRrule } from '../../../../shared/automation-schedule-occurrences'
import { getAutomationTemplates, type AutomationTemplate } from './automation-templates'
import { applyAutomationTemplate } from './automation-template-draft'
import { automationDraftDefinition } from './automation-draft-definition'
import { buildAutomationEditDraft } from './automation-edit-draft'
import { parseDraftTime } from './automation-draft-model'
import { makeAutomation } from './automations-page-fixtures'

function createRequest(template: AutomationTemplate) {
  const draft = applyAutomationTemplate(buildAutomationEditDraft(makeAutomation()), template)
  const input = {
    ...automationDraftDefinition(draft, {
      precheck: null,
      runContext: null,
      setupDecision: 'skip',
      timezone: 'America/New_York',
      missedRunGraceMinutes: 720
    }),
    rrule:
      draft.preset === 'custom'
        ? draft.customSchedule
        : buildAutomationRrule({
            preset: draft.preset,
            ...parseDraftTime(draft.time),
            dayOfWeek: Number(draft.dayOfWeek)
          }),
    dtstart: Date.now(),
    repo: draft.projectId
  }
  return {
    draft,
    request: {
      ...(JSON.parse(JSON.stringify(input)) as typeof input),
      ...automationDefinitionContextSchema.parse(input)
    }
  }
}
describe('routine template catalog', () => {
  it('contains the requested nine templates', () => {
    expect(getAutomationTemplates().map((row) => row.label)).toEqual([
      'Email triage',
      'Briefing',
      'Issue triage',
      'Dependency update check',
      'System health check',
      'Flaky test tracker',
      'Release notes drafter',
      'Weekday repo audit',
      'Release readiness'
    ])
  })
  it.each(getAutomationTemplates())(
    '$label presets survive the editor and RPC serialization',
    (template) => {
      const { draft, request } = createRequest(template)
      expect(request.name).toBe(template.name)
      expect(request.prompt).toBe(template.prompt)
      expect(draft.time).toBe(template.time)
      expect(request).toMatchObject({
        ...automationDefinitionContext(draft),
        scope: draft.scope || undefined
      })
      expect(request).toMatchObject({
        outputFormat: 'markdown',
        delivery: [{ kind: 'chat' }],
        notify: { onFinish: true, onlyWhenNotable: true }
      })
      expect(draft.tools?.mcpServers).toEqual(
        expect.arrayContaining(template.connectorPresets ?? [])
      )
      const reopened = buildAutomationEditDraft(
        makeAutomation({
          ...request,
          projectId: 'repo-1',
          structuredOutput: request.structuredOutput ?? undefined,
          launchPreferences: request.launchPreferences ?? undefined
        })
      )
      expect(automationDefinitionContext(reopened)).toEqual(automationDefinitionContext(request))
    }
  )
  it('round-trips every optional field, multiple Slack channels and an explicit DM recipient', () => {
    const template: AutomationTemplate = {
      ...getAutomationTemplates()[0],
      repos: [
        {
          kind: 'workspace-run',
          hostId: 'local',
          projectId: 'p',
          projectHostSetupId: 's',
          repoId: 'repo-1',
          path: '/repo'
        }
      ],
      contextPaths: ['src/**/*.ts'],
      contextNotes: 'Compare changes',
      scope: 'acme/engineering',
      tools: { skills: ['review'], mcpServers: ['slack'], allowWrite: false },
      connectorPresets: [],
      delivery: [
        { kind: 'slack', channel: '#test' },
        { kind: 'google-drive', folderId: 'folder' },
        { kind: 'file', path: 'report.csv' },
        { kind: 'hub-card', scope: 'acme/engineering' }
      ],
      outputFormat: 'csv',
      notify: {
        onFinish: false,
        onlyWhenNotable: false,
        channels: [
          { kind: 'slack-channel', channelId: 'C1', channelName: 'test' },
          { kind: 'slack-channel', channelId: '', channelName: 'typed' },
          { kind: 'slack-dm', email: 'owner@example.com' }
        ]
      }
    }
    expect(createRequest(template).request).toMatchObject(automationDefinitionContext(template))
  })
})
