import type { AgentTemplateSettings } from '../../../../shared/agent-templates'
import {
  agentTemplateInstructions,
  withAgentTemplateInstructions,
  type AgentTemplateText
} from '../../../../shared/agent-template-dispatch'
import { prependHubTaskPrompt } from '../../../../shared/omnios-task-binding'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { QuickLaunchProject } from './quick-launch-options'

/** The template a quick launch carries; none when no agent starts. */
export function quickComposerAgentTemplate(
  agent: TuiAgent | null,
  agentTemplates: AgentTemplateSettings | undefined,
  agentTemplateId: string | undefined,
  /** A project's own agent, when no template was chosen. */
  projectAgent?: AgentTemplateText | null
): AgentTemplateText | null {
  return agent
    ? (agentTemplateInstructions(agentTemplates, agentTemplateId) ?? projectAgent ?? null)
    : null
}

/** Plan §8 F5: the project line first, then the text, then what the project attaches. */
export function withQuickLaunchProject(
  text: string,
  project: QuickLaunchProject | undefined
): string {
  return project ? [project.line, text, project.context].filter(Boolean).join('\n\n') : text
}

/**
 * The first message and launch draft exactly as every consumer receives them: task binding, the
 * person's text, then the template, once. Nothing typed with a template sends the template alone.
 */
export function assembleQuickComposerTexts(input: {
  prompt: string
  draftPrompt: string | null | undefined
  hubTaskId?: string
  agentTemplate: AgentTemplateText | null
  project?: QuickLaunchProject
}): { prompt: string; draftPrompt: string | null | undefined } {
  const { draftPrompt, hubTaskId, agentTemplate, project } = input
  if (draftPrompt) {
    return {
      prompt: input.prompt,
      draftPrompt: withQuickLaunchProject(
        withAgentTemplateInstructions(prependHubTaskPrompt(draftPrompt, hubTaskId), agentTemplate),
        project
      )
    }
  }
  return {
    prompt: withQuickLaunchProject(
      withAgentTemplateInstructions(prependHubTaskPrompt(input.prompt, hubTaskId), agentTemplate),
      project
    ),
    draftPrompt
  }
}
