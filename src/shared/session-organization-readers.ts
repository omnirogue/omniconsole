/**
 * What `omni session history`, `omni session actions`, the History section and the Steward
 * activity card read: main's history per session, recent changes, and the raw action trail.
 */

import { z } from 'zod'
import type { HibernationAudit } from './idle-auto-close-settings'
import type { SessionManageUnattended, SessionStewardAudit } from './session-manage-types'
import {
  isStewardExecutor,
  ORGANIZATION_EXECUTOR_KINDS,
  type OrganizationExecutor,
  type OrganizationHistory,
  type OrganizationPhase,
  type OrganizationRecord,
  type OrganizationTitleOrigin,
  type OrganizationTrailBody
} from './session-organization-change'

/** The whole trail, not only organization changes: stop, ask, rename and the rest too. */
export const SESSION_ORGANIZATION_ACTIONS_RPC = 'sessionOrganization.actions'

/**
 * Executor kinds, plus `steward` (the app's own unattended actions, Phase 2) and `hibernation`
 * (agent sleep, its wakes and the idle rules).
 */
export const SESSION_ACTION_ACTOR_FILTERS = [
  ...ORGANIZATION_EXECUTOR_KINDS,
  'steward',
  'hibernation'
] as const

export const OrganizationActionsParamsSchema = z
  .object({
    /** Epoch ms; default the last 24 hours. */
    since: z.number().int().min(0).optional(),
    actors: z.array(z.enum(SESSION_ACTION_ACTOR_FILTERS)).max(10).optional(),
    /** An organization kind (`move`, `title`, …) or an action (`stop`, `session.move`, …). */
    kinds: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    limit: z.number().int().min(1).max(2000).optional()
  })
  .strict()

export type OrganizationActionsParams = z.infer<typeof OrganizationActionsParamsSchema>

/** One line of `<userData>/session-actions.jsonl`, as main wrote it. */
export type SessionActionLine = {
  ts: string
  actor: { paneKey: string; title: string } | string
  unverifiedPaneKey?: string
  steward?: SessionStewardAudit
  unattended?: SessionManageUnattended
  remote?: { computer: string; peer: string; requester: string; title: string }
  hibernation?: HibernationAudit
  action: string
  target: { paneKey?: string | null; tabId?: string | null; title?: string; folder?: string }
  before?: unknown
  after?: unknown
  summary: string
  reason?: string
  request?: string
  opId?: string
  phase?: OrganizationPhase
  executor?: OrganizationExecutor
  origin?: OrganizationTitleOrigin
  revision?: string
  organization?: OrganizationTrailBody
}

export type OrganizationActionsResult = { actions: SessionActionLine[] }

/** A session's history as `sessionOrganization.history` answers a pane or tab. */
export type OrganizationSessionHistory = OrganizationHistory & {
  /** Applied changes that Undo can still put back, at least in part. */
  undoable?: string[]
  /** The sidebar row the pane or tab resolved to; absent for a bare key. */
  row?: { viewKey: string; title: string; paneKey: string | null; tabId: string | null }
}

export type OrganizationRecentResult = { entries: OrganizationRecord[]; undoable?: string[] }

/** `--since 24h`, `90m`, `7d`, `30s`: a duration back from now, in ms. */
export function parseSinceDuration(raw: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/i.exec(raw.trim())
  if (!match) {
    return null
  }
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[
    match[2]!.toLowerCase() as 's' | 'm' | 'h' | 'd' | 'w'
  ]
  const ms = Number(match[1]) * unit
  return Number.isFinite(ms) && ms > 0 ? ms : null
}

/** The executor kind a trail line names (`steward` for the app's steward), else its legacy actor. */
export function sessionActionActorKind(
  line: Pick<SessionActionLine, 'executor' | 'actor'>
): string {
  if (line.actor === 'steward' || (line.executor && isStewardExecutor(line.executor))) {
    return 'steward'
  }
  if (line.executor) {
    return line.executor.kind
  }
  return typeof line.actor === 'string' ? line.actor : 'pane'
}
