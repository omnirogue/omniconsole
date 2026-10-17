/**
 * The contract behind `omni folder …` / `omni session move|archive|delete`: the local CLI asks the runtime,
 * the runtime asks the desktop renderer (which owns the Conversations sidebar folders in its
 * own store), and the renderer applies one operation through the same store actions the
 * sidebar uses, then answers.
 */

import { z } from 'zod'
import { SessionWorkflowAnchorRefSchema } from './session-workflow-anchor'
import type { SessionBatchOriginRequest } from './session-batch-origin'
import type { SessionManageRendererRequest } from './session-manage-relay'
import type { SessionProjectRendererRequest } from './session-project-cli'
import {
  ORGANIZATION_TITLE_ORIGINS,
  type OrganizationChange,
  type OrganizationProbeAnswer,
  type OrganizationRecord,
  type OrganizationRelayedChange,
  type OrganizationRelayedOutcome
} from './session-organization-change'

export const SESSION_FOLDERS_RPC = {
  list: 'sessionFolders.list',
  mutate: 'sessionFolders.mutate'
} as const

/** How long `moveSession` may wait for a just-created pane to appear in the sidebar. */
export const SESSION_FOLDER_MAX_WAIT_MS = 10_000

/** A folder id, or a path such as "Saved Sessions / Clients / Acme" (see session-folder-ref.ts). */
const folderRef = z.string().trim().min(1).max(1000)
const folderName = z.string().trim().min(1).max(500)

/** The conversation an archive or delete names: a pane, or the tab a terminal handle lives in. */
const sessionTarget = {
  paneKey: z.string().trim().min(1).max(1000).optional(),
  tabId: z.string().trim().min(1).max(1000).optional(),
  /** A pane-less workflow anchor in that tab, named by its controller and run: matched exactly. */
  workflow: SessionWorkflowAnchorRefSchema.optional()
}
const namesSession = (op: { paneKey?: string; tabId?: string }): boolean =>
  op.paneKey !== undefined || op.tabId !== undefined
const NAME_SESSION = { message: 'Name the session with a pane key or a tab id.' }

export const SessionFolderOpSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('createFolder'),
      name: folderName,
      /** Nest inside this folder; its section wins over `saved`. */
      parent: folderRef.optional(),
      /** Without `parent`: create at the top of Saved Sessions instead of Conversations. */
      saved: z.boolean().optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal('moveFolder'),
      folder: folderRef,
      /** Absent: move to the top of `section` (the folder's own section when that is absent too). */
      into: folderRef.optional(),
      section: z.enum(['saved', 'active']).optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal('reorderFolder'),
      folder: folderRef,
      /** A sibling: same parent, same section. */
      target: folderRef,
      position: z.enum(['before', 'after'])
    })
    .strict(),
  /** The sidebar's "Delete folder": subfolders and sessions move up; nothing else is deleted. */
  z.object({ kind: z.literal('deleteFolder'), folder: folderRef }).strict(),
  z.object({ kind: z.literal('renameFolder'), folder: folderRef, name: folderName }).strict(),
  z
    .object({
      kind: z.literal('colorFolder'),
      folder: folderRef,
      /** A color name; null clears it. */
      color: z.string().trim().min(1).max(40).nullable()
    })
    .strict(),
  z
    .object({
      kind: z.literal('moveSession'),
      /** The pane whose conversation moves (ORCA_PANE_KEY inside a pane). */
      paneKey: z.string().trim().min(1).max(1000).optional(),
      /** Or the tab a terminal was just created in. */
      tabId: z.string().trim().min(1).max(1000).optional(),
      destination: z.enum(['folder', 'saved', 'unfile']),
      folder: folderRef.optional(),
      /** Keep looking for the pane this long; a freshly created one may not be listed yet. */
      waitMs: z.number().int().min(0).max(SESSION_FOLDER_MAX_WAIT_MS).optional()
    })
    .strict()
    .refine((op) => op.paneKey !== undefined || op.tabId !== undefined, {
      message: 'Name the session with a pane key or a tab id.'
    })
    .refine((op) => (op.destination === 'folder') === (op.folder !== undefined), {
      message: 'A folder destination needs a folder, and only a folder destination takes one.'
    }),
  z
    .object({
      kind: z.literal('archiveSession'),
      ...sessionTarget,
      /** False takes back an archive, by hand or automatic, as the row’s Unarchive does. */
      archived: z.boolean()
    })
    .strict()
    .refine(namesSession, NAME_SESSION),
  z
    .object({
      kind: z.literal('deleteSession'),
      ...sessionTarget,
      /** Stop and delete a conversation whose agent is still working. */
      force: z.boolean().optional(),
      /** The person also lets go of a session this computer runs but cannot verify. */
      unverified: z.boolean().optional(),
      /** Gone for good (a review page's Reject): its tab closes without a Recently closed entry. */
      purge: z.boolean().optional()
    })
    .strict()
    .refine(namesSession, NAME_SESSION)
])

