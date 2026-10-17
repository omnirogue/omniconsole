import type { HandlerContext } from '../dispatch'
import { getOptionalStringFlag } from '../flags'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'
import { resolveSessionTarget, type SessionTarget } from './session-folder-target'

export function refuseRemote(client: RuntimeClient): void {
  if (client.isRemote) {
    throw new RuntimeClientError(
      'permission_denied',
      'Sessions can only be managed by the omni CLI on the computer running OmniConsole.'
    )
  }
}

/** Another session, named explicitly: these commands never default to the one they run in. */
export async function explicitTarget(
  client: RuntimeClient,
  flags: HandlerContext['flags']
): Promise<SessionTarget> {
  if (
    getOptionalStringFlag(flags, 'pane') === undefined &&
    getOptionalStringFlag(flags, 'terminal') === undefined &&
    getOptionalStringFlag(flags, 'ref') === undefined
  ) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Name the session with --pane <paneKey> (from omni session list), --terminal <handle> or --ref <ref> (from omni session search).'
    )
  }
  return resolveSessionTarget(client, flags)
}
