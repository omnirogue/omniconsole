import {
  AGENT_TEMPLATE_DEFAULT_ID,
  resolveAgentTemplates,
  type AgentTemplateSettings
} from '../../shared/agent-templates'
import {
  agentTemplateInstructions,
  type AgentTemplateText
} from '../../shared/agent-template-dispatch'
import type { PrepAgentTemplateChoice } from '../../shared/session-prep-types'
import type { SessionPrepBatchRecord, SessionPrepItemRecord } from './session-prep-records'

/** Templates the planner may match against the person's words; Default adds nothing to name. */
export function sessionPrepAgentTemplateChoices(
  settings: AgentTemplateSettings | undefined
): PrepAgentTemplateChoice[] {
  return resolveAgentTemplates(settings)
    .filter((template) => template.id !== AGENT_TEMPLATE_DEFAULT_ID)
    .map(({ id, name }) => ({ id, name }))
}

/** A template the person named for this item wins over the one chosen for the whole batch. */
export function sessionPrepAgentTemplateId(
  batch: Pick<SessionPrepBatchRecord, 'agentTemplateId'>,
  item: Pick<SessionPrepItemRecord, 'planned'>
): string | undefined {
  return item.planned.choices?.agentTemplate ?? batch.agentTemplateId
}

export function sessionPrepAgentTemplate(
  settings: AgentTemplateSettings | undefined,
  batch: Pick<SessionPrepBatchRecord, 'agentTemplateId'>,
  item: Pick<SessionPrepItemRecord, 'planned'>
): AgentTemplateText | null {
  return agentTemplateInstructions(settings, sessionPrepAgentTemplateId(batch, item))
}
