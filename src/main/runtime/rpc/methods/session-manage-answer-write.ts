import type { PtyLivenessVerdict } from '../../../../shared/pty-liveness-verdict'
import type { TerminalAgentProcessProof } from '../../terminal-agent-process'

/** The same pid, start time, root and terminal incarnation: one agent process, not a successor. */
export function sameAgentProcess(
  a: TerminalAgentProcessProof,
  b: TerminalAgentProcessProof
): boolean {
  return (
    a.ptyId === b.ptyId &&
    a.incarnationId === b.incarnationId &&
    a.rootPid === b.rootPid &&
    a.pid === b.pid &&
    a.startTimeMs === b.startTimeMs
  )
}

/**
 * Contrary evidence refuses; it is never the proof. The runtime records a liveness verdict only
 * when something is in doubt (`unverifiable`, or `live` after a stop that failed), so `null` means
 * nothing is recorded against this PTY. Anything but `null` or a `live` naming this PTY
 * (`undefined`, `unverifiable`, `exited`, an empty or other PTY list) contradicts the write.
 */
export function livenessContradicts(
  verdict: PtyLivenessVerdict | null | undefined,
  ptyId: string
): boolean {
  return !(verdict === null || (verdict?.status === 'live' && verdict.ptyIds.includes(ptyId)))
}

/**
 * Why a keystroke may not be reserved now, or null. The positive evidence is the process proof:
 * `beforeWrite` ran and passed for THIS keystroke (the bound agent pid and start time, a
 * descendant of the terminal's root in its foreground process group, on this PTY incarnation),
 * and that same bound proof is still the one this answer was checked against. On top of it the
 * pane must still be connected to this exact PTY, nothing may contradict its liveness, and an
 * agent that reported through its hook must still report waiting.
 */
export function answerWriteRefusal(input: {
  ptyId: string
  delivery: { handle: string; ptyId: string }
  pane: { handle: string; ptyId: string | null; connected?: boolean }
  /** The proof `beforeWrite` verified for this very keystroke; null when it did not run or pass. */
  provenProcess: TerminalAgentProcessProof | null
  /** The answer's process binding now. */
  boundProcess: TerminalAgentProcessProof | null
  /** The agent process this answer was checked against from its first reading. */
  expectedProcess: TerminalAgentProcessProof
  livenessVerdict: PtyLivenessVerdict | null | undefined
  hook: { state: string } | null | undefined
  hookRequired: boolean
}): string | null {
  const { ptyId, delivery, pane, provenProcess, hook } = input
  if (!provenProcess || provenProcess.ptyId !== ptyId) {
    return 'The agent process was not proven (by pid, start time and foreground) for this keystroke.'
  }
  if (
    provenProcess !== input.boundProcess ||
    !sameAgentProcess(provenProcess, input.expectedProcess)
  ) {
    return 'The answer is no longer bound to the agent process it was checked against.'
  }
  if (
    ptyId !== delivery.ptyId ||
    pane.ptyId !== ptyId ||
    pane.handle !== delivery.handle ||
    pane.connected !== true
  ) {
    return 'The pane is no longer connected to the terminal this answer was for.'
  }
  if (livenessContradicts(input.livenessVerdict, ptyId)) {
    return 'Its terminal has contrary liveness evidence.'
  }
  if (hook ? hook.state !== 'blocked' && hook.state !== 'waiting' : input.hookRequired) {
    return "The agent's own report no longer says it is waiting at this prompt."
  }
  return null
}
