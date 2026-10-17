// Session frame log (session-count fix, step 0 "measure first"): an observe-only record of every
// session-tabs frame a receiver decides and every owner-side inventory transition, written to one
// bounded NDJSON file per computer. Nothing here changes a decision; when the flag is off each call
// site pays one boolean check.

import { readSessionTabsInventoryOrder } from './session-tabs-inventory-order'
import type { SessionTabsInventoryOrder } from './session-tabs-inventory-order'
import { getPtyExecutionHost } from './terminal-execution-host'
import { isWebOnlyMirroredTerminalTab } from './terminal-surface-id'

export const SESSION_FRAME_LOG_RPC = {
  set: 'session.frameLog.set',
  status: 'session.frameLog.status'
} as const

/** Read-only: the sidebar's per-host and Archived counts as the window last rendered them. */
export const SESSION_SIDEBAR_COUNTS_RPC = 'session.sidebarCounts'

export const SESSION_FRAME_LOG_APPEND_CHANNEL = 'sessionFrameLog:append'
export const SESSION_FRAME_LOG_STATE_CHANNEL = 'sessionFrameLog:state'
export const SESSION_FRAME_LOG_GET_STATE_CHANNEL = 'sessionFrameLog:getState'

/** Why a cap: a looping renderer must not turn a debug log into unbounded IPC and disk churn. */
export const SESSION_FRAME_LOG_MAX_BATCH = 500
/** A renderer record larger than this is replaced by a truncated stand-in flagged `truncated`. */
export const SESSION_FRAME_LOG_MAX_RECORD_BYTES = 64 * 1024
/** Why an expiry: a forgotten debug switch must stop on its own; "on" survives restarts until then. */
export const SESSION_FRAME_LOG_DEFAULT_DURATION_MS = 8 * 60 * 60 * 1000
export const SESSION_FRAME_LOG_MAX_DURATION_MS = 48 * 60 * 60 * 1000

export type SessionFrameLogRecord = { kind: string } & Record<string, unknown>

export type SessionFrameLogBuild = { appVersion: string | null; commit: string | null }

export type SessionFrameLogStatus = {
  enabled: boolean
  filePath: string
  files: string[]
  bytes: number
  maxBytes: number
  maxFiles: number
  enabledAt: number | null
  /** When the log switches itself off; null while off. */
  expiresAt: number | null
  build: SessionFrameLogBuild
}

export type SessionFrameLogState = { enabled: boolean }

/** Local builds are versioned `…-local.<timestamp>.<sha>`; release versions carry no commit. */
export function parseBuildCommit(version: string | null | undefined): string | null {
  const match = /-local\.\d+\.([0-9a-f]{7,40})$/i.exec(version ?? '')
  return match ? match[1]! : null
}

type FrameTab = {
  type: string
  id: string
  parentTabId?: string
  launchAgent?: string | null
  agentStatus?: { agentType?: string | null } | null
  agent?: string | null
  ptyId?: string | null
}

type FrameLike = {
  worktree: string
  publicationEpoch: string
  snapshotVersion: number
  removed?: unknown
  changeSequence?: unknown
  membershipUnverified?: unknown
  inventoryOrder?: unknown
  tabs: readonly FrameTab[]
}

export type SessionTabsFrameSummary = {
  worktree: string
  epoch: string
  version: number
  removed: boolean
  /** The owner marked this frame's membership unverified (an execution host went unasked). */
  membershipUnverified?: true
  /** Only when the frame itself carries one (owner-internal sequences are logged owner-side). */
  changeSequence?: number
  tabCount: number
  /** Host terminal tab ids (one per tab, not per split leaf): what receivers key rows by. */
  terminalTabIds: string[]
  terminalLeafCount: number
  /** Terminal tabs whose leaves carry agent evidence (launch agent or hook agent type). */
  agentTerminalTabIds: string[]
  otherTabCounts: Record<string, number>
  /** Step 3: generation, shared revision and client projection revision, when negotiated. */
  inventoryOrder?: SessionTabsInventoryOrder
}

