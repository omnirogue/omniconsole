import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import type { ConversationSource } from '../../shared/conversation-source'
import { parseExecutionHostId } from '../../shared/execution-host'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { PS_LSTART_TOLERANCE_MS, readPosixReceiverRowSync } from '../pty/posix-pty-foreground-group'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import type { TransferSession } from './session-manage-transfer-contract'

/** The source and acknowledged target must still be the same live execution at archive commit. */
export function captureTransferExecution(
  runtime: Pick<OrcaRuntimeService, 'resolveTerminalPane' | 'getTerminalProcessIncarnation'>,
  target: TransferSession
): () => boolean {
  const source = target.source
  if (!source) {
    throw new Error('The transfer has no bound conversation.')
  }
  if (source.kind === 'structured') {
    const host = getStructuredAgentSessionHost()
    const ownership = host?.outcomeSource.transferOwnership(source.paneKey, source.worktreeId)
    if (!host || !ownership) {
      throw new Error('The structured transfer has no live native owner.')
    }
    return () =>
      getStructuredAgentSessionHost() === host &&
      host.outcomeSource.transferOwnership(source.paneKey, source.worktreeId) === ownership
  }
  if (parseExecutionHostId(target.row.hostId)?.kind === 'ssh') {
    return captureRemoteTerminal(runtime, target, source)
  }
  const proof = target.agentProcess
  const handle = target.entry.terminal
  if (!proof || !handle) {
    throw new Error('The transfer has no bound terminal agent.')
  }
  const incarnation = runtime.getTerminalProcessIncarnation(handle)
  const root = readPosixReceiverRowSync(proof.rootPid)
  if (!incarnation || root?.startTimeMs == null) {
    throw new Error('The terminal owner is unreadable.')
  }
  const holds = (): boolean => {
    const live = runtime.resolveTerminalPane(source.paneKey, source.worktreeId)
    if (
      live.handle !== handle ||
      live.ptyId !== proof.ptyId ||
      live.connected !== true ||
      runtime.getTerminalProcessIncarnation(handle) !== incarnation
    ) {
      return false
    }
    const currentRoot = readPosixReceiverRowSync(proof.rootPid)
    const receiver = readPosixReceiverRowSync(proof.pid)
    return Boolean(
      currentRoot &&
      receiver &&
      currentRoot.startTimeMs === root.startTimeMs &&
      currentRoot.tty === root.tty &&
      receiver.tty === root.tty &&
      currentRoot.tpgid === proof.pgid &&
      receiver.pgid === proof.pgid &&
      receiver.tpgid === proof.pgid &&
      receiver.startTimeMs !== null &&
      Math.abs(receiver.startTimeMs - proof.startTimeMs) <= PS_LSTART_TOLERANCE_MS &&
      receiver.stat?.includes('+') &&
      !/[TXZ]/.test(receiver.stat) &&
      receiver.command &&
      recognizeAgentProcessFromCommandLine(receiver.command)?.agent === proof.agent
    )
  }
  if (!holds()) {
    throw new Error('The terminal transfer receiver changed.')
  }
  return holds
}

/**
 * A target on an SSH host (a `--host` move): its process table is on that host, so the fence is
 * what this computer owns, the same attached relay terminal incarnation at the same pane.
 */
function captureRemoteTerminal(
  runtime: Pick<OrcaRuntimeService, 'resolveTerminalPane' | 'getTerminalProcessIncarnation'>,
  target: TransferSession,
  source: ConversationSource
): () => boolean {
  const handle = target.entry.terminal
  const incarnation = handle ? runtime.getTerminalProcessIncarnation(handle) : null
  let ptyId: string | null = null
  const holds = (): boolean => {
    try {
      const live = runtime.resolveTerminalPane(source.paneKey, source.worktreeId)
      ptyId ??= live.ptyId
      return (
        live.handle === handle &&
        live.connected === true &&
        live.ptyId !== null &&
        live.ptyId === ptyId &&
        incarnation !== null &&
        runtime.getTerminalProcessIncarnation(live.handle) === incarnation
      )
    } catch {
      return false
    }
  }
  if (!handle || !holds()) {
    throw new Error('The remote target terminal is not attached on this computer.')
  }
  return holds
}
