import {
  ALL_EXECUTION_HOSTS_SCOPE,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId,
  type ExecutionHostKind,
  type ExecutionHostScope
} from '../../../shared/execution-host'
import {
  addSessionParityCount,
  emptySessionParityBucketCounts,
  type SessionParityBucketCounts,
  type SessionParityCountInput
} from '../../../shared/session-parity'
import type { AgentPaneSnapshot } from '@/components/attention/agent-pane-snapshot'
import { conversationFleetHosts } from './conversation-fleet-hosts'
import { localWorkflowNeedsYou } from './local-workflow-tab-status'
import { cardsForSession } from './session-pane-cards'
import type { SidebarSession } from './sidebar-sessions'
import type { SessionSidebarView } from './session-sidebar-view'
import type { ConversationFleetView } from '@/store/conversation-fleet-store'

/** Home (this computer), Globe (paired runtimes), Plug (SSH hosts), in the switch's order. */
export const SESSION_HOST_KINDS = [
  'local',
  'runtime',
  'ssh'
] as const satisfies readonly ExecutionHostKind[]

/**
 * Whose sessions the list shows: every host of the chosen kinds (union), less the hosts turned off
 * within them. Hidden rather than chosen hosts, so a newly set-up host shows up by itself.
 */
export type SessionHostFilter = {
  kinds: readonly ExecutionHostKind[]
  hiddenHostIds: readonly ExecutionHostId[]
}

type SessionHost = { id: ExecutionHostId; kind: ExecutionHostKind }
type SavedSessionHostView = {
  hostFilter?: { kinds: readonly string[]; hiddenHostIds?: readonly string[] }
  hostScope?: string
}

export const HOME_SESSION_HOST_FILTER: SessionHostFilter = { kinds: ['local'], hiddenHostIds: [] }

function hostKind(hostId: ExecutionHostId | null): ExecutionHostKind {
  return parseExecutionHostId(hostId)?.kind ?? 'local'
}

/** A session with no known host is a tab this computer kept after its workspace went: Home. */
export function inSessionHostFilter(
  hostId: ExecutionHostId | null,
  filter: SessionHostFilter
): boolean {
  const id = hostId ?? LOCAL_EXECUTION_HOST_ID
  return filter.kinds.includes(hostKind(id)) && !filter.hiddenHostIds.includes(id)
}

function showsAnyHost(filter: SessionHostFilter, hosts: readonly SessionHost[]): boolean {
  return hosts.some((host) => inSessionHostFilter(host.id, filter))
}

/** The single-choice `hostScope` older builds saved ('local', 'all' or one host's id). */
function filterFromLegacyScope(
  saved: string | undefined,
  hosts: readonly SessionHost[]
): SessionHostFilter {
  if (saved === ALL_EXECUTION_HOSTS_SCOPE) {
    return { kinds: [...SESSION_HOST_KINDS], hiddenHostIds: [] }
  }
  const chosen = parseExecutionHostId(saved)
  if (!chosen || chosen.kind === 'local') {
    return HOME_SESSION_HOST_FILTER
  }
  return {
    kinds: [chosen.kind],
    hiddenHostIds: hosts
      .filter((host) => host.kind === chosen.kind && host.id !== chosen.id)
      .map((host) => host.id)
  }
}

function readSavedFilter(
  saved: NonNullable<SavedSessionHostView['hostFilter']>
): SessionHostFilter {
  return {
    kinds: SESSION_HOST_KINDS.filter((kind) => saved.kinds.includes(kind)),
    hiddenHostIds: (saved.hiddenHostIds ?? []).flatMap((value) => {
      const host = parseExecutionHostId(value)
      return host && host.kind !== 'local' ? [host.id] : []
    })
  }
}

/**
 * The filter in force, less turned-off hosts the switch no longer lists. One that would show no
 * host at all (every chosen host removed or turned off) is Home, so the list is never left empty
 * with no way to tell why.
 */
export function effectiveSessionHostFilter(
  saved: SavedSessionHostView,
  hosts: readonly SessionHost[]
): SessionHostFilter {
  const read = saved.hostFilter
    ? readSavedFilter(saved.hostFilter)
    : filterFromLegacyScope(saved.hostScope, hosts)
  const listed = new Set(hosts.map((host) => host.id))
  const filter = { ...read, hiddenHostIds: read.hiddenHostIds.filter((id) => listed.has(id)) }
  return showsAnyHost(filter, hosts) ? filter : HOME_SESSION_HOST_FILTER
}

