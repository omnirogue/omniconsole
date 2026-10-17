/**
 * `omni session organize|tag|hide|unhide|snooze`: an agent organizes the Conversations sidebar the
 * way the person can, in bulk. A plan names what changes per session; main turns it into one
 * recorded change per kind (many targets each, one reason, one Undo in the window). See
 * docs/reference/session-organization-change-path.md.
 */

import { z } from 'zod'
import type { SessionManageActor } from './session-manage-types'
import {
  ORGANIZATION_TITLE_ORIGINS,
  SESSION_ORGANIZATION_RPC,
  type OrganizationChangeKind,
  type OrganizationTarget,
  type OrganizationTitleOrigin
} from './session-organization-change'
import type { SessionFocusEstimate } from './session-organize-focus'

export const SESSION_ORGANIZE_RPC = SESSION_ORGANIZATION_RPC.organize

export const SESSION_ORGANIZE_MAX_ENTRIES = 1000
const MAX_TAGS_PER_ENTRY = 20

const pane = z.string().trim().min(1).max(1000)
const tagRef = z.string().trim().min(1).max(40)

/** One session's changes. `snooze` is the wake time in epoch ms (the CLI parses "+2h" etc.), null wakes it. */
export const SessionOrganizeEntrySchema = z
  .object({
    pane,
    folder: z.string().trim().min(1).max(1000).optional(),
    unfile: z.literal(true).optional(),
    archive: z.boolean().optional(),
    hide: z.boolean().optional(),
    snooze: z.number().finite().nullable().optional(),
    addTags: z.array(tagRef).max(MAX_TAGS_PER_ENTRY).optional(),
    removeTags: z.array(tagRef).max(MAX_TAGS_PER_ENTRY).optional(),
    title: z.string().trim().min(1).max(200).optional(),
    origin: z.enum(ORGANIZATION_TITLE_ORIGINS).optional(),
    /** From a dry run: skip this session when anything organized it since. */
    expectedRevision: z.string().trim().min(1).max(200).optional()
  })
  .strict()

export const SessionOrganizeFolderSchema = z
  .object({
    /** A path such as "OmniRogue / Checkout"; missing parents are created too. */
    create: z.string().trim().min(1).max(1000),
    color: z.string().trim().min(1).max(40).nullable().optional()
  })
  .strict()

export const SessionOrganizePlanSchema = z
  .object({
    reason: z.string().trim().min(1).max(1000).optional(),
    request: z.string().trim().min(1).max(4000).optional(),
    changes: z.array(SessionOrganizeEntrySchema).max(SESSION_ORGANIZE_MAX_ENTRIES),
    folders: z.array(SessionOrganizeFolderSchema).max(200).optional()
  })
  .strict()

export const SessionOrganizeParamsSchema = z
  .object({
    plan: SessionOrganizePlanSchema,
    /** Absent: a dry run that changes nothing. */
    apply: z.boolean().optional()
  })
  .strict()

export type SessionOrganizeEntry = z.infer<typeof SessionOrganizeEntrySchema>
export type SessionOrganizeFolder = z.infer<typeof SessionOrganizeFolderSchema>
export type SessionOrganizePlan = z.infer<typeof SessionOrganizePlanSchema>
export type SessionOrganizeParams = z.infer<typeof SessionOrganizeParamsSchema>

/** A plan entry (or part of one) that was not planned or applied, and why. */
export type SessionOrganizeSkip = {
  pane: string
  /** The change kind skipped, or `entry` for the whole entry. */
  kind: OrganizationChangeKind | 'entry'
  reason: string
}

export type SessionOrganizeChangeReport = {
  kind: OrganizationChangeKind
  panes: string[]
  /** Present once recorded. */
  opId?: string
  status: 'planned' | 'applied' | 'failed'
  error?: string
  origin?: OrganizationTitleOrigin
}

export type SessionOrganizeFolderReport = {
  path: string
  status: 'exists' | 'create' | 'created' | 'failed'
  color?: string | null
  error?: string
}

export type SessionOrganizeResult = {
  dryRun: boolean
  actor: SessionManageActor
  reason?: string
  request?: string
  folders: SessionOrganizeFolderReport[]
  changes: SessionOrganizeChangeReport[]
  skipped: SessionOrganizeSkip[]
  /** The default sidebar's lines before and (as planned) after, against the five-line budget. */
  focus: { before: SessionFocusEstimate; after: SessionFocusEstimate }
  /** Dry run: the plan with each session's current revision filled in, to apply as checked. */
  plan?: SessionOrganizePlan
  auditError?: string
}

/** What main relays to the window: several prepared changes, applied in order, one notice. */
export type SessionOrganizeRelayOutcome =
  | {
      ok: true
      opId: string
      targets: OrganizationTarget[]
      value: unknown
      values?: unknown[]
      before?: unknown[]
      after?: unknown[]
    }
  | { ok: false; opId: string; error: string }

export type SessionOrganizeRelayReply = { outcomes: SessionOrganizeRelayOutcome[] }

const RELATIVE = /^\+?\s*(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/i
const DAY_TIME = /^(today|tomorrow)(?:\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/i
const DEFAULT_WAKE_HOUR = 9

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 }

/**
 * `--until` for a snooze: an ISO time, "+2h" / "30m" / "+1d", "today 17:00", "tomorrow 9:00"
 * (or "tomorrow", at 9:00) in this computer's time zone, or "none" to wake it now. Epoch ms, or
 * null for none; throws on anything else or a time already past.
 */
export function parseSnoozeUntil(text: string, now: Date = new Date()): number | null {
  const value = text.trim()
  if (/^(none|wake|now|off)$/i.test(value)) {
    return null
  }
  let at: number
  const relative = RELATIVE.exec(value)
  const dayTime = relative ? null : DAY_TIME.exec(value)
  if (relative) {
    at = now.getTime() + Number(relative[1]) * UNIT_MS[relative[2]![0]!.toLowerCase()]!
  } else if (dayTime) {
    let hour = dayTime[2] === undefined ? DEFAULT_WAKE_HOUR : Number(dayTime[2])
    const minute = dayTime[3] === undefined ? 0 : Number(dayTime[3])
    const meridiem = dayTime[4]?.toLowerCase()
    if (meridiem === 'pm' && hour < 12) {
      hour += 12
    } else if (meridiem === 'am' && hour === 12) {
      hour = 0
    }
    if (hour > 23 || minute > 59) {
      throw new Error(`"${text}" is not a time of day.`)
    }
    const date = new Date(now)
    date.setDate(date.getDate() + (dayTime[1]!.toLowerCase() === 'tomorrow' ? 1 : 0))
    date.setHours(hour, minute, 0, 0)
    at = date.getTime()
  } else {
    at = Date.parse(value)
    if (!Number.isFinite(at)) {
      throw new Error(
        `"${text}" is not a wake time. Use an ISO time, +2h, 30m, +1d, "today 17:00", "tomorrow 9:00" or none.`
      )
    }
  }
  if (at <= now.getTime()) {
    throw new Error(`"${text}" is already past; a snooze wakes at a later time.`)
  }
  return at
}
