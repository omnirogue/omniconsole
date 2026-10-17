// The Sessions sidebar's counts exactly as the component last rendered them (session-count fix,
// step 0). The component hands over references only; rows are projected when someone reads them
// (`omni session sidebar-counts`) or, with the frame log on, when a count changes.
//
// Why mount tracking and readiness: switching the sidebar panel unmounts SessionSidebar, and a
// reloading window renders it before sessions restore. Either would otherwise answer with stale
// counts or real-looking zeros; both answer `available: false` with a reason instead.

import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { getSessionOwnershipUnverifiedReason } from '@/lib/session-ownership-verdict'
import { conversationViewKey } from '@/lib/conversation-view'
import { unknownHostSessionCount } from '@/lib/session-host-scope'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { parseExecutionHostId } from '../../../../../shared/execution-host'
import {
  pickSessionParityFields,
  type SessionParityBucketCounts
} from '../../../../../shared/session-parity'
import { sessionWorkflowConversationIdentity } from '../../../../../shared/session-workflow-records'
import {
  UNKNOWN_SESSION_SIDEBAR_HOST,
  unavailableSessionSidebarCounts,
  type SessionSidebarCountsResult,
  type SessionSidebarCountsRow,
  type SessionSidebarHostAvailability,
  type SessionSidebarHostCount
} from '../../../../../shared/session-sidebar-counts'
import { isSessionFrameLogEnabled, recordSessionFrameLog } from '@/runtime/session-frame-log'
import { usePublishSessionGroupParity } from './session-group-parity'
import {
  readSidebarCountsParity,
  sidebarCountBuckets,
  sidebarCountsParity,
  withHostBuckets,
  type SidebarCountsParity
} from './sidebar-counts-parity'

type HostOption = {
  id: string
  label: string
  kind?: string
  health?: string
  connectionStatus?: string
}

export type RenderedSidebarCountsInput = {
  countedSessions: readonly SidebarSession[]
  sessionCounts: ReadonlyMap<string, number>
  hostOptions: readonly HostOption[]
  hostFilter: unknown
  archivedCount: number
  hiddenCount: number
  showArchived: boolean
  archivedKeys: ReadonlySet<string>
  /** workspaceSessionReady when these counts rendered. */
  ready: boolean
}

type Published = RenderedSidebarCountsInput & { renderedAt: number }

export const SIDEBAR_NOT_ON_SCREEN_REASON = 'sidebar not on screen'
export const SIDEBAR_NOT_READY_REASON =
  'sessions are still being restored in this window (workspaceSessionReady is false)'

/** One entry per mounted SessionSidebar; a read answers from the most recently rendered one. */
const publishedByMount = new Map<object, Published>()
let lastLoggedCounts: string | null = null
let lastLoggedRowKeys: ReadonlySet<string> | null = null

/** `buckets` (session parity, step 8) splits each count; the frame log reads the totals alone. */
function sessionCountsByHost(
  input: RenderedSidebarCountsInput,
  buckets?: ReadonlyMap<string, SessionParityBucketCounts>
): SessionSidebarHostCount[] {
  const labels = new Map(input.hostOptions.map((host) => [host.id, host.label]))
  const unknown = unknownHostSessionCount(input.countedSessions)
  // Why: listed with Home but counted as no computer's, so the counts still add up to the list.
  return [
    ...[...input.sessionCounts].map(([hostId, count]) => ({
      hostId,
      label: labels.get(hostId) ?? null,
      count
    })),
    ...(unknown ? [{ hostId: UNKNOWN_SESSION_SIDEBAR_HOST, label: null, count: unknown }] : [])
  ]
    .sort((a, b) => a.hostId.localeCompare(b.hostId))
    .map((entry) => withHostBuckets(entry, buckets))
}

