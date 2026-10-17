import { readAutomaticCleanupProtection } from './automatic-session-cleanup-protection'
/**
 * What agent hibernation (R1) re-reads for one confirmed pane immediately before it acts (G4):
 * G3 on screen, the thrash breaker, G2 a recent touch, G5 a mid-task restore record, G1 an open
 * ask (the window's words, then main's Stage A1 reading), and positive proof that the pane's own
 * agent holds the terminal and is idle. The cheap window-side checks run again after the async
 * readings, right before the act.
 */

import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  keepReasonFromReading,
  type HibernationEvidence,
  type IdleKeepReading,
  type IdleKeepReason
} from '../../../shared/idle-auto-close-settings'
import { isShellProcess } from '../../../shared/shell-process-detection'
import type { AgentHibernationCandidate } from './agent-hibernation-planner'
import { getRuntimeTerminalHandle } from './agent-hibernation-runtime-liveness'
import { isThrashExempt } from './agent-sleep-wake-tracker'
import {
  isInterruptedRestoreRecord,
  isRecentHumanTouch,
  isTerminalTabOnScreen,
  lastHumanTouchAt,
  paneHoldsOpenAsk,
  readKeepReadingsFromMain
} from './idle-auto-close/idle-keep-guards'
import { getRuntimeEnvironmentIdForWorktree } from './worktree-runtime-owner'
import { reviewSleepTargetFor } from './review-sleep-targets'

export type ProcessInspection = {
  foregroundProcess: string | null
  hasChildProcesses: boolean
  unavailable?: true
}

export type AgentSleepGuardDeps = {
  readProtection: typeof readAutomaticCleanupProtection
  readKeep(targets: { worktreeId: string; paneKey: string }[]): Promise<IdleKeepReading[]>
  inspectProcess(ptyId: string, runtimeEnvironmentId: string | null): Promise<ProcessInspection>
}

const UNAVAILABLE: ProcessInspection = {
  foregroundProcess: null,
  hasChildProcesses: false,
  unavailable: true
}

const defaultDeps: AgentSleepGuardDeps = {
  readProtection: readAutomaticCleanupProtection,
  readKeep: readKeepReadingsFromMain,
  inspectProcess: async (ptyId, runtimeEnvironmentId) => {
    try {
      if (!runtimeEnvironmentId) {
        return await window.api.pty.inspectProcess(ptyId)
      }
      const handle = getRuntimeTerminalHandle(ptyId)
      if (!handle) {
        return UNAVAILABLE
      }
      const result = await callRuntimeRpc<{ process?: ProcessInspection }>(
        { kind: 'environment', environmentId: runtimeEnvironmentId },
        'terminal.inspectProcess',
        { terminal: handle },
        { timeoutMs: 10_000 }
      )
      return result.process ?? UNAVAILABLE
    } catch {
      return UNAVAILABLE
    }
  }
}

let deps: AgentSleepGuardDeps = defaultDeps

export function setAgentSleepGuardDepsForTests(next: Partial<AgentSleepGuardDeps> | null): void {
  deps = next ? { ...defaultDeps, ...next } : defaultDeps
}

/** The window-side keeps: G3, the thrash breaker, G2, G5 and G1 from the pane's own words. */
export function windowKeepReason(
  candidate: AgentHibernationCandidate,
  now: number
): { reason: IdleKeepReason | null; touchAt: number } {
  const state = useAppStore.getState()
  if (isTerminalTabOnScreen(candidate.tabId)) {
    return { reason: 'visible', touchAt: 0 }
  }
  // Why: a review wait was armed by the session's own publish, not undone by a person's wake.
  const review = reviewSleepTargetFor(candidate.paneKey, candidate.worktreeId)
  if (!review && isThrashExempt(candidate.paneKey)) {
    return { reason: 'thrash-exempt', touchAt: 0 }
  }
  const touchAt = lastHumanTouchAt({
    state,
    tabId: candidate.tabId,
    paneKeys: candidate.paneKeys,
    ptyIds: candidate.targetPtyIds,
    now
  })
  if (isRecentHumanTouch(touchAt, now)) {
    return { reason: 'recent-touch', touchAt }
  }
  if (
    isInterruptedRestoreRecord(
      state.sleepingAgentSessionsByPaneKey[candidate.paneKey],
      state.agentStatusByPaneKey[candidate.paneKey]
    )
  ) {
    return { reason: 'interrupted-restore', touchAt }
  }
  // Why: the review page is the session's open question in its words; a live prompt still holds it.
  if (
    review
      ? Boolean(state.agentStatusByPaneKey[candidate.paneKey]?.interactivePrompt)
      : paneHoldsOpenAsk(state, candidate.paneKey)
  ) {
    return { reason: 'open-ask', touchAt }
  }
  return {
    reason: deps.readProtection(state, candidate, now, { ignoreStartedToday: Boolean(review) }),
    touchAt
  }
}

export type AgentSleepGuardVerdict = {
  keep: IdleKeepReason | null
  evidence: HibernationEvidence
}

/**
 * R1's process proof, after G1 passed: null only when main proves the pane's own agent holds the
 * terminal (`agentForeground`) and reads it idle, and the process table agrees nothing else does.
 * Why positive proof: a stale done entry outlives its agent, and a person may run a dev server,
 * an editor or ssh in that pane afterwards; anything not proven keeps the pane.
 */
