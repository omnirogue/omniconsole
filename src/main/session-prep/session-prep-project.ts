import { projectLaunchPrompt } from '../../shared/project-launch-inheritance'
import { withoutAgentTemplateInstructions } from '../../shared/agent-template-dispatch'
import {
  SESSION_FOLDERS_NO_WINDOW_ERROR,
  SESSION_FOLDERS_TIMEOUT_ERROR
} from '../../shared/session-folder-cli'
import type { SessionPrepHost } from './session-prep-host'
import { shortSessionPrepReason } from './session-prep-ids'

/**
 * A prep item filed into a project folder inherits the project (plan §8), resolved for the host it
 * runs on, as the desktop launcher does. A project's copy of the chosen template is authoritative.
 * What the host lacks goes into the item's note, never dropped
 * silently. A folder that does not exist yet is in no project.
 */
export async function withSessionPrepProject(
  host: SessionPrepHost,
  args: {
    folder: string | undefined
    hostId: string
    worktreeId: string | null
    prompt: string
    templated: boolean
    templateId?: string
  }
): Promise<{ prompt: string; notes: string[]; agentTemplateName?: string }> {
  const { folder, prompt } = args
  if (!folder || !host.projectLaunch) {
    return { prompt, notes: [] }
  }
  let launch: Awaited<ReturnType<NonNullable<SessionPrepHost['projectLaunch']>>>
  try {
    launch = await host.projectLaunch({
      folder,
      host: args.hostId,
      ...(args.templateId ? { templateId: args.templateId } : {}),
      ...(args.worktreeId ? { worktreeId: args.worktreeId } : {})
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      prompt,
      notes:
        message === SESSION_FOLDERS_NO_WINDOW_ERROR || message === SESSION_FOLDERS_TIMEOUT_ERROR
          ? [`Project settings not read: ${shortSessionPrepReason(error)}`]
          : []
    }
  }
  if (!launch) {
    return { prompt, notes: [] }
  }
  if (launch.error) {
    return { prompt, notes: [`Project “${launch.project.name}” not inherited: ${launch.error}`] }
  }
  const projectAgentChosen = Boolean(
    args.templateId && launch.agent?.templateId === args.templateId
  )
  const usesProjectAgent = !args.templated || projectAgentChosen
  return {
    prompt: projectLaunchPrompt(launch, {
      prompt:
        projectAgentChosen && args.templated ? withoutAgentTemplateInstructions(prompt) : prompt,
      hostLabel: launch.host.label,
      ...(!usesProjectAgent ? { agent: false as const } : {})
    }),
    ...(usesProjectAgent && launch.agent ? { agentTemplateName: launch.agent.name } : {}),
    notes: [
      `Inherits project “${launch.project.name}”`,
      ...launch.notOnHost.map((item) => `Not on ${launch.host.label}: ${item.title} (left out)`),
      ...(launch.notes ?? [])
    ]
  }
}
