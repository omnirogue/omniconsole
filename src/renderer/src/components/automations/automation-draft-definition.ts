import { automationDefinitionContext } from '../../../../shared/automation-definition-context'
import type { AutomationCreateInput } from '../../../../shared/automations-types'
import type { AutomationDraft } from './AutomationEditorDialog'

export function automationDraftDefinition(
  draft: AutomationDraft,
  resolved: Pick<
    AutomationCreateInput,
    | 'precheck'
    | 'runContext'
    | 'setupDecision'
    | 'timezone'
    | 'missedRunGraceMinutes'
    | 'structuredOutput'
  >
): Omit<AutomationCreateInput, 'rrule' | 'dtstart'> {
  return {
    ...automationDefinitionContext(draft),
    scope: draft.scope?.trim() || undefined,
    contextPaths: draft.contextPaths?.map((path) => path.trim()).filter(Boolean),
    name: draft.name,
    prompt: draft.prompt,
    agentId: draft.agentId,
    projectId: draft.projectId,
    workspaceMode: draft.workspaceMode,
    workspaceId: draft.workspaceId,
    baseBranch: draft.baseBranch.trim() || null,
    reuseSession: draft.workspaceMode === 'existing' && draft.reuseSession,
    launchPreferences: draft.launchPreferences ?? null,
    ...resolved
  }
}