export function agentProcessKeepReason(
  reading: IdleKeepReading,
  inspection: ProcessInspection
): IdleKeepReason | null {
  if (inspection.unavailable || !inspection.foregroundProcess) {
    return 'process-unknown'
  }
  // A leading '-' is how a login shell names itself.
  const shellForeground = isShellProcess(inspection.foregroundProcess.replace(/^-/, ''))
  if (shellForeground && !inspection.hasChildProcesses && reading.agentForeground !== true) {
    // Why drop, not sleep: killing the bare shell and writing a resume record re-armed dead
    // agents, which the next restart resumed (12 such panes on 2026-09-30).
    return 'shell-foreground'
  }
  if (shellForeground || reading.agentForeground === false || reading.state === 'exited') {
    // A suspended agent (shell with children), another program, or an agent main saw exit.
    return 'foreground-not-agent'
  }
  if (reading.agentForeground !== true) {
    return 'process-unknown'
  }
  // Why only idle: 'unknown' (nothing proves its state, or another host runs it) cannot rule out
  // an open ask (G1), so unknown means keep.
  return reading.state === 'idle' ? null : 'unreadable'
}

/** Most panes one `idleAutoClose.keepReadings` call reads; main lists the sidebar once per call. */
export const AGENT_SLEEP_READINGS_PER_CALL = 20

/** main's G1 reading for each pane, 20 per call; a pane main could not read is missing. */
export async function readAgentSleepKeepReadings(
  targets: readonly { worktreeId: string; paneKey: string }[]
): Promise<Map<string, IdleKeepReading>> {
  const readingByPaneKey = new Map<string, IdleKeepReading>()
  for (let start = 0; start < targets.length; start += AGENT_SLEEP_READINGS_PER_CALL) {
    const readings = await deps.readKeep(
      targets.slice(start, start + AGENT_SLEEP_READINGS_PER_CALL)
    )
    for (const reading of readings) {
      readingByPaneKey.set(reading.paneKey, reading)
    }
  }
  return readingByPaneKey
}

/**
 * G1-G3 and the process proof for several confirmed panes at once: the window-side keeps first,
 * then ONE main reading per 20 panes (main lists the sidebar rows once per call, not once per
 * pane), the process table for the panes main let through, and the window-side keeps once more.
 */
export async function readAgentSleepVerdicts(
  candidates: readonly AgentHibernationCandidate[],
  now: number
): Promise<Map<string, AgentSleepGuardVerdict>> {
  const verdicts = new Map<string, AgentSleepGuardVerdict>()
  const toRead: AgentHibernationCandidate[] = []
  for (const candidate of candidates) {
    const first = windowKeepReason(candidate, now)
    const evidence: HibernationEvidence = { lastTouchAt: first.touchAt || null }
    verdicts.set(candidate.id, { keep: first.reason, evidence })
    if (!first.reason) {
      toRead.push(candidate)
    }
  }
  const readingByPaneKey = await readAgentSleepKeepReadings(
    toRead.map((candidate) => ({ worktreeId: candidate.worktreeId, paneKey: candidate.paneKey }))
  )
  for (const candidate of toRead) {
    const verdict = verdicts.get(candidate.id)!
    verdict.keep = await processVerdict(
      candidate,
      readingByPaneKey.get(candidate.paneKey),
      verdict.evidence
    )
    // G4: the person may have opened or typed into it while main and the process table answered.
    verdict.keep ??= windowKeepReason(candidate, now).reason
  }
  return verdicts
}

/** G1 from main's reading, then the process proof; fills `evidence` with what it read. */
async function processVerdict(
  candidate: AgentHibernationCandidate,
  reading: IdleKeepReading | undefined,
  evidence: HibernationEvidence
): Promise<IdleKeepReason | null> {
  evidence.state = reading?.state ?? null
  evidence.agentForeground = reading?.agentForeground ?? null
  // Why unlisted keeps: every agent pane has a sidebar row; without one, G1 cannot be read.
  if (!reading || !reading.listed) {
    return 'unreadable'
  }
  const review = reviewSleepTargetFor(candidate.paneKey, candidate.worktreeId)
  const readingKeep = keepReasonFromReading(review ? { ...reading, openAsk: false } : reading)
  if (readingKeep) {
    return readingKeep
  }
  const ptyId = candidate.targetPtyIds[0]
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(
    useAppStore.getState(),
    candidate.worktreeId
  )
  const inspection = ptyId ? await deps.inspectProcess(ptyId, runtimeEnvironmentId) : UNAVAILABLE
  evidence.foregroundProcess = inspection.foregroundProcess
  evidence.hasChildProcesses = inspection.hasChildProcesses
  return agentProcessKeepReason(reading, inspection)
}

/** The same reading for the one pane about to be acted on, immediately before the act (G4). */
export async function checkAgentSleepGuards(
  candidate: AgentHibernationCandidate,
  now: number
): Promise<AgentSleepGuardVerdict> {
  return (await readAgentSleepVerdicts([candidate], now)).get(candidate.id)!
}
