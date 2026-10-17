import { randomUUID } from 'node:crypto'
import type { SessionManageArchiveTarget } from '../../shared/session-manage-relay'
import { registerTransferArchiveCommit } from '../runtime/session-transfer-archive-commit'
import type { SessionArchiveOutcome } from '../../shared/session-transfer-types'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import type { TransferSession } from './session-manage-transfer-contract'

export function transferArchiveTarget({ row }: TransferSession): SessionManageArchiveTarget {
  return {
    paneKey: row.paneKey!,
    viewKey: row.viewKey,
    worktreeId: row.worktreeId,
    tabId: row.tabId,
    kind: row.kind,
    structuredSessionId: row.structuredSessionId,
    hostId: row.hostId
  }
}

/** A receipt and all archive flags are saved in the same canonical storage write. */
export async function archiveTransferredSources(
  runtime: Pick<OrcaRuntimeService, 'requestSessionFolders'>,
  sources: TransferSession[],
  reason: string,
  guard: () => boolean,
  target: TransferSession
): Promise<SessionArchiveOutcome> {
  const targets = sources.map(transferArchiveTarget)
  const keys = targets.map((target) => target.viewKey)
  const operationId = randomUUID()
  const expiresAt = Date.now() + 10_000
  const commit = registerTransferArchiveCommit(guard, expiresAt, operationId, keys)
  let failure = 'The archive reply did not confirm the requested sources.'
  try {
    const reply = await runtime.requestSessionFolders({
      kind: 'archiveSessions',
      targets,
      reason,
      expiresAt,
      operationId,
      commitToken: commit.token,
      acknowledgedTarget: transferArchiveTarget(target)
    })
    if (
      reply &&
      typeof reply === 'object' &&
      'operationId' in reply &&
      reply.operationId === operationId &&
      'archived' in reply &&
      JSON.stringify(reply.archived) === JSON.stringify(targets)
    ) {
      return { status: 'archived' }
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  } finally {
    // Default-deny any request queued beyond the reply/timeout. Never repeat the mutation.
    commit.close()
  }
  try {
    const receipt = await runtime.requestSessionFolders({
      kind: 'readTransferArchiveReceipt',
      operationId
    })
    if (JSON.stringify(receipt) === JSON.stringify(keys)) {
      return { status: 'archived' }
    }
  } catch {
    /* An unavailable persisted receipt is an unknown outcome. */
  }
  return {
    status: 'unknown',
    reason: `${failure} The durable archive receipt could not be verified; inspect the sources before retrying.`
  }
}
