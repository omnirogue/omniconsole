import { sessionWaitKey } from './session-snooze'
import { conversationViewKey, isPersonalRowHidden } from './conversation-view'
import { conversationGroupLabel } from './conversation-state'
import { translate } from '@/i18n/i18n'
import {
  conversationFleetProgress,
  conversationFleetSettled,
  type ConversationFleetPhase
} from './conversation-fleet-progress'
import { isSessionGroupCollapsed, type SessionSidebarView } from './session-sidebar-view'
import { cardsForSession } from './session-pane-cards'
import type { SessionSidebarGroup, SessionSidebarTreeInput } from './session-sidebar-tree'
import type { SidebarSession } from './sidebar-sessions'
import type { ConversationFleetView } from '@/store/conversation-fleet-store'

export type ConversationFleetSidebarRow = {
  run: ConversationFleetView
  source: SidebarSession | null
}

export type ConversationFleetSidebarGroup = SessionSidebarGroup & {
  fleetRows: ConversationFleetSidebarRow[]
}

export function matchesConversationFleetSource(
  run: Pick<ConversationFleetView, 'rowKey' | 'sessionKey'>,
  session: Pick<SidebarSession, 'rowKey' | 'sessionKey'>
): boolean {
  return run.sessionKey && session.sessionKey
    ? run.sessionKey === session.sessionKey
    : run.rowKey === session.rowKey
}

export function conversationFleetSource(
  run: Pick<ConversationFleetView, 'rowKey' | 'sessionKey'>,
  sessions: readonly SidebarSession[]
): SidebarSession | null {
  return sessions.find((session) => matchesConversationFleetSource(run, session)) ?? null
}

/** The view key a fleet row is hidden, archived and ordered by; the same key wherever the row is read. */
export function conversationFleetRowKey(
  run: Pick<ConversationFleetView, 'rowKey' | 'sessionKey'>,
  source: SidebarSession | null
): string {
  return source ? conversationViewKey(source) : (run.sessionKey ?? run.rowKey)
}

export function isConversationFleetRowHidden(
  view: SessionSidebarView,
  run: Pick<ConversationFleetView, 'rowKey' | 'sessionKey'>,
  source: SidebarSession | null
): boolean {
  if (source) {
    return isPersonalRowHidden(view, source)
  }
  const key = conversationFleetRowKey(run, source)
  return view.hidden.includes(`conversation:${key}`) || view.hidden.includes(`session:${key}`)
}

/** Pending admission leaves its source in place until the server confirms ownership. */
export function sessionsOutsideFleet(
  sessions: readonly SidebarSession[],
  runs: readonly ConversationFleetView[],
  snapshot?: SessionSidebarTreeInput['snapshot']
): SidebarSession[] {
  return sessions.filter((session) => {
    const card = snapshot ? cardsForSession(session, snapshot).card : undefined
    return !runs.some((run) => {
      if (run.admission !== 'accepted' || !matchesConversationFleetSource(run, session)) {
        return false
      }
      const capturedAt = run.capturedAt ? Date.parse(run.capturedAt) : Number.NaN
      const resumed =
        card &&
        ['working', 'attention'].includes(card.bucket) &&
        (!Number.isFinite(capturedAt) ||
          !Number.isFinite(card.stateChangedAt) ||
          card.stateChangedAt <= 0 ||
          card.stateChangedAt > capturedAt)
      return !resumed
    })
  })
}

/** The heading an automatic group gets when a receipt or routine is the first to need it. */
export function conversationSidebarGroupLabel(
  kind: SessionSidebarGroup['kind'],
  count = 0
): string {
  if (kind === 'workspace') {
    return translate('conversations.activeGroup', 'Active')
  }
  if (kind === 'stopped' || kind === 'hidden' || kind === 'archived') {
    return conversationGroupLabel(kind, count)
  }
  if (kind === 'attention') {
    return translate('auto.components.SessionSidebar.needsYouGroup', 'Needs you')
  }
  if (kind === 'completed') {
    return translate('dashboardPopout.bucket.done', 'Done')
  }
  return translate('conversationFleet.waitingGroup', 'Waiting')
}

/** The groups after Done: Saved, Agent sessions, Hidden and Archived. */
const LATER_GROUP_KINDS: readonly SessionSidebarGroup['kind'][] = [
  'saved',
  'workers',
  'hidden',
  'archived'
]

