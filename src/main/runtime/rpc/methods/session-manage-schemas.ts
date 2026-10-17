import { z } from 'zod'
import { sessionManageHostKey } from '../../../../shared/session-manage-query'
import { SESSION_MANAGE_STATES } from '../../../../shared/session-manage-types'
import { parseSessionReference } from '../../../../shared/session-reference'
import { SESSION_SHOW_MODES } from '../../../../shared/session-show'
import { ORGANIZATION_TITLE_ORIGINS } from '../../../../shared/session-organization-change'
import {
  SESSION_OWNER_MAX_FILES,
  SESSION_OWNER_TASK_MAX_CHARS
} from '../../../../shared/session-owner-types'

const bounded = (max: number) => z.string().trim().min(1).max(max)

/** The conversation acted on: a pane key (structured chats included), or a terminal's tab. */
export const SessionManageTarget = z
  .object({ paneKey: bounded(1000).optional(), tabId: bounded(1000).optional() })
  .strict()
  .refine((target) => target.paneKey !== undefined || target.tabId !== undefined, {
    message: 'Name the session with --pane <paneKey> or --terminal <handle>.'
  })

/** Why the action ran, and the person's words that asked for it; both land in the audit log. */
const provenance = {
  reason: bounded(1000).optional(),
  request: bounded(4000).optional(),
  dryRun: z.boolean().optional()
}

export const SessionManageListParams = z
  .object({
    hostId: bounded(4096)
      .refine(
        (value) => sessionManageHostKey(value) !== null,
        'Use an exact local, ssh:<id> or runtime:<id> host.'
      )
      .transform((value) => sessionManageHostKey(value)!)
      .optional(),
    query: bounded(256).optional(),
    states: z.array(z.enum(SESSION_MANAGE_STATES)).min(1).max(8).optional(),
    folder: bounded(1000).optional(),
    /** A project folder, or a folder in one: only that project's threads are listed. */
    project: bounded(1000).optional(),
    includeArchived: z.boolean().optional(),
    /**
     * Session parity (C5): also export the UNFILTERED parity population. Only `omni session list`
     * asks; the CLI's own resolvers (refs, folders, outcome waits, search) never read it, and it
     * costs the window a second full build and the caller the whole population's JSON.
     */
    parity: z.boolean().optional()
  })
  .strict()

export const SessionManageAnswer = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('yes') }).strict(),
  z.object({ kind: z.literal('choose'), choice: z.number().int().min(1).max(25) }).strict(),
  z.object({ kind: z.literal('prompt'), text: z.string().min(1).max(30_000) }).strict()
])

export const SessionManageContinueParams = z
  .object({ target: SessionManageTarget, answer: SessionManageAnswer, ...provenance })
  .strict()

export const SessionManagePromptAnswerParams = z
  .object({
    target: z.object({ paneKey: bounded(1000), terminal: bounded(1000).optional() }).strict(),
    expect: z
      .string()
      .regex(/^[a-f0-9]{64}$/, 'Pass --expect with the fingerprint from session list.'),
    answer: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('allow') }).strict(),
      z.object({ kind: z.literal('deny') }).strict(),
      z.object({ kind: z.literal('choose'), choice: z.number().int().min(1).max(25) }).strict(),
      z.object({ kind: z.literal('text'), text: bounded(4000) }).strict()
    ]),
    ...provenance
  })
  .strict()

export const SESSION_MANAGE_ASK_DEFAULT_TIMEOUT_MS = 5 * 60_000
export const SESSION_MANAGE_ASK_MAX_TIMEOUT_MS = 30 * 60_000

export const SessionManageAskParams = z
  .object({
    target: SessionManageTarget,
    question: z.string().min(1).max(30_000),
    expectedRef: bounded(600)
      .refine((value) => parseSessionReference(value) !== null)
      .optional(),
    requireKeepGoingOff: z.boolean().optional(),
    timeoutMs: z.number().int().min(1_000).max(SESSION_MANAGE_ASK_MAX_TIMEOUT_MS).optional(),
    ...provenance
  })
  .strict()

export const SessionManageStopParams = z
  .object({ target: SessionManageTarget, force: z.boolean().optional(), ...provenance })
  .strict()

export const SessionManageRestartParams = z
  .object({ target: SessionManageTarget, ...provenance })
  .strict()

export const SessionManageRenameParams = z
  .object({
    target: SessionManageTarget,
    title: bounded(200),
    // Why optional: the title's origin reads as unknown when the caller does not say.
    origin: z.enum(ORGANIZATION_TITLE_ORIGINS).optional(),
    ...provenance
  })
  .strict()

/** `omni session show`; older CLIs never send it, so mode and flash default on the host. */
export const SessionManageShowParams = z
  .object({
    target: SessionManageTarget,
    mode: z.enum(SESSION_SHOW_MODES).optional(),
    flash: z.boolean().optional()
  })
  .strict()

export type SessionManageTargetInput = z.infer<typeof SessionManageTarget>
export type SessionManageProvenance = {
  reason?: string
  request?: string
  dryRun?: boolean
}

/** A move to another computer (`--host`): its host and, optionally, the workspace there. */
const hostMove = {
  host: bounded(4096).optional(),
  workspace: bounded(32_768).optional()
}

export const SessionManageHandoffParams = z
  .object({
    target: SessionManageTarget,
    to: bounded(1000),
    note: z.string().max(30_000).optional(),
    ...hostMove,
    ...provenance
  })
  .strict()

export const SessionManageConsolidateParams = z
  .object({
    panes: z.array(bounded(1000)).min(2).max(50),
    into: bounded(1000),
    skipBusy: z.boolean().optional(),
    ...hostMove,
    ...provenance
  })
  .strict()

export const SessionManageTidyParams = z
  .object({
    apply: z.boolean().optional(),
    hostId: SessionManageListParams.shape.hostId,
    /** Held sessions the person's request names; skip-class sessions are never archived. */
    include: z.array(bounded(1000)).max(200).optional(),
    /** Delete instead of archive (`--delete`); the plan keeps whatever still has value. */
    delete: z.boolean().optional(),
    /** With `delete`: also sessions this computer runs but cannot verify (their tab closes here). */
    unverified: z.boolean().optional(),
    reason: provenance.reason,
    request: provenance.request
  })
  .strict()

const ownerTask = z.string().trim().min(1).max(SESSION_OWNER_TASK_MAX_CHARS)

export const SessionManageFindOwnerParams = z
  .object({
    task: ownerTask,
    /** Files the task will touch besides those its text names; the strongest signal. */
    files: z.array(bounded(1000)).max(SESSION_OWNER_MAX_FILES).optional(),
    /** The existing workspace the task would run in (a worktree id from session list). */
    worktree: bounded(4096).optional(),
    folder: bounded(1000).optional(),
    repo: bounded(1000).optional()
  })
  .strict()

export const SessionManageAssignParams = z
  .object({
    target: SessionManageTarget.optional(),
    /** A past conversation (`find-owner`'s `pastOwner.ref`): unarchived or resumed first. */
    ref: bounded(600).optional(),
    task: ownerTask,
    /** Why this session and not a new one; required so the audit line explains the choice. */
    reason: bounded(1000),
    request: provenance.request,
    dryRun: provenance.dryRun
  })
  .strict()
  .refine((params) => (params.target === undefined) !== (params.ref === undefined), {
    message: 'Name the session with --pane, --terminal or --ref.'
  })
