import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import {
  agentProviderSessionsEqual,
  type AgentProviderSessionMetadata
} from '../../../shared/agent-session-resume'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { isShellProcess } from '../../../shared/shell-process-detection'

// Why: 2026-09-30 two Codex conversations that were already running were resumed a second time
// into other tabs. Before a pane resumes provider session X, it asks whether a LIVE PTY owned by
// OmniConsole already carries X — a pane this renderer bound to a PTY that has not exited
// (ptyIdsByTabId, the live pane registry), or, for a pane it has not bound, the provider's own PTY
// list (pty:hasPty). A sleeping record means "asleep, resumable" and never counts as live, and
// neither does a queued startup that has no PTY yet. The one exception is a resume this renderer
// is starting right now (a launch claim), so a reveal never starts a second copy mid-start.
// A 'done' row outlives its agent (agent-status-listeners keeps a done row when the agent exits
// and the PTY drops back to its shell), so a done row names an owner only with process evidence
// that the agent still runs; a bound PTY alone is not that evidence.

type OwnerState = {
  agentStatusByPaneKey: Readonly<Record<string, AgentStatusEntry>>
  tabsByWorktree: Readonly<Record<string, readonly { id: string; ptyId?: string | null }[]>>
  ptyIdsByTabId: Readonly<Record<string, readonly string[]>>
  terminalLayoutsByTabId?: Readonly<
    Record<string, { ptyIdsByLeafId?: Readonly<Record<string, string>> } | undefined>
  >
  /** The panes' process-table foreground samples (pane-foreground-agent-tracker). */
  paneForegroundAgentByPaneKey?: Readonly<
    Record<string, { agent: string | null; shellForeground: boolean } | undefined>
  >
}

/** What the pane's foreground sample says about the agent behind a 'done' row. */
export type DoneRowAgentEvidence = 'running' | 'exited' | 'unknown'

export function resolveDoneRowAgentEvidence(
  state: Pick<OwnerState, 'paneForegroundAgentByPaneKey'>,
  paneKey: string
): DoneRowAgentEvidence {
  const foreground = state.paneForegroundAgentByPaneKey?.[paneKey]
  if (foreground?.agent) {
    return 'running'
  }
  return foreground?.shellForeground === true ? 'exited' : 'unknown'
}

export type ProviderSessionOwnerQuery = {
  agent: string
  providerSession: AgentProviderSessionMetadata
  /** The asking pane; its own rows never count as another owner. */
  excludePaneKey: string
}

type LaunchClaim = {
  agent: string
  providerSession: AgentProviderSessionMetadata
  expiresAt: number
  /** Starts of this pane still queued for admission or spawning; the claim never lapses then. */
  inFlight: number
}

// Why a TTL: the claim only bridges the gap until the resumed agent reports status from its
// live pane; a spawn that silently fails must not block the session forever. The TTL counts from
// when the pane's start settled, not from the claim: main's admission queue (3 starts per 10 s)
// can hold a start far longer than the TTL, and a lapsed claim there let a reveal start a second
// copy of the same session.
const LAUNCH_CLAIM_TTL_MS = 60_000
const launchClaimsByPaneKey = new Map<string, LaunchClaim>()

function tabIdOfPaneKey(paneKey: string): string {
  const separator = paneKey.indexOf(':')
  return separator === -1 ? paneKey : paneKey.slice(0, separator)
}

function sameSession(
  query: ProviderSessionOwnerQuery,
  agent: string | undefined,
  session: AgentProviderSessionMetadata | undefined
): boolean {
  return (
    agent === query.agent && agentProviderSessionsEqual(query.agent, session, query.providerSession)
  )
}

/** The PTY the pane is bound to, and whether this renderer bound it and saw no exit since. */
function resolvePanePty(
  state: OwnerState,
  paneKey: string
): { ptyId: string | null; bound: boolean } {
  const tabId = tabIdOfPaneKey(paneKey)
  const leafId = parsePaneKey(paneKey)?.leafId
  const leafPtyId = leafId
    ? state.terminalLayoutsByTabId?.[tabId]?.ptyIdsByLeafId?.[leafId]
    : undefined
  let tabPtyId: string | null = null
  if (!leafPtyId) {
    for (const tabs of Object.values(state.tabsByWorktree)) {
      const tab = tabs.find((candidate) => candidate.id === tabId)
      if (tab) {
        tabPtyId = tab.ptyId ?? null
        break
      }
    }
  }
  const ptyId = leafPtyId ?? tabPtyId
  return { ptyId, bound: ptyId !== null && (state.ptyIdsByTabId[tabId] ?? []).includes(ptyId) }
}

/** The pane's PTY was bound by this renderer and has not exited since. */
export function isPaneBoundToLivePty(state: OwnerState, paneKey: string): boolean {
  return resolvePanePty(state, paneKey).bound
}