/** What an older build should show when it reads this device's view back. */
export function legacySessionHostScope(
  filter: SessionHostFilter,
  hosts: readonly SessionHost[]
): ExecutionHostScope {
  const shown = hosts.filter((host) => inSessionHostFilter(host.id, filter))
  return shown.length === 1 ? shown[0].id : ALL_EXECUTION_HOSTS_SCOPE
}

export function hostsOfKind(
  hosts: readonly SessionHost[],
  kind: ExecutionHostKind
): ExecutionHostId[] {
  return hosts.filter((host) => host.kind === kind).map((host) => host.id)
}

/** Turning a kind on shows its hosts as last narrowed, or all of them if every one was off. */
function withKindOn(
  filter: SessionHostFilter,
  kind: ExecutionHostKind,
  hosts: readonly SessionHost[]
): SessionHostFilter {
  const kinds = SESSION_HOST_KINDS.filter((each) => each === kind || filter.kinds.includes(each))
  const next = { ...filter, kinds }
  const ofKind = hostsOfKind(hosts, kind)
  return ofKind.some((id) => inSessionHostFilter(id, next))
    ? next
    : { kinds, hiddenHostIds: filter.hiddenHostIds.filter((id) => !ofKind.includes(id)) }
}

/** Keeps the filter as it was when the change would leave nothing to show. */
function unlessEmpty(
  next: SessionHostFilter,
  current: SessionHostFilter,
  hosts: readonly SessionHost[]
): SessionHostFilter {
  return showsAnyHost(next, hosts) ? next : current
}

/** Turns a kind off, unless nothing else would be left to show. */
export function hideSessionHostKind(
  filter: SessionHostFilter,
  kind: ExecutionHostKind,
  hosts: readonly SessionHost[]
): SessionHostFilter {
  return unlessEmpty(
    { ...filter, kinds: filter.kinds.filter((each) => each !== kind) },
    filter,
    hosts
  )
}

export function toggleSessionHostKind(
  filter: SessionHostFilter,
  kind: ExecutionHostKind,
  hosts: readonly SessionHost[]
): SessionHostFilter {
  const shown = hostsOfKind(hosts, kind).some((id) => inSessionHostFilter(id, filter))
  return shown ? hideSessionHostKind(filter, kind, hosts) : withKindOn(filter, kind, hosts)
}

export function onlySessionHostKind(
  filter: SessionHostFilter,
  kind: ExecutionHostKind,
  hosts: readonly SessionHost[]
): SessionHostFilter {
  return withKindOn({ ...filter, kinds: [] }, kind, hosts)
}

export function toggleSessionHost(
  filter: SessionHostFilter,
  hostId: ExecutionHostId,
  hosts: readonly SessionHost[]
): SessionHostFilter {
  if (inSessionHostFilter(hostId, filter)) {
    return unlessEmpty(
      { ...filter, hiddenHostIds: [...filter.hiddenHostIds, hostId] },
      filter,
      hosts
    )
  }
  const kind = hostKind(hostId)
  const hidden = filter.kinds.includes(kind)
    ? filter.hiddenHostIds
    : // Why: a kind that was off comes back with only the host the person picked.
      [...filter.hiddenHostIds, ...hostsOfKind(hosts, kind)]
  return {
    kinds: SESSION_HOST_KINDS.filter((each) => each === kind || filter.kinds.includes(each)),
    hiddenHostIds: hidden.filter((id) => id !== hostId)
  }
}

export function showAllSessionHostsOfKind(
  filter: SessionHostFilter,
  kind: ExecutionHostKind
): SessionHostFilter {
  return {
    kinds: SESSION_HOST_KINDS.filter((each) => each === kind || filter.kinds.includes(each)),
    hiddenHostIds: filter.hiddenHostIds.filter((id) => hostKind(id) !== kind)
  }
}

/**
 * Sessions and fleet runs owned by the selected computers. Unlocated fleet receipts stay in Tasks.
 */
export function sessionsInHostFilter(
  sessions: readonly SidebarSession[],
  fleetRuns: readonly ConversationFleetView[],
  filter: SessionHostFilter,
  hosts: readonly { id: ExecutionHostId; label: string }[] = []
): { sessions: SidebarSession[]; fleetRuns: ConversationFleetView[] } {
  return {
    sessions: sessions.filter((session) =>
      inSessionHostFilter(session.displayHostId ?? session.hostId, filter)
    ),
    fleetRuns: fleetRuns.filter((run) =>
      conversationFleetHosts(run, sessions, hosts).some((host) => inSessionHostFilter(host, filter))
    )
  }
}