/** What the host switch itself lists: each host it offers, with `count ?? 0` as it renders. */
function switchHostCounts(
  input: RenderedSidebarCountsInput,
  buckets?: ReadonlyMap<string, SessionParityBucketCounts>
): SessionSidebarHostCount[] {
  return input.hostOptions.map((host) =>
    withHostBuckets(
      { hostId: host.id, label: host.label, count: input.sessionCounts.get(host.id) ?? 0 },
      buckets
    )
  )
}

function projectRow(
  session: SidebarSession,
  archivedKeys: ReadonlySet<string>,
  parity?: SidebarCountsParity
): SessionSidebarCountsRow {
  const key = conversationViewKey(session)
  const workflowTabId = session.mirroredWorkflow?.hostTabId ?? session.tabId
  const unverified = getSessionOwnershipUnverifiedReason(useAppStore.getState(), session)
  return {
    key,
    rowKey: session.rowKey,
    hostId: session.displayHostId ?? session.hostId ?? UNKNOWN_SESSION_SIDEBAR_HOST,
    worktreeId: session.worktreeId,
    kind: session.kind,
    agent: session.agent,
    paneKey: session.paneKey,
    providerSession: session.providerSession
      ? `${session.providerSession.key}:${session.providerSession.id}`
      : null,
    archived: archivedKeys.has(key),
    unavailable: session.unavailable,
    launchPending: session.launchPending === true,
    workflow: Boolean(session.workflow),
    ...(session.workflow && workflowTabId
      ? { workflowIdentity: sessionWorkflowConversationIdentity(session.worktreeId, workflowTabId) }
      : {}),
    ...(unverified ? { ownershipUnverified: unverified } : {}),
    label: session.label,
    ...(parity ? pickSessionParityFields(parity.fieldsOf(session)) : {})
  }
}

function hostAvailability(hostOptions: readonly HostOption[]): SessionSidebarHostAvailability[] {
  const statuses = useAppStore.getState().runtimeStatusByEnvironmentId
  return hostOptions.map((host) => {
    const parsed = parseExecutionHostId(host.id)
    const entry = parsed?.kind === 'runtime' ? statuses?.get(parsed.environmentId) : undefined
    return {
      hostId: host.id,
      label: host.label,
      kind: host.kind ?? parsed?.kind ?? null,
      health: host.health ?? null,
      connectionStatus: host.connectionStatus ?? null,
      reachable: entry ? entry.status !== null : null,
      graphStatus: entry?.status?.graphStatus ?? null,
      appVersion: entry?.status?.appVersion ?? entry?.appVersion ?? null,
      checkedAt: entry?.checkedAt ?? null
    }
  })
}

function latestPublished(): Published | null {
  let latest: Published | null = null
  for (const published of publishedByMount.values()) {
    if (!latest || published.renderedAt >= latest.renderedAt) {
      latest = published
    }
  }
  return latest
}

/** With the frame log on, one record per rendered count change, with the rows that moved. */
function logCountTransition(input: RenderedSidebarCountsInput | null): void {
  const counts = input
    ? {
        onScreen: true,
        ready: input.ready,
        switchHostCounts: switchHostCounts(input),
        sessionCountsByHost: sessionCountsByHost(input),
        archivedCount: input.archivedCount,
        hiddenCount: input.hiddenCount
      }
    : { onScreen: false }
  const signature = JSON.stringify(counts)
  if (signature === lastLoggedCounts) {
    return
  }
  lastLoggedCounts = signature
  if (!input) {
    lastLoggedRowKeys = null
    recordSessionFrameLog({ kind: 'renderer.sidebar-counts', ...counts })
    return
  }
  const rowKeys = new Set(input.countedSessions.map((session) => conversationViewKey(session)))
  const previous = lastLoggedRowKeys
  lastLoggedRowKeys = rowKeys
  recordSessionFrameLog({
    kind: 'renderer.sidebar-counts',
    ...counts,
    ...(previous
      ? {
          addedRows: [...rowKeys].filter((key) => !previous.has(key)),
          removedRows: [...previous].filter((key) => !rowKeys.has(key))
        }
      : { rowCount: rowKeys.size })
  })
}

