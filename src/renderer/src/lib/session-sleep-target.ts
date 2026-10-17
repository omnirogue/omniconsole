import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { translate } from '@/i18n/i18n'
import { getAgentResumeArgv, isResumableTuiAgent } from '../../../shared/agent-session-resume'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { isAutomaticHibernationAllowed } from './live-resume-anchor-record'
import { isPtyLocked } from './pane-manager/mobile-driver-state'
import type { SidebarSession } from './sidebar-sessions'
import {
  resolveWorkspaceTerminalHostAuthority,
  type WorkspaceTerminalHostAuthority
} from './workspace-terminal-host-authority'
import { getRuntimeEnvironmentIdForWorktree } from './worktree-runtime-owner'

export type SessionSleepState = Pick<
  AppState,
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'ptyIdsByTabId'
  | 'agentStatusByPaneKey'
  | 'retainedAgentsByPaneKey'
  | 'sleepingAgentSessionsByPaneKey'
>

/** What the execution host lets this client do with the pane's PTY. */
export type SessionSleepHost = {
  runtimeEnvironmentId: string | null
  authority: WorkspaceTerminalHostAuthority
  isPhoneDriving: (ptyId: string) => boolean
}

export type SessionSleepTarget = {
  worktreeId: string
  tabId: string
  leafId: string
  paneKey: string
  ptyId: string
}

export type SessionSleepRefusal =
  | 'not-terminal'
  | 'no-live-pty'
  | 'not-resumable'
  | 'paired-host'
  | 'unverifiable-host'
  | 'phone-driving'
  | 'resume-blocked'

export type SessionSleepPlan =
  | { ok: true; target: SessionSleepTarget }
  | { ok: false; reason: SessionSleepRefusal }

type SleepableRow = Pick<SidebarSession, 'kind' | 'worktreeId' | 'tabId' | 'paneKey'>

function hasResumableIdentity(state: SessionSleepState, paneKey: string): boolean {
  const entry = state.agentStatusByPaneKey[paneKey] ?? state.retainedAgentsByPaneKey[paneKey]?.entry
  if (
    entry &&
    entry.terminalResumeEligible !== false &&
    isResumableTuiAgent(entry.agentType) &&
    entry.providerSession &&
    getAgentResumeArgv(entry.agentType, entry.providerSession)
  ) {
    return true
  }
  // Why: Pi-style agents keep their resume identity only in a live checkpoint record.
  const checkpoint = state.sleepingAgentSessionsByPaneKey[paneKey]
  return Boolean(
    checkpoint?.origin === 'live' &&
    getAgentResumeArgv(checkpoint.agent, checkpoint.providerSession)
  )
}

/** The pane's live PTY bound to its leaf, or null when nothing is running there. */
export function livePtyIdForSessionPane(
  state: Pick<SessionSleepState, 'terminalLayoutsByTabId' | 'ptyIdsByTabId'>,
  tabId: string,
  leafId: string
): string | null {
  const ptyId = state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId]
  return ptyId && (state.ptyIdsByTabId[tabId] ?? []).includes(ptyId) ? ptyId : null
}

/**
 * Decide whether a Conversations row can be put to sleep, and which pane/PTY that kills. Only a
 * live, resumable agent this client can stop and verify qualifies; everything else is refused so
 * a sleep never loses the conversation's resume identity.
 */
