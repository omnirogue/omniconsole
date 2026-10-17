/**
 * R2, pure: a workspace whose every terminal tab holds only local shells with nothing running in
 * them (no child process), off screen (G3), untouched by a person (G2), with no input or output for
 * the idle window, and which holds no agent state at all. Such a workspace is put to sleep the way
 * a person's Sleep does it: every shell stops and keeps its history, and opening the workspace
 * restores each one in place. Why whole workspaces: that stop has a wake (activating a workspace
 * whose tabs are all dead remounts every pane, which cold-restores its history into a fresh shell
 * at the same cwd), while a single stopped tab in a workspace that stays alive has none. A tab is
 * never closed, so no scrollback is lost (G6). Unknown means keep. The coordinator re-reads G1-G3
 * and the processes before it acts.
 */

import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import type { PtyListedSession } from '../../../../shared/pty-listed-session'
import type { RuntimeTerminalSummary } from '../../../../shared/runtime-terminal-contracts'
import { isShellProcess } from '../../../../shared/shell-process-detection'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  IDLE_RULE,
  IDLE_RECENT_TOUCH_MS,
  type HibernationEvidence
} from '../../../../shared/idle-auto-close-settings'
import {
  isLocalDaemonPtyId,
  type IdleDecision,
  type IdleShellTab,
  type ProcessInspection
} from './idle-auto-close-decision'
import type { IdleKeptSessions } from './idle-auto-close-keep'

