import { agentHookServer } from '../../../agent-hooks/server'
import { normalizeAgentProviderSession } from '../../../../shared/agent-session-resume'
import { scopedAgentSessionClaimsEqual } from '../../../../shared/claimed-agent-pty-owner-snapshot'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { isShellProcess } from '../../../../shared/shell-process-detection'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import { isValidTerminalTabId } from '../../../../shared/terminal-tab-id'
import type { Store } from '../../../persistence'
import type { IPtyProvider, PtyProcessInfo, PtySpawnOptions } from '../../../providers/types'
import { agentSessionOwners } from './agent-session-owners'
import { getAppPtyId, localProvider, sshProviders } from '../provider/registry'
import {
  parseProviderConversation,
  providerConversationConflict,
  type ProviderConversationRequest
} from './provider-conversation-reservation'
import { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../../../../shared/setup-agent-sequencing'

const HOST_LISTING_DEADLINE_MS = 5_000

type SavedOwner = { id: string; incarnationId?: string }

/**
 * Refuses a launch that would start a second process for a conversation whose saved owner — a
 * pane record from before this app process started — the execution host still lists as live.
 * The in-memory reservation only knows owners this process started, so saved pane records and
 * the hydrated hook snapshot name the candidates and the host listing proves them. An unknown
 * host, listing or foreground fails open; a request that attaches to a listed PTY never spawns.
 * Synchronous (undefined) when nothing is saved, so ordinary launches keep their timing.
 */
export function assertNoLiveSavedConversationOwner(
  args: ProviderConversationRequest,
  options: PtySpawnOptions,
  store: Store | undefined
): Promise<void> | undefined {
  const conversation = parseProviderConversation(
    options.launchAgent,
    options.env?.[SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV] ?? options.command,
    { connectionId: args.connectionId, shellOverride: options.shellOverride }
  )
  const host = args.connectionId ?? null
  if (!conversation || !store || typeof store.getWorkspaceSession !== 'function') {
    return undefined
  }
  const state = store.getWorkspaceSession(host ? toSshExecutionHostId(host) : undefined)
  const owns = (agent: unknown, session: unknown): boolean =>
    agent === conversation.agent && normalizeAgentProviderSession(session)?.id === conversation.id
  const paneKeys = new Set<string>()
  for (const record of Object.values(state.sleepingAgentSessionsByPaneKey ?? {})) {
    if (owns(record.agent, record.providerSession)) {
      paneKeys.add(record.paneKey)
    }
  }
  for (const row of agentHookServer.getStatusSnapshot()) {
    if ((row.connectionId ?? null) === host && owns(row.agentType, row.providerSession)) {
      paneKeys.add(row.paneKey)
    }
  }
  const ptyIdOf = (paneKey: string): string | undefined => {
    const pane = parsePaneKey(paneKey)
    if (!pane) {
      return undefined
    }
    return (
      state.terminalLayoutsByTabId?.[pane.tabId]?.ptyIdsByLeafId?.[pane.leafId] ??
      Object.values(state.tabsByWorktree ?? {})
        .flat()
        .find((tab) => tab.id === pane.tabId)?.ptyId ??
      undefined
    )
  }
  const candidates: SavedOwner[] = [...paneKeys].flatMap((paneKey) => {
    const id = ptyIdOf(paneKey)
    return id ? [{ id, incarnationId: state.terminalPtyIncarnationsByPaneKey?.[paneKey] }] : []
  })
  const provider = host ? sshProviders.get(host) : localProvider
  if (candidates.length === 0 || !provider) {
    return undefined
  }
  const ownPaneKey =
    args.tabId && isValidTerminalTabId(args.tabId) && args.leafId && isTerminalLeafId(args.leafId)
      ? makePaneKey(args.tabId, args.leafId)
      : null
  const attachTargets = [
    ...(options.sessionId && !options.isNewSession ? [getAppPtyId(host, options.sessionId)] : []),
    ...(ownPaneKey ? [ptyIdOf(ownPaneKey)] : [])
  ]
  return refuseListedSavedOwner(args, provider, candidates, attachTargets)
}

async function refuseListedSavedOwner(
  args: ProviderConversationRequest,
  provider: IPtyProvider,
  candidates: SavedOwner[],
  attachTargets: (string | undefined)[]
): Promise<void> {
  let sessions: PtyProcessInfo[]
  try {
    sessions = await provider.listProcesses({ deadlineMs: Date.now() + HOST_LISTING_DEADLINE_MS })
  } catch {
    return
  }
  if (!Array.isArray(sessions)) {
    return
  }
  const listed = (id: string | undefined): PtyProcessInfo | undefined =>
    id ? sessions.find((session) => session.id === id) : undefined
  // Why: a named session or the pane's own PTY attaches when the host lists it; no process starts.
  if (attachTargets.some((id) => listed(id))) {
    return
  }
  const claim = args.agentSessionEnsure?.claim
  for (const candidate of candidates) {
    const session = listed(candidate.id)
    if (
      !session ||
      (candidate.incarnationId &&
        session.incarnationId &&
        session.incarnationId !== candidate.incarnationId)
    ) {
      continue
    }
    if (
      claim &&
      (agentSessionOwners.find(claim)?.ptyId === session.id ||
        session.agentSessionOwners?.some(
          (owner) =>
            owner.ptyId === session.id &&
            owner.phase === 'live' &&
            scopedAgentSessionClaimsEqual(owner.claim, claim)
        ))
    ) {
      // The structured claim path adopts this exact owner instead of spawning.
      continue
    }
    const foreground = await provider.getForegroundProcess(session.id).catch(() => null)
    if (foreground && isShellProcess(foreground)) {
      // The agent already left this pane; only its shell remains.
      continue
    }
    throw providerConversationConflict(args)
  }
}
