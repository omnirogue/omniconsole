import type { SessionHostOrigin } from '../../shared/session-host-authority'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import { runRemoteSessionAction } from './remote-session-action'
import { getRemoteSessionHosts } from './remote-session-hosts-runtime'
import { isRemoteSessionRow, remoteRefusalText } from './remote-session-manage'

/** Both UI and CLI archive use the owner's fenced, recorded organization change path. */
export async function archiveRemoteSession(
  row: SessionManageSidebarRow,
  archived: boolean,
  origin: SessionHostOrigin,
  dryRun = false
) {
  if (!isRemoteSessionRow(row) || row.ownershipUnverified) {
    throw new Error('The owning computer of this session could not be verified. Nothing changed.')
  }
  const hosts = getRemoteSessionHosts()
  const client = hosts ? await hosts.clientFor(row.hostId!) : null
  if (!hosts || !client) {
    throw new Error('The computer that runs this session could not be reached. Nothing changed.')
  }
  const outcome = await runRemoteSessionAction(
    {
      client,
      directory: hosts.directory,
      newOperationId: () => hosts.newOperationId()
    },
    {
      connection: row.hostId!,
      target: {
        ...(row.ownerTarget ?? { paneKey: row.paneKey, tabId: row.tabId }),
        provider: row.providerSessionId
          ? { agent: row.agent, sessionId: row.providerSessionId }
          : null
      },
      action: archived ? 'archive' : 'unarchive',
      payload: {},
      origin,
      dryRun
    }
  )
  if (outcome.kind === 'refused') {
    throw new Error(remoteRefusalText(outcome))
  }
  return outcome
}