/**
 * Sessions per host, for the switch to say what each kind and host holds. Why a row with no known
 * host is not counted (session counts, step 9): it may be a paired computer's, so counting it as
 * this computer's would inflate Home; the list still shows it where it always has.
 */
export function sessionCountsByHost(
  sessions: readonly Pick<SidebarSession, 'hostId' | 'displayHostId'>[]
): Map<ExecutionHostId, number> {
  const counts = new Map<ExecutionHostId, number>()
  for (const session of sessions) {
    const id = session.displayHostId ?? session.hostId
    if (id) {
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
  }
  return counts
}

/**
 * Sessions per host by parity bucket (session parity, step 8): exactly the rows
 * `sessionCountsByHost` counts, so each host's count = ownerListed + heldByOwner + receiverOnly +
 * workflow and nothing is hidden; unverified, stale and archived are counted within those.
 */
export function sessionCountBucketsByHost<
  T extends Pick<SidebarSession, 'hostId' | 'displayHostId'>
>(
  sessions: readonly T[],
  classify: (session: T) => SessionParityCountInput
): Map<ExecutionHostId, SessionParityBucketCounts> {
  const counts = new Map<ExecutionHostId, SessionParityBucketCounts>()
  for (const session of sessions) {
    const id = session.displayHostId ?? session.hostId
    if (id) {
      const entry = counts.get(id) ?? emptySessionParityBucketCounts()
      addSessionParityCount(entry, classify(session))
      counts.set(id, entry)
    }
  }
  return counts
}

/** Rows listed with Home whose host is unknown: counted apart, never as this computer's. */
export function unknownHostSessionCount(
  sessions: readonly Pick<SidebarSession, 'hostId' | 'displayHostId'>[]
): number {
  return sessions.filter((session) => !(session.displayHostId ?? session.hostId)).length
}

/**
 * Sessions per host that are asking for a person, read from the same attention marks the tree
 * reads, over every session whatever the filter, so the switch can say a host out of view needs you.
 */
export function sessionAsksByHost(
  sessions: readonly SidebarSession[],
  snapshot: Pick<AgentPaneSnapshot, 'cardsByPaneKey' | 'cardsByTabId' | 'attentionByPaneKey'>
): Map<ExecutionHostId, number> {
  return sessionCountsByHost(
    sessions.filter((session) => {
      // Why: as in the tree, an ask a fleet run carries is the run's, not the session's.
      const { attention } = cardsForSession(session, snapshot)
      return (attention !== null && !attention.run) || localWorkflowNeedsYou(session.workflow)
    })
  )
}

/**
 * What a kind's icon marks: how many of its hosts in view have sessions, and whether a session on
 * one of its hosts out of view is asking for a person.
 */
export function sessionHostKindMarks(
  kind: ExecutionHostKind,
  filter: SessionHostFilter,
  sessionCounts: ReadonlyMap<ExecutionHostId, number>,
  askCounts: ReadonlyMap<ExecutionHostId, number>
): { hostsWithSessions: number; asksElsewhere: boolean } {
  const ofKind = (id: ExecutionHostId, count: number): boolean => count > 0 && hostKind(id) === kind
  const hostsWithSessions = [...sessionCounts].filter(
    ([id, count]) => ofKind(id, count) && inSessionHostFilter(id, filter)
  ).length
  const asksElsewhere = [...askCounts].some(
    ([id, count]) => ofKind(id, count) && !inSessionHostFilter(id, filter)
  )
  return { hostsWithSessions, asksElsewhere }
}

export function withSessionHostFilter(
  view: SessionSidebarView,
  filter: SessionHostFilter,
  hostScope: ExecutionHostScope
): SessionSidebarView {
  return {
    ...view,
    hostFilter: { kinds: [...filter.kinds], hiddenHostIds: [...filter.hiddenHostIds] },
    hostScope
  }
}

export function sessionSidebarStartupView(
  view: SessionSidebarView,
  loaded: boolean
): SessionSidebarView {
  return loaded ? view : withSessionHostFilter(view, HOME_SESSION_HOST_FILTER, 'local')
}