/** Where a newly needed automatic group of this kind goes among the ones already listed. */
export function conversationGroupInsertIndex(
  groups: readonly Pick<SessionSidebarGroup, 'kind'>[],
  kind: SessionSidebarGroup['kind']
): number {
  const before = groups.findIndex(
    (candidate) =>
      kind === 'attention' ||
      (kind === 'workspace' &&
        ['drafts', 'waiting', 'stopped', 'completed', ...LATER_GROUP_KINDS].includes(
          candidate.kind
        )) ||
      (kind === 'stopped' && ['completed', ...LATER_GROUP_KINDS].includes(candidate.kind)) ||
      (kind === 'waiting' &&
        ['stopped', 'completed', ...LATER_GROUP_KINDS].includes(candidate.kind)) ||
      (kind === 'completed' && LATER_GROUP_KINDS.includes(candidate.kind)) ||
      (kind === 'hidden' && candidate.kind === 'archived')
  )
  return before === -1 ? groups.length : before
}

/**
 * Where a receipt is listed by what its work is doing. Only a human requirement is Needs you; a
 * failed run asks nothing, so it stays with the unsettled work it can be retried from.
 */
function fleetPhaseGroup(phase: ConversationFleetPhase): SessionSidebarGroup['kind'] {
  if (phase === 'working') {
    return 'workspace'
  }
  if (phase === 'failed') {
    return 'stopped'
  }
  if (phase === 'needs-you') {
    return 'attention'
  }
  return conversationFleetSettled(phase) ? 'completed' : 'waiting'
}

/** Fleet receipts join the same groups as local conversations, including after their tab closes. */
export function addConversationFleetGroups(args: {
  groups: readonly SessionSidebarGroup[]
  sessions: readonly SidebarSession[]
  runs: readonly ConversationFleetView[]
  view: SessionSidebarView
  query: string
  now?: number
  showArchived?: boolean
  waitingUntil?: Readonly<Record<string, string>>
}): ConversationFleetSidebarGroup[] {
  const groups = args.groups.map((group) => ({
    ...group,
    fleetRows: [] as ConversationFleetSidebarRow[]
  }))
  const query = args.query.trim().toLowerCase()
  for (const run of args.runs) {
    const pendingGroup =
      run.admission === 'pending'
        ? groups.find((group) =>
            group.rows.some((row) => matchesConversationFleetSource(run, row.session))
          )
        : undefined
    if (pendingGroup && pendingGroup.kind !== 'completed') {
      continue
    }
    const pendingRow = pendingGroup?.rows.find((row) =>
      matchesConversationFleetSource(run, row.session)
    )
    const source = conversationFleetSource(run, args.sessions)
    if (
      query &&
      ![run.title, run.machine, source?.label, source?.workspaceLabel]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(query)
    ) {
      continue
    }
    const key = conversationFleetRowKey(run, source)
    if (args.view.deleted?.includes(key) && !source?.tabId) {
      continue
    }
    const legacyWaiting = (args.view.snoozedUntil?.[key] ?? 0) > (args.now ?? Date.now())
    // Why (Sal, 2026-09-23): a receipt whose source's tab is open stays listed; the mark (and the
    // row's Show control) stays, and it goes to Hidden once that tab is closed.
    const hidden = isConversationFleetRowHidden(args.view, run, source) && !source?.tabId
    const archived = args.view.archived?.includes(key)
    if (archived && !hidden && !args.showArchived && !query) {
      continue
    }
    const phase =
      run.admission === 'pending'
        ? 'unverifiable'
        : conversationFleetProgress(run.jobs, run.verified).phase
    const waiting = args.waitingUntil?.[source ? sessionWaitKey(source) : `conversation:${key}`]
    const kind = hidden
      ? 'hidden'
      : archived
        ? 'archived'
        : legacyWaiting || (waiting && Date.parse(waiting) > (args.now ?? Date.now()))
          ? 'waiting'
          : fleetPhaseGroup(phase)
    if (pendingRow && pendingGroup) {
      pendingGroup.rows = pendingGroup.rows.filter((row) => row !== pendingRow)
    }
    const groupKey =
      kind === 'workspace' ? 'workspace:other' : kind === 'hidden' ? 'hidden-conversations' : kind
    let group = groups.find((candidate) => candidate.kind === kind)
    if (!group) {
      group = {
        key: groupKey,
        kind,
        label: conversationSidebarGroupLabel(kind),
        rows: [],
        fleetRows: [],
        collapsed: !query && isSessionGroupCollapsed(args.view, groupKey),
        hidden: false,
        attentionCount: 0,
        canHide: false,
        canReorder: false
      }
      groups.splice(conversationGroupInsertIndex(groups, kind), 0, group)
    }
    if (pendingRow) {
      group.rows.push({ ...pendingRow, completed: null, pursuitState: 'queued' })
    } else {
      group.fleetRows.push({ run, source })
    }
    group.label = conversationSidebarGroupLabel(kind, group.rows.length + group.fleetRows.length)
    if (kind === 'attention') {
      group.attentionCount += 1
    }
  }
  return groups.filter(
    (group) => group.kind !== 'completed' || group.rows.length > 0 || group.fleetRows.length > 0
  )
}