export function publishRenderedSidebarCounts(
  mount: object,
  input: RenderedSidebarCountsInput
): void {
  publishedByMount.set(mount, { ...input, renderedAt: Date.now() })
  if (isSessionFrameLogEnabled()) {
    logCountTransition(input)
  }
}

export function unpublishRenderedSidebarCounts(mount: object): void {
  publishedByMount.delete(mount)
  if (isSessionFrameLogEnabled()) {
    logCountTransition(latestPublished())
  }
}

export function readRenderedSidebarCounts(): SessionSidebarCountsResult {
  const latest = latestPublished()
  if (!latest) {
    // Why the parity population still: it reads the store, which needs no sidebar on screen (C5).
    return {
      ...unavailableSessionSidebarCounts(SIDEBAR_NOT_ON_SCREEN_REASON),
      ...readSidebarCountsParity(useAppStore.getState())
    }
  }
  if (!latest.ready) {
    return unavailableSessionSidebarCounts(SIDEBAR_NOT_READY_REASON, {
      onScreen: true,
      ready: false,
      renderedAt: latest.renderedAt
    })
  }
  const state = useAppStore.getState()
  const parity = sidebarCountsParity(state)
  const buckets = sidebarCountBuckets(parity, latest.countedSessions, latest.archivedKeys)
  return {
    available: true,
    onScreen: true,
    ready: true,
    renderedAt: latest.renderedAt,
    readAt: Date.now(),
    switchHostCounts: switchHostCounts(latest, buckets),
    sessionCountsByHost: sessionCountsByHost(latest, buckets),
    archivedCount: latest.archivedCount,
    hiddenCount: latest.hiddenCount,
    showArchived: latest.showArchived,
    hostFilter: latest.hostFilter,
    rows: latest.countedSessions.map((session) => projectRow(session, latest.archivedKeys, parity)),
    unknownHostCount: unknownHostSessionCount(latest.countedSessions),
    archiveKeys: [...latest.archivedKeys].sort(),
    hosts: hostAvailability(latest.hostOptions),
    ...readSidebarCountsParity(state, parity)
  }
}

/** Called by SessionSidebar after its counts are computed; publishes after commit, never during render. */
export function usePublishSidebarCounts(
  hosts: {
    countedSessions: readonly SidebarSession[]
    bar: {
      sessionCounts: ReadonlyMap<string, number>
      hostOptions: readonly HostOption[]
      filter: unknown
    }
  },
  counts: Pick<
    RenderedSidebarCountsInput,
    'archivedCount' | 'hiddenCount' | 'showArchived' | 'archivedKeys'
  >
): void {
  const [mount] = useState<object>(() => ({}))
  const ready = useAppStore((state) => state.workspaceSessionReady)
  const { countedSessions } = hosts
  const { sessionCounts, hostOptions, filter: hostFilter } = hosts.bar
  const { archivedCount, hiddenCount, showArchived, archivedKeys } = counts
  usePublishSessionGroupParity(countedSessions)
  useEffect(() => {
    publishRenderedSidebarCounts(mount, {
      countedSessions,
      sessionCounts,
      hostOptions,
      hostFilter,
      archivedCount,
      hiddenCount,
      showArchived,
      archivedKeys,
      ready
    })
  }, [
    mount,
    countedSessions,
    sessionCounts,
    hostOptions,
    hostFilter,
    archivedCount,
    hiddenCount,
    showArchived,
    archivedKeys,
    ready
  ])
  // Why its own effect: only an unmount (not a count change) takes the sidebar off screen.
  useEffect(() => () => unpublishRenderedSidebarCounts(mount), [mount])
}

export function _resetRenderedSidebarCountsForTests(): void {
  publishedByMount.clear()
  lastLoggedCounts = null
  lastLoggedRowKeys = null
}