export type SessionFolderOp = z.infer<typeof SessionFolderOpSchema>

export const SessionFolderMutateParamsSchema = z
  .object({
    op: SessionFolderOpSchema,
    /** Resolve and check everything, change nothing, and say what would change. */
    dryRun: z.boolean().optional(),
    /** Why, and the person's own words that asked for it; both go to the audit log. */
    reason: z.string().trim().min(1).max(1000).optional(),
    request: z.string().trim().min(1).max(4000).optional(),
    /** The change's id when the caller chose one; main mints it otherwise. */
    opId: z.string().trim().min(1).max(200).optional(),
    /** Titles only: whose words the title is. */
    origin: z.enum(ORGANIZATION_TITLE_ORIGINS).optional(),
    /** Refuse when the target changed since this revision. */
    expectedRevision: z.string().trim().min(1).max(200).optional(),
    /** A move that files a session this command just launched; recorded with launch's own reason. */
    launch: z.enum(['terminal-create', 'session-launch']).optional()
  })
  .strict()

export type SessionFolderSectionName = 'saved' | 'active'

/** One folder as the CLI sees it. */
export type SessionFolderEntry = {
  id: string
  name: string
  /** "Saved Sessions / Clients / Acme" or "Clients / Acme". */
  path: string
  section: SessionFolderSectionName
  parentId: string | null
  color: string | null
  /** Conversations filed directly in this folder. */
  sessionCount: number
}

export type SessionFolderListResult = { folders: SessionFolderEntry[] }

export type SessionFolderMutationResult = {
  /** One sentence naming what changed, as the in-app toast shows it. */
  summary: string
  /** The folder that was created, moved, renamed or colored — or deleted, as it was. */
  folder?: SessionFolderEntry
  /** The conversation that moved (its folder-membership key). */
  sessionKey?: string
  /** Set on a dry run: nothing changed, and `summary` says what would have. */
  dryRun?: true
  /** Where the conversation or folder was, and is now, for the audit log. */
  before?: string | null
  after?: string | null
  /** From a window that understood the relayed `change`: resolved targets and values. */
  organization?: OrganizationRelayedOutcome
  /** The recorded change's id (main's answer to the CLI). */
  opId?: string
  /** A deleted conversation's tab: closed (its agent ended), kept open, or not yet reported. */
  tabClose?: 'closed' | 'declined' | 'unverified'
}

export type SessionFolderRendererRequest =
  | { kind: 'list' }
  | {
      kind: 'mutate'
      op: SessionFolderOp
      dryRun?: boolean
      /** Who acts and why, for the change record; an older window ignores it. */
      change?: OrganizationRelayedChange
    }
  /** Startup reconciliation: does each interrupted change hold now? */
  | { kind: 'probeOrganization'; records: OrganizationRecord[] }
  /** One prepared change for many targets; answered with `OrganizationRelayedOutcome`. */
  | { kind: 'applyOrganizationChange'; change: OrganizationChange }
  /**
   * Several prepared changes from one organize, applied in order with one notice and one Undo;
   * answered with `SessionOrganizeRelayReply`. An older window answers nothing.
   */
  | { kind: 'applyOrganizationChanges'; changes: OrganizationChange[] }

export type SessionFolderProbeReply = { answers: OrganizationProbeAnswer[] }

export const SESSION_FOLDERS_NO_WINDOW_ERROR =
  'The OmniConsole window is not open, so its Conversations sidebar cannot be read or changed.'
export const SESSION_FOLDERS_TIMEOUT_ERROR =
  'The OmniConsole window did not answer the session folder request in time.'

/** Everything the window answers over this relay: folders, batch origins and `sessionManage.*`. */
export type SessionFolderRelayRequest =
  | SessionFolderRendererRequest
  | SessionBatchOriginRequest
  | SessionManageRendererRequest
  | SessionProjectRendererRequest

export type SessionFolderRendererRequestPayload = {
  requestId: string
  request: SessionFolderRelayRequest
}

export type SessionFolderRendererReply =
  | { requestId: string; ok: true; result: unknown }
  | { requestId: string; ok: false; error: string }
