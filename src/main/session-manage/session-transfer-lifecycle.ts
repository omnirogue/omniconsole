import { randomUUID } from 'node:crypto'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { RuntimeTerminalCreate } from '../../shared/runtime-terminal-contracts'
import { isTuiAgent } from '../../shared/tui-agent-config'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { deriveRemoteRuntimeTerminalCreateHandle } from '../runtime/remote-runtime-terminal-create-identity'
import { SessionManagePartialError } from './session-manage-refusal'
import { transferArchiveTarget } from './session-transfer-archive'
import { watchNewTransferTarget } from './session-transfer-new-target'
import type { TransferSession } from './session-manage-transfer-contract'

type Journal = (
  action: 'session.create' | 'session.move',
  target: TransferSession,
  operation: unknown
) => Promise<void>
const CREATOR = 'session-transfer'

export async function createTransferTarget(
  runtime: OrcaRuntimeService,
  source: TransferSession,
  title: string,
  journal: Journal
) {
  const agent = source.entry.agent
  if (!isTuiAgent(agent)) {
    throw new Error(`Cannot launch agent kind ${agent}.`)
  }
  const operationId = randomUUID()
  const tabId = randomUUID()
  const leafId = randomUUID()
  const paneKey = makePaneKey(tabId, leafId)
  const worktreeId = source.entry.worktreeId
  const handle = deriveRemoteRuntimeTerminalCreateHandle(CREATOR, worktreeId, operationId)
  const target: TransferSession = {
    source: null,
    agentProcess: null,
    entry: {
      ...source.entry,
      paneKey,
      tabId,
      title,
      terminal: handle,
      kind: 'terminal',
      state: 'unknown',
      verdict: 'unverifiable',
      agentForeground: null
    },
    row: {
      ...source.row,
      paneKey,
      tabId,
      title,
      kind: 'terminal',
      structuredSessionId: null,
      viewKey: paneKey,
      rowKey: paneKey
    }
  }
  await journal('session.create', target, {
    operationId,
    handle,
    paneKey,
    tabId,
    leafId,
    worktreeId,
    agent,
    state: 'pending'
  })
  const proof = watchNewTransferTarget({ kind: 'pty', paneKey, worktreeId })
  let terminal: RuntimeTerminalCreate
  try {
    terminal = await runtime.dedupeTerminalCreate(
      CREATOR,
      `id:${worktreeId}`,
      operationId,
      false,
      (selector, preAllocatedHandle) =>
        runtime.createTerminal(selector, {
          launchCause: {
            trigger: 'session-transfer',
            reference: { transferId: operationId },
            requestId: operationId,
            parentPaneKey: source.entry.paneKey ?? undefined,
            actor: { kind: 'app' }
          },
          startupAgent: agent,
          title,
          activate: false,
          focus: false,
          surfaceOwner: false,
          tabId,
          leafId,
          preAllocatedHandle,
          isNewSession: true
        })
    )
  } catch (error) {
    // Reconcile only: the fallback must never launch a second terminal.
    try {
      terminal = await runtime.dedupeTerminalCreate(
        CREATOR,
        `id:${worktreeId}`,
        operationId,
        true,
        async () => {
          throw new Error('No matching created terminal was found.')
        }
      )
    } catch {
      proof.close()
      throw new SessionManagePartialError(
        error instanceof Error ? error.message : String(error),
        `creation ${operationId} may have created ${handle} at ${paneKey}; the operation was recorded before dispatch and must be reconciled before retrying`
      )
    }
  }
  if (
    terminal.handle !== handle ||
    terminal.worktreeId !== worktreeId ||
    runtime.getTerminalPaneKey(handle) !== paneKey ||
    !terminal.ptyId
  ) {
    proof.close()
    throw new SessionManagePartialError(
      'The creation receipt did not prove the reserved target identity.',
      `creation ${operationId} may have created ${handle} at ${paneKey}`
    )
  }
  proof.bind({ handle, ptyId: terminal.ptyId })
  return { target, proof }
}

export async function fileTransferTarget(
  runtime: Pick<OrcaRuntimeService, 'requestSessionFolders'>,
  target: TransferSession,
  source: TransferSession,
  journal: Journal
): Promise<void> {
  const operationId = randomUUID()
  const folderId = source.row.folderId ?? (source.row.saved ? 'saved-sessions' : null)
  const expiresAt = Date.now() + 10_000
  await journal('session.move', target, {
    operationId,
    target: transferArchiveTarget(target),
    folderId,
    expiresAt,
    state: 'pending'
  })
  const matches = (value: unknown) =>
    Boolean(
      value &&
      typeof value === 'object' &&
      'sessionKey' in value &&
      value.sessionKey === target.row.viewKey &&
      'folderId' in value &&
      value.folderId === folderId
    )
  let failure = 'The filing reply did not include the exact durable receipt.'
  try {
    const receipt = await runtime.requestSessionFolders({
      kind: 'fileTransferredSession',
      operationId,
      target: transferArchiveTarget(target),
      folderId,
      expiresAt
    })
    if (matches(receipt)) {
      return
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  }
  // Wait out a possibly queued request before interpreting the durable receipt's absence.
  const remaining = expiresAt - Date.now()
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining))
  }
  try {
    if (
      matches(await runtime.requestSessionFolders({ kind: 'readTransferFileReceipt', operationId }))
    ) {
      return
    }
  } catch {
    /* Unknown stays unknown; do not replay a mutation. */
  }
  throw new SessionManagePartialError(
    failure,
    `filing operation ${operationId} may have changed ${target.entry.title}; inspect its recorded operation receipt before retrying`
  )
}
