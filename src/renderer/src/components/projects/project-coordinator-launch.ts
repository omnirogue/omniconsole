import { nativeChatEnabledByPreference } from '../../../../shared/native-chat-preference'
import type { ProjectCoordinator } from '../../../../shared/project-settings'
import {
  LAUNCHER_PROVIDERS,
  type LaunchPick,
  type LauncherProvider
} from '../sidebar/session-folders/new-conversation/resolve-launch-plan'
import { COORDINATOR_TEMPLATE_ID } from './project-settings-draft'

/**
 * The recorded chat as the folder launcher's own pick, so it starts exactly as a person's pick
 * would; null when the recorded agent is not one the launcher starts.
 */
export function coordinatorLaunchPick(launch: ProjectCoordinator['launch']): LaunchPick | null {
  if (!LAUNCHER_PROVIDERS.some((provider) => provider === launch.agent)) {
    return null
  }
  return {
    agent: launch.agent as LauncherProvider,
    ...(launch.model ? { model: launch.model } : {}),
    ...(launch.effort ? { effort: launch.effort } : {}),
    team: launch.team ?? false,
    templateId: launch.templateId ?? COORDINATOR_TEMPLATE_ID
  }
}

/** The chat opens in the Chat view wherever native chat is on; a terminal otherwise. */
export function coordinatorViewMode(
  settings: { experimentalNativeChat?: boolean } | null | undefined
): 'chat' | 'terminal' {
  return nativeChatEnabledByPreference(settings) ? 'chat' : 'terminal'
}