export function claimProviderSessionLaunch(
  paneKey: string,
  agent: string,
  providerSession: AgentProviderSessionMetadata,
  now = Date.now()
): () => void {
  const claim: LaunchClaim = {
    agent,
    providerSession,
    expiresAt: now + LAUNCH_CLAIM_TTL_MS,
    inFlight: 0
  }
  launchClaimsByPaneKey.set(paneKey, claim)
  return () => {
    if (launchClaimsByPaneKey.get(paneKey) === claim) {
      launchClaimsByPaneKey.delete(paneKey)
    }
  }
}

/**
 * The pane's start is on its way (queued in main's admission window or spawning): its launch
 * claim holds for as long as that lasts. The returned release is called when the start settles;
 * the TTL then restarts so the resumed agent's status row can take over. No-op without a claim.
 */
export function holdProviderSessionLaunchClaim(paneKey: string): (now?: number) => void {
  const claim = launchClaimsByPaneKey.get(paneKey)
  if (!claim) {
    return () => {}
  }
  claim.inFlight += 1
  let released = false
  return (now = Date.now()) => {
    if (released) {
      return
    }
    released = true
    claim.inFlight = Math.max(0, claim.inFlight - 1)
    claim.expiresAt = now + LAUNCH_CLAIM_TTL_MS
  }
}

/** Another pane whose live PTY runs this provider session, or that this renderer is starting it
 *  in right now — answered from state this renderer already holds. Returns that pane's key. */
export function findLiveProviderSessionOwner(
  state: OwnerState,
  query: ProviderSessionOwnerQuery,
  now = Date.now()
): string | null {
  for (const [paneKey, claim] of launchClaimsByPaneKey) {
    if (claim.inFlight === 0 && claim.expiresAt <= now) {
      launchClaimsByPaneKey.delete(paneKey)
      continue
    }
    if (
      paneKey !== query.excludePaneKey &&
      sameSession(query, claim.agent, claim.providerSession)
    ) {
      return paneKey
    }
  }
  for (const entry of Object.values(state.agentStatusByPaneKey)) {
    // Why done only with evidence: done is an agent idle at its prompt while it runs, but the row
    // stays after the agent exits; only the pane's foreground sample tells the two apart.
    if (
      entry.paneKey !== query.excludePaneKey &&
      sameSession(query, entry.agentType, entry.providerSession) &&
      resolvePanePty(state, entry.paneKey).bound &&
      (entry.state !== 'done' || resolveDoneRowAgentEvidence(state, entry.paneKey) === 'running')
    ) {
      return entry.paneKey
    }
  }
  return null
}

export type UnverifiedProviderSessionOwner = {
  paneKey: string
  ptyId: string
  /** This renderer bound the PTY: only whether the agent still runs in it is unknown. */
  bound: boolean
  /** The row is 'done', which survives the agent's exit: the probe must see a non-shell
   *  foreground process too. */
  done: boolean
}

/** Panes whose status row names this session where only a host probe can tell whether the agent
 *  still runs: a recorded PTY this renderer has not bound (an unmounted tab whose agent survived
 *  the restart), or a bound PTY whose 'done' row has no foreground sample either way. */
export function collectUnverifiedProviderSessionOwners(
  state: OwnerState,
  query: ProviderSessionOwnerQuery
): UnverifiedProviderSessionOwner[] {
  const candidates: UnverifiedProviderSessionOwner[] = []
  for (const entry of Object.values(state.agentStatusByPaneKey)) {
    if (
      entry.paneKey === query.excludePaneKey ||
      !sameSession(query, entry.agentType, entry.providerSession)
    ) {
      continue
    }
    const { ptyId, bound } = resolvePanePty(state, entry.paneKey)
    if (!ptyId || ptyId.startsWith('remote:')) {
      continue
    }
    const done = entry.state === 'done'
    if (!bound) {
      candidates.push({ paneKey: entry.paneKey, ptyId, bound, done })
    } else if (done && resolveDoneRowAgentEvidence(state, entry.paneKey) === 'unknown') {
      candidates.push({ paneKey: entry.paneKey, ptyId, bound, done })
    }
  }
  return candidates
}

export async function findLiveProviderSessionOwnerWithProbe(
  state: OwnerState,
  query: ProviderSessionOwnerQuery,
  hasPty: (ptyId: string) => Promise<boolean | null>,
  readForegroundProcess: (ptyId: string) => Promise<string | null> = async () => null
): Promise<string | null> {
  const known = findLiveProviderSessionOwner(state, query)
  if (known) {
    return known
  }
  for (const candidate of collectUnverifiedProviderSessionOwners(state, query)) {
    // Why only an authoritative answer: an unknown one must not strand the person's resume.
    if (!candidate.bound && (await hasPty(candidate.ptyId).catch(() => null)) !== true) {
      continue
    }
    if (candidate.done) {
      const foreground = await readForegroundProcess(candidate.ptyId).catch(() => null)
      // A shell back in the foreground means the agent exited; its done row is history.
      if (!foreground || isShellProcess(foreground)) {
        continue
      }
    }
    return candidate.paneKey
  }
  return null
}

export function resetProviderSessionLaunchClaimsForTests(): void {
  launchClaimsByPaneKey.clear()
}
