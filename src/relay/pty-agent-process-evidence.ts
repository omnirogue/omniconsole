import type { IPty } from 'node-pty'
import type { TerminalAgentProcessProof } from '../shared/pty-agent-process-evidence'
import { recognizeAgentProcessFromCommandLine } from '../shared/agent-process-recognition'
import { getFreshProcessTableSnapshot } from '../shared/process-table-snapshot'
import { ptyAgentProcessEvidenceRequest } from '../shared/pty-agent-process-evidence'
import { readPtsName } from '../main/pty/node-pty-pts-name'
import {
  readPosixReceiverRowSync,
  readPosixSpawnRootRowSync
} from '../main/pty/posix-pty-foreground-group'
import {
  classifyTerminalProcessTree,
  findForegroundAgentProcess
} from '../main/runtime/terminal-agent-process'

export type RelayPtyProcessRoot = { pid: number; startTimeMs: number; tty: string }
type EvidenceOwner = {
  id: string
  incarnationId: string
  disposed?: boolean
  pty: Pick<IPty, 'pid'>
  inputGeneration?: number
  agentProcessRoot?: RelayPtyProcessRoot | null
}
const ttyName = (name: string) => name.replace(/^\/dev\//, '')

/** Capture at spawn, before a reused PID could be mistaken for this terminal's shell. */
export function captureRelayPtyProcessRoot(pty: Pick<IPty, 'pid'>): RelayPtyProcessRoot | null {
  const pts = readPtsName(pty)
  if (process.platform === 'win32' || !pts) {
    return null
  }
  const row = readPosixSpawnRootRowSync(pty.pid)
  const tty = ttyName(pts)
  // The child may not have called setsid/TIOCSCTTY yet; later proof still requires this exact TTY.
  return row?.startTimeMs != null &&
    (ttyName(row.tty) === tty || ['?', '??', '-'].includes(row.tty))
    ? { pid: pty.pid, startTimeMs: row.startTimeMs, tty }
    : null
}

export type RelayPtyAgentEvidence = NonNullable<
  Awaited<ReturnType<typeof readRelayPtyAgentProcessEvidence>>
>

/** Process observation may attach a separate owner-issued Ctrl+C ticket. */
export async function readRelayPtyAgentProcessEvidence(
  input: unknown,
  getOwner: (id: string) => EvidenceOwner | undefined,
  isCurrent: () => boolean,
  issueInterrupt?: (owner: EvidenceOwner, proof: TerminalAgentProcessProof) => string | undefined
) {
  const parsed = ptyAgentProcessEvidenceRequest.safeParse(input)
  if (!parsed.success || process.platform === 'win32' || !isCurrent()) {
    return null
  }
  const { id, incarnationId } = parsed.data
  const owner = getOwner(id)
  const root = owner?.agentProcessRoot
  if (!owner || owner.disposed || owner.incarnationId !== incarnationId || !root) {
    return null
  }
  const inputGeneration = owner.inputGeneration
  const rows = await getFreshProcessTableSnapshot()
  const currentRoot = readPosixReceiverRowSync(root.pid)
  if (
    !isCurrent() ||
    getOwner(id) !== owner ||
    owner.disposed ||
    owner.incarnationId !== incarnationId ||
    owner.agentProcessRoot !== root ||
    owner.inputGeneration !== inputGeneration ||
    owner.pty.pid !== root.pid ||
    currentRoot?.startTimeMs !== root.startTimeMs ||
    currentRoot.tty !== root.tty ||
    !rows.some((row) => row.pid === root.pid)
  ) {
    return null
  }
  const found = findForegroundAgentProcess(rows, root.pid, null)
  const receiver = found ? readPosixReceiverRowSync(found.pid) : null
  const agent = receiver?.command
    ? recognizeAgentProcessFromCommandLine(receiver.command)?.agent
    : null
  const holds =
    found &&
    receiver &&
    agent === found.agent &&
    receiver.tty === root.tty &&
    receiver.pgid === receiver.tpgid &&
    receiver.tpgid === currentRoot.tpgid &&
    receiver.startTimeMs !== null &&
    receiver.stat?.includes('+') &&
    !/[TXZ]/.test(receiver.stat)
  const proof: TerminalAgentProcessProof | null = holds
    ? {
        ...found,
        ptyId: id,
        incarnationId,
        rootPid: root.pid,
        pgid: receiver.pgid,
        startTimeMs: receiver.startTimeMs!
      }
    : null
  const interruptToken = proof ? issueInterrupt?.(owner, proof) : undefined
  return {
    id,
    incarnationId,
    proof: proof && interruptToken ? { ...proof, interruptToken } : proof,
    tree: classifyTerminalProcessTree(rows, root.pid, null)
  }
}