export function planSessionSleep(
  state: SessionSleepState,
  session: SleepableRow,
  resolveHost: () => SessionSleepHost
): SessionSleepPlan {
  if (session.kind !== 'terminal' || !session.tabId || !session.paneKey) {
    return { ok: false, reason: 'not-terminal' }
  }
  const pane = parsePaneKey(session.paneKey)
  if (!pane || pane.tabId !== session.tabId) {
    return { ok: false, reason: 'not-terminal' }
  }
  const tabs = state.tabsByWorktree[session.worktreeId] ?? []
  if (!tabs.some((tab) => tab.id === session.tabId)) {
    return { ok: false, reason: 'not-terminal' }
  }
  const ptyId = livePtyIdForSessionPane(state, session.tabId, pane.leafId)
  if (!ptyId) {
    return { ok: false, reason: 'no-live-pty' }
  }
  if (!isAutomaticHibernationAllowed(state.sleepingAgentSessionsByPaneKey[session.paneKey])) {
    return { ok: false, reason: 'resume-blocked' }
  }
  if (!hasResumableIdentity(state, session.paneKey)) {
    return { ok: false, reason: 'not-resumable' }
  }
  // Why last: host resolution walks the owner catalogs, so it runs only for a real candidate.
  const host = resolveHost()
  // Why: loss of contact is never proof of death — an unanswered host cannot be stopped safely.
  if (host.authority === 'unverifiable') {
    return { ok: false, reason: 'unverifiable-host' }
  }
  // Why: a paired runtime needs its exact runtime PTY handle, which only the coordinator's
  // liveness sweep resolves; the renderer id alone would stop nothing there.
  if (host.runtimeEnvironmentId || ptyId.startsWith('remote:')) {
    return { ok: false, reason: 'paired-host' }
  }
  if (host.isPhoneDriving(ptyId)) {
    return { ok: false, reason: 'phone-driving' }
  }
  return {
    ok: true,
    target: {
      worktreeId: session.worktreeId,
      tabId: session.tabId,
      leafId: pane.leafId,
      paneKey: session.paneKey,
      ptyId
    }
  }
}

export function currentSessionSleepHost(state: AppState, worktreeId: string): SessionSleepHost {
  return {
    runtimeEnvironmentId: getRuntimeEnvironmentIdForWorktree(state, worktreeId),
    authority: resolveWorkspaceTerminalHostAuthority(state, worktreeId),
    isPhoneDriving: isPtyLocked
  }
}

export function planCurrentSessionSleep(session: SleepableRow): SessionSleepPlan {
  const state = useAppStore.getState()
  return planSessionSleep(state, session, () => currentSessionSleepHost(state, session.worktreeId))
}

/** A row whose pane holds a sleep record and no live PTY: opening it resumes the conversation. */
export function isSessionAsleep(
  state: Pick<
    SessionSleepState,
    'terminalLayoutsByTabId' | 'ptyIdsByTabId' | 'sleepingAgentSessionsByPaneKey'
  >,
  session: Pick<SidebarSession, 'kind' | 'tabId' | 'paneKey' | 'mirroredConversation'>
): boolean {
  if (session.kind !== 'terminal') {
    return false
  }
  // Why (step 6): a paired owner's conversation sleeps as its owner says, whatever this computer
  // recorded for its pane — unless the owner does not say (`unknown`: a frozen bucket vouches
  // for presence only), when this computer's own record of the pane speaks, as before.
  if (session.mirroredConversation && session.mirroredConversation.rest !== 'unknown') {
    return session.mirroredConversation.rest === 'asleep'
  }
  if (!session.paneKey) {
    return false
  }
  if (!state.sleepingAgentSessionsByPaneKey[session.paneKey]) {
    return false
  }
  const pane = parsePaneKey(session.paneKey)
  return !pane || !session.tabId || !livePtyIdForSessionPane(state, session.tabId, pane.leafId)
}

export function sessionSleepRefusalMessage(reason: SessionSleepRefusal): string {
  switch (reason) {
    case 'not-terminal':
      return translate('conversations.sleep.notTerminal', 'Only agent terminals can sleep.')
    case 'no-live-pty':
      return translate('conversations.sleep.notRunning', 'Nothing is running to put to sleep.')
    case 'not-resumable':
      return translate(
        'conversations.sleep.notResumable',
        'This agent has no resumable conversation id yet, so it keeps running.'
      )
    case 'paired-host':
      return translate(
        'conversations.sleep.pairedHost',
        'Sessions on a paired host cannot be put to sleep from here yet.'
      )
    case 'unverifiable-host':
      return translate(
        'conversations.sleep.unverifiableHost',
        'The host has not answered yet, so this session keeps running.'
      )
    case 'phone-driving':
      return translate(
        'conversations.sleep.phoneDriving',
        'A phone is driving this session right now.'
      )
    case 'resume-blocked':
      return translate(
        'conversations.sleep.resumeBlocked',
        'This session must not be resumed automatically, so it keeps running.'
      )
  }
}
