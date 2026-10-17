import type { AgentTemplateSettings } from './agent-templates'
import {
  agentTemplateInstructions,
  withAgentTemplateInstructions,
  type AgentTemplateText
} from './agent-template-dispatch'
import { buildAutomationRunPrompt } from './automation-run-prompt'
import type { Automation } from './automations-types'
import { automationDefinitionContext } from './automation-definition-context'

/** The routine's template from the settings of the process about to run it. */
export function routineAgentTemplate(
  settings: { agentTemplates?: AgentTemplateSettings } | null | undefined,
  automation: Pick<Automation, 'agentTemplateId'>
): AgentTemplateText | null {
  return agentTemplateInstructions(settings?.agentTemplates, automation.agentTemplateId)
}

/** The agent sees every selected input and output constraint, including additional repositories. */
export function buildRoutineRunPrompt(
  automation: Automation,
  prompt = automation.prompt,
  agentTemplate: AgentTemplateText | null = null,
  projectBrief: string | null = null
): string {
  // Why dropped: launch plumbing; the template's text follows the prompt, the project's brief leads.
  const {
    agentTemplateId: _agentTemplateId,
    sessionFolder: _sessionFolder,
    ...context
  } = automationDefinitionContext(automation)
  const lines = [
    'Routine definition context:',
    `Required output format: ${automation.outputFormat ?? 'markdown'}. Return the final result in this format.`,
    'Additional repositories are reference context only. Do not modify them.',
    'Read the listed context paths explicitly; report any path that is unavailable.',
    'Tool selections describe this routine; the agent host’s existing permissions remain authoritative.',
    JSON.stringify(context, null, 2),
    'End the output with a fenced JSON metadata block labelled routine-result containing {"notable": boolean, "summary": "one concise line"}. Use notable: false only when there is nothing to report.',
    'End routine definition context.'
  ]
  const led = withAgentTemplateInstructions(
    `${projectBrief ? `${projectBrief}\n\n` : ''}${lines.join('\n')}\n\n${buildAutomationRunPrompt(prompt, automation.structuredOutput)}`,
    agentTemplate
  )
  // Why: the result parser needs the routine-result block last; a template's own "end with…"
  // must not displace it. Without a template the prompt is unchanged.
  return agentTemplate
    ? `${led}\n\nWhatever the standing instructions above say, still end the output with the routine-result block described in the routine definition context.`
    : led
}