function hasAgentEvidence(tab: FrameTab): boolean {
  if (tab.type === 'agent-session') {
    return Boolean(tab.agent)
  }
  return tab.type === 'terminal' && Boolean(tab.launchAgent || tab.agentStatus?.agentType)
}

export function summarizeSessionTabsFrame(frame: FrameLike): SessionTabsFrameSummary {
  const terminalTabIds = new Set<string>()
  const agentTerminalTabIds = new Set<string>()
  const otherTabCounts: Record<string, number> = {}
  let terminalLeafCount = 0
  for (const tab of frame.tabs) {
    if (tab.type === 'terminal') {
      const hostTabId = tab.parentTabId ?? tab.id
      terminalLeafCount += 1
      terminalTabIds.add(hostTabId)
      if (hasAgentEvidence(tab)) {
        agentTerminalTabIds.add(hostTabId)
      }
      continue
    }
    otherTabCounts[tab.type] = (otherTabCounts[tab.type] ?? 0) + 1
  }
  return {
    worktree: frame.worktree,
    epoch: frame.publicationEpoch,
    version: frame.snapshotVersion,
    removed: frame.removed === true,
    ...(frame.membershipUnverified === true ? { membershipUnverified: true as const } : {}),
    ...(typeof frame.changeSequence === 'number' ? { changeSequence: frame.changeSequence } : {}),
    tabCount: frame.tabs.length,
    terminalTabIds: [...terminalTabIds],
    terminalLeafCount,
    agentTerminalTabIds: [...agentTerminalTabIds],
    otherTabCounts,
    ...withInventoryOrder(frame)
  }
}

function withInventoryOrder(frame: FrameLike): { inventoryOrder?: SessionTabsInventoryOrder } {
  const inventoryOrder = readSessionTabsInventoryOrder(frame)
  return inventoryOrder ? { inventoryOrder } : {}
}

export type SessionTabsMembershipDiff = {
  lostTabIds: string[]
  addedTabIds: string[]
  /** Tabs present on both sides that carried agent evidence before and none after. */
  lostAgentEvidenceTabIds: string[]
}

/** Per-tab (surface) membership change; a removed tab is listed as lost, never as lost evidence. */
export function diffSessionTabsMembership(
  before: readonly FrameTab[] | undefined,
  after: readonly FrameTab[] | undefined
): SessionTabsMembershipDiff {
  const afterById = new Map((after ?? []).map((tab) => [tab.id, tab]))
  const beforeIds = new Set<string>()
  const lostTabIds: string[] = []
  const lostAgentEvidenceTabIds: string[] = []
  for (const tab of before ?? []) {
    beforeIds.add(tab.id)
    const next = afterById.get(tab.id)
    if (!next) {
      lostTabIds.push(tab.id)
    } else if (hasAgentEvidence(tab) && !hasAgentEvidence(next)) {
      lostAgentEvidenceTabIds.push(tab.id)
    }
  }
  const addedTabIds = [...afterById.keys()].filter((id) => !beforeIds.has(id))
  return { lostTabIds, addedTabIds, lostAgentEvidenceTabIds }
}

export type FrameLogPtyKind =
  | 'none'
  | 'local'
  | 'remote-runtime'
  | 'ssh'
  | 'foreign'
  | 'web-terminal-mirror'

/** The PTY id kind the publication predicates read; a web-terminal mirror wins over its PTY kind. */
export function classifyFrameLogPtyKind(
  ptyId: string | null | undefined,
  tab?: { id: string; ptyId?: string | null },
  layout?: { ptyIdsByLeafId?: Record<string, string> }
): FrameLogPtyKind {
  if (tab && isWebOnlyMirroredTerminalTab(tab, layout)) {
    return 'web-terminal-mirror'
  }
  const host = getPtyExecutionHost(ptyId)
  if (host === null) {
    return ptyId ? 'local' : 'none'
  }
  if (host === 'foreign') {
    return 'foreign'
  }
  return host.startsWith('ssh:') ? 'ssh' : host.startsWith('runtime:') ? 'remote-runtime' : 'local'
}

export function countBy<T>(values: Iterable<T>): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const value of values) {
    const key = String(value)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}
