import {
  AGENT_TEMPLATE_DEFAULT_ID,
  resolveAgentTemplates,
  type AgentTemplateSettings
} from './agent-templates'
import type { ProjectAgent } from './project-settings'

/** Keep a project's saved copy even without a local template; stale choices use its default. */
export function projectAgentTemplateId(
  agents: readonly ProjectAgent[],
  templates: AgentTemplateSettings | undefined,
  templateId: string | null
): string | null {
  if (!templateId || templateId === AGENT_TEMPLATE_DEFAULT_ID) {
    return templateId
  }
  const known =
    agents.some((agent) => agent.templateId === templateId) ||
    resolveAgentTemplates(templates).some((template) => template.id === templateId)
  return known ? templateId : AGENT_TEMPLATE_DEFAULT_ID
}