function finite(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export type BareShellInputs = {
  now: number
  idleMs: number
  /** The workspace on screen; it is never put to sleep (a person is in it). */
  activeWorktreeId: string | null
  tabsByWorktree: Record<string, TerminalTab[]>
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot | undefined>
  nonLocalWorktreeIds: ReadonlySet<string>
  /** G3, the same predicate agent sleep uses (the panes' own isVisibleRef, then the page's list). */
  isOnScreen: (tabId: string) => boolean
  foregroundLastSeenAtByTabId: Record<string, number | undefined>
  /** G2: the newest reveal, keystroke or person attach for the tab's panes and PTYs. */
  lastHumanTouchAt: (tabId: string, paneKeys: string[], ptyIds: string[]) => number
  /** G5: the pane holds a mid-task agent's 'quit'/'live' record. */
  isInterruptedRestorePane: (paneKey: string) => boolean
  isPinned: (worktreeId: string, tabId: string) => boolean
  /** Saved and pinned sidebar rows; null when unread (then every shell is kept). */
  kept: IdleKeptSessions | null
  agentStatusByPaneKey: Record<string, unknown>
  sleepingAgentSessionsByPaneKey: Record<string, unknown>
  /** The pane held an agent earlier this app session: its scrollback is that agent's transcript. */
  heldAgentThisSession: (paneKey: string) => boolean
  /**
   * Any agent row, retained card, sleeping record, launch config or foreground agent in the
   * workspace: the workspace stop drops those, so a workspace holding any of them stays.
   */
  holdsAgentState: (worktreeId: string) => boolean
  /** Tabs still launching something (pending startup, native chat launch). */
  launchingTabIds: ReadonlySet<string>
  lastInputAtByPaneKey: Record<string, number | undefined>
  daemonSessionsById: ReadonlyMap<string, PtyListedSession>
  /** The local runtime's terminals by PTY id; null when the listing failed (keep everything). */
  runtimeTerminalsByPtyId: ReadonlyMap<string, RuntimeTerminalSummary> | null
  firstObservedAtByPtyId: ReadonlyMap<string, number>
  /** Process inspections done so far; a PTY missing here is returned in `inspect`. */
  processByPtyId: ReadonlyMap<string, ProcessInspection>
}

export type BareShellPlan = { decisions: IdleDecision[]; inspect: string[] }

type LeafFacts = { paneKey: string; ptyId: string }

/** One tab's verdict: idle (maybe still awaiting process inspections), or why it stays. */
type TabVerdict =
  | { kind: 'idle'; shell: IdleShellTab; idleSince: number; pending: string[]; facts: TabFacts }
  | { kind: 'kept'; reason: string }

type TabFacts = { lastOutputAt: number; lastInputAt: number; lastTouchAt: number }

export function planIdleShellWorkspaces(inputs: BareShellInputs): BareShellPlan {
  const decisions: IdleDecision[] = []
  const inspect: string[] = []
  for (const [worktreeId, tabs] of Object.entries(inputs.tabsByWorktree)) {
    if (tabs.length === 0) {
      continue
    }
    const skip = (reason: string): void => {
      decisions.push({
        rule: IDLE_RULE.R2,
        key: worktreeId,
        verdict: 'skip',
        reason,
        evidence: { worktreeId },
        signature: '',
        worktreeId,
        target: {}
      })
    }
    if (worktreeId === inputs.activeWorktreeId) {
      skip('active-workspace')
      continue
    }
    if (inputs.nonLocalWorktreeIds.has(worktreeId)) {
      skip('not-local')
      continue
    }
    const verdicts = tabs.map((tab) => tabVerdict(inputs, worktreeId, tab))
    // Why every tab: one busy, touched or unknown tab keeps the whole workspace awake.
    const kept = verdicts.find((verdict) => verdict.kind === 'kept')
    if (kept) {
      skip(kept.reason)
      continue
    }
    const idle = verdicts as Extract<TabVerdict, { kind: 'idle' }>[]
    const pending = idle.flatMap((verdict) => verdict.pending)
    if (pending.length > 0) {
      inspect.push(...pending)
      skip('inspect-pending')
      continue
    }
    const processReason = bareShellProcessGate(
      inputs,
      idle.flatMap((verdict) => verdict.shell.ptyIds)
    )
    if (processReason) {
      skip(processReason)
      continue
    }
    if (inputs.holdsAgentState(worktreeId)) {
      skip('agent-state')
      continue
    }
    decisions.push(workspaceAct(inputs, worktreeId, idle))
  }
  return { decisions, inspect }
}

function workspaceAct(
  inputs: BareShellInputs,
  worktreeId: string,
  idle: readonly Extract<TabVerdict, { kind: 'idle' }>[]
): IdleDecision {
  const shellTabs = idle.map((verdict) => verdict.shell)
  const ptyIds = shellTabs.flatMap((shell) => shell.ptyIds)
  const idleSince = Math.max(...idle.map((verdict) => verdict.idleSince))
  const evidence: HibernationEvidence = {
    worktreeId,
    tabIds: shellTabs.map((shell) => shell.tabId).join(','),
    tabs: shellTabs.length,
    ptyIds: ptyIds.join(','),
    idleSinceMs: Math.max(0, inputs.now - idleSince),
    idleMs: inputs.idleMs,
    lastOutputAt: Math.max(...idle.map((verdict) => verdict.facts.lastOutputAt)) || null,
    lastInputAt: Math.max(...idle.map((verdict) => verdict.facts.lastInputAt)) || null,
    lastTouchAt: Math.max(...idle.map((verdict) => verdict.facts.lastTouchAt)) || null,
    foregroundProcess: inputs.processByPtyId.get(ptyIds[0]!)?.foregroundProcess ?? null,
    hasChildProcesses: false,
    keepsHistory: true
  }
  return {
    rule: IDLE_RULE.R2,
    key: worktreeId,
    verdict: 'act',
    reason: 'idle',
    evidence,
    signature: idle
      .map((verdict) => `${verdict.shell.tabId}|${[...verdict.shell.ptyIds].sort().join(',')}`)
      .sort()
      .concat(String(idleSince))
      .join('|'),
    worktreeId,
    target: {},
    shellTabs
  }
}

function tabVerdict(inputs: BareShellInputs, worktreeId: string, tab: TerminalTab): TabVerdict {
  const tabReason = bareShellTabGate(inputs, worktreeId, tab)
  if (tabReason) {
    return { kind: 'kept', reason: tabReason }
  }
  const leaves: LeafFacts[] = []
  for (const [leafId, ptyId] of Object.entries(
    inputs.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {}
  )) {
    let paneKey: string
    try {
      paneKey = makePaneKey(tab.id, leafId)
    } catch {
      return { kind: 'kept', reason: 'no-layout' }
    }
    const leafReason = bareShellLeafGate(inputs, paneKey, ptyId)
    if (leafReason) {
      return { kind: 'kept', reason: leafReason }
    }
    leaves.push({ paneKey, ptyId: ptyId! })
  }
  // Why every leaf: a split with one busy or unknown leaf is not a bare shell.
  if (leaves.length === 0) {
    return { kind: 'kept', reason: 'no-layout' }
  }
  const runtimeTerminals = inputs.runtimeTerminalsByPtyId!
  const paneKeys = leaves.map((leaf) => leaf.paneKey)
  const ptyIds = leaves.map((leaf) => leaf.ptyId)
  const lastOutputAt = Math.max(
    ...ptyIds.map((ptyId) => finite(runtimeTerminals.get(ptyId)?.lastOutputAt))
  )
  const lastInputAt = Math.max(
    ...paneKeys.map((paneKey) => finite(inputs.lastInputAtByPaneKey[paneKey]))
  )
  const foregroundLastSeenAt = finite(inputs.foregroundLastSeenAtByTabId[tab.id])
  const lastTouchAt = inputs.lastHumanTouchAt(tab.id, paneKeys, ptyIds)
  // Why first observed: a restored PTY reports no output time, so it waits a full window from
  // the moment this window first saw it.
  const firstObservedAt = Math.max(
    ...ptyIds.map((ptyId) => finite(inputs.firstObservedAtByPtyId.get(ptyId)))
  )
  const idleSince = Math.max(lastOutputAt, lastInputAt, foregroundLastSeenAt, firstObservedAt)
  if (lastTouchAt > 0 && inputs.now - lastTouchAt < IDLE_RECENT_TOUCH_MS) {
    return { kind: 'kept', reason: 'recent-touch' }
  }
  if (inputs.now - idleSince < inputs.idleMs) {
    return { kind: 'kept', reason: 'idle-too-short' }
  }
  // Why the idle checks first: a process inspection may run a process listing in main, so only
  // shells that are otherwise idle ask for one.
  return {
    kind: 'idle',
    shell: { tabId: tab.id, paneKeys, ptyIds },
    idleSince,
    pending: ptyIds.filter((ptyId) => !inputs.processByPtyId.has(ptyId)),
    facts: { lastOutputAt, lastInputAt, lastTouchAt }
  }
}

function bareShellTabGate(
  inputs: BareShellInputs,
  worktreeId: string,
  tab: TerminalTab
): string | null {
  if (inputs.isOnScreen(tab.id)) {
    return 'visible'
  }
  if (inputs.isPinned(worktreeId, tab.id) || inputs.kept?.tabIds.has(tab.id)) {
    return 'pinned'
  }
  if (!inputs.kept) {
    return 'keep-unknown'
  }
  if (inputs.launchingTabIds.has(tab.id)) {
    return 'launching'
  }
  if (!inputs.runtimeTerminalsByPtyId) {
    return 'runtime-unavailable'
  }
  return null
}

function bareShellLeafGate(
  inputs: BareShellInputs,
  paneKey: string,
  ptyId: string | null | undefined
): string | null {
  if (!ptyId) {
    return 'leaf-without-pty'
  }
  if (!isLocalDaemonPtyId(ptyId)) {
    return 'not-local'
  }
  if (inputs.kept?.paneKeys.has(paneKey)) {
    return 'saved'
  }
  if (inputs.isInterruptedRestorePane(paneKey)) {
    return 'interrupted-restore'
  }
  if (inputs.agentStatusByPaneKey[paneKey] || inputs.sleepingAgentSessionsByPaneKey[paneKey]) {
    return 'agent-pane'
  }
  if (inputs.heldAgentThisSession(paneKey)) {
    return 'agent-history'
  }
  const session = inputs.daemonSessionsById.get(ptyId)
  if (!session) {
    return 'pty-not-live'
  }
  if (session.agentOwnership !== 'absent') {
    return session.agentOwnership === 'present' ? 'agent-owned' : 'owner-unknown'
  }
  if (inputs.runtimeTerminalsByPtyId?.get(ptyId)?.agentIdentity) {
    return 'agent-pane'
  }
  return null
}

function bareShellProcessGate(inputs: BareShellInputs, ptyIds: readonly string[]): string | null {
  for (const ptyId of ptyIds) {
    const process = inputs.processByPtyId.get(ptyId)
    if (!process || process.unavailable) {
      return 'process-unknown'
    }
    if (process.hasChildProcesses) {
      return 'has-children'
    }
    if (!process.foregroundProcess || !isShellProcess(process.foregroundProcess)) {
      return 'foreground-not-shell'
    }
  }
  return null
}
