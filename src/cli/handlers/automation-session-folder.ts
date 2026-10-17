import { SESSION_FOLDER_AUTOMATIONS_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import type { RuntimeStatus } from '../../shared/runtime-types'
import {
  SESSION_PROJECTS_RPC,
  type SessionProjectReadResult
} from '../../shared/session-project-cli'
import type { CommandHandler } from '../dispatch'
import { getOptionalStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime-client'

type HandlerArgs = Parameters<CommandHandler>[0]

/** `--folder <project>`: each run joins that project (upgrade plan PR 12), stored by folder id. */
export async function getAutomationSessionFolder(
  flags: HandlerArgs['flags'],
  client: HandlerArgs['client']
): Promise<{ sessionFolder?: string }> {
  const ref = getOptionalStringFlag(flags, 'folder')
  if (!ref) {
    return {}
  }
  // Why: an older runtime strips the unknown field, so the routine would silently run outside it.
  const status = await client.call<RuntimeStatus>('status.get')
  if (!status.result.capabilities?.includes(SESSION_FOLDER_AUTOMATIONS_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'The connected OmniConsole runtime does not support --folder on routines. Update or restart OmniConsole and try again.'
    )
  }
  const read = await client.call<SessionProjectReadResult>(SESSION_PROJECTS_RPC.show, {
    folder: ref
  })
  const project = read.result.project
  if (!project?.settings) {
    throw new RuntimeClientError(
      'invalid_argument',
      `“${read.result.folder.path}” is not in a project. A person sets a folder up as one in OmniConsole.`
    )
  }
  return { sessionFolder: project.folderId }
}
