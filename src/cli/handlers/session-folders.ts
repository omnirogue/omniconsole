/**
 * `omni folder …` and `omni session move|archive|delete` — reorganizing the Conversations sidebar
 * from a shell.
 *
 * The folders live in the desktop window's own store, so every command goes through the
 * `sessionFolders.*` RPC, which the runtime relays to that window. The window applies each change
 * through the same actions the sidebar uses, shows a toast naming it with an Undo button, and
 * unfolds the destination so the change is seen. Folder references are an id or a path
 * ("Saved Sessions / Clients / Acme"), resolved in the window — see shared/session-folder-ref.ts.
 */

import type { RuntimeTerminalCreate } from '../../shared/runtime-types'
import {
  SESSION_FOLDERS_RPC,
  type SessionFolderEntry,
  type SessionFolderListResult,
  type SessionFolderMutationResult,
  type SessionFolderOp
} from '../../shared/session-folder-cli'
import { resolveSessionFolderRef, SAVED_SESSIONS_REF_ID } from '../../shared/session-folder-ref'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'
import { resolveSessionTarget, resolveTabTarget, type SessionTarget } from './session-folder-target'
import { sessionProvenance } from './session-provenance-flags'

type Flags = HandlerContext['flags']

/** How long a folder move for a new terminal waits for its pane to be listed. */
const NEW_TERMINAL_WAIT_MS = 5_000

export const SESSION_FOLDER_COLOR_NAMES =
  'red, orange, amber (yellow), green, teal, blue, violet (purple), pink, gray, or none'

function formatEntry(entry: SessionFolderEntry): string {
  const details = [
    entry.color ? `color ${entry.color}` : null,
    `${entry.sessionCount} session${entry.sessionCount === 1 ? '' : 's'}`
  ].filter(Boolean)
  return `${entry.path}  (${details.join(', ')})  id ${entry.id}`
}

function formatList(result: SessionFolderListResult): string {
  return result.folders.length
    ? result.folders.map(formatEntry).join('\n')
    : 'No folders yet. Create one with: omni folder create --name "<name>" [--saved]'
}

function formatMutation(result: SessionFolderMutationResult & { auditError?: string }): string {
  const lines = [
    result.folder && !result.dryRun
      ? `${result.summary}\n${formatEntry(result.folder)}`
      : result.summary
  ]
  if (result.auditError) {
    lines.push(`warning: ${result.auditError}`)
  }
  return lines.join('\n')
}

function bool(flags: Flags, name: string): boolean {
  return flags.get(name) === true
}

function refuseRemote(client: RuntimeClient): void {
  if (client.isRemote) {
    throw new RuntimeClientError(
      'permission_denied',
      'Session folders can only be changed by the omni CLI on the computer running OmniConsole.'
    )
  }
}

async function mutate({ client, flags, json }: HandlerContext, op: SessionFolderOp): Promise<void> {
  refuseRemote(client)
  const response = await client.call<SessionFolderMutationResult>(SESSION_FOLDERS_RPC.mutate, {
    op,
    ...sessionProvenance(flags)
  })
  printResult(response, json, formatMutation)
}

/** `--tab-id <tabId>` names a row with no pane (a tab left from an earlier run); else the usual target. */
async function tabOrSessionTarget(
  context: HandlerContext,
  verb: 'archive' | 'delete'
): Promise<SessionTarget> {
  const tab = getOptionalStringFlag(context.flags, 'tab-id')
  if (tab === undefined) {
    return resolveSessionTarget(context.client, context.flags)
  }
  if (['terminal', 'pane', 'ref'].some((name) => context.flags.get(name) !== undefined)) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Pass --tab-id alone, not with --terminal, --pane or --ref.'
    )
  }
  const target = await resolveTabTarget(context.client, tab)
  // Why: the window archives a pane-less row only when it is a workflow conversation.
  if (verb === 'archive' && !target.workflow) {
    throw new RuntimeClientError(
      'not_found',
      `No workflow conversation lives in tab ${tab}. session archive --tab-id names a Council, Discover, Evolve or Build + Review conversation; name any other row with --terminal, --pane or --ref.`
    )
  }
  return target
}

function moveFolderOp(flags: Flags): SessionFolderOp {
  const folder = getRequiredStringFlag(flags, 'folder')
  const into = getOptionalStringFlag(flags, 'into')
  const top = bool(flags, 'top')
  const before = getOptionalStringFlag(flags, 'before')
  const after = getOptionalStringFlag(flags, 'after')
  if (
    [into !== undefined, top, before !== undefined, after !== undefined].filter(Boolean).length !==
    1
  ) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Pass exactly one of --into <folder id|path>, --top [--saved|--active], --before <folder id|path> or --after <folder id|path>.'
    )
  }
  if (before !== undefined || after !== undefined) {
    if (bool(flags, 'saved') || bool(flags, 'active')) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--saved/--active go with --top; --before/--after keep the folder where it is.'
      )
    }
    return before !== undefined
      ? { kind: 'reorderFolder', folder, target: before, position: 'before' }
      : { kind: 'reorderFolder', folder, target: after!, position: 'after' }
  }
  if (bool(flags, 'saved') && bool(flags, 'active')) {
    throw new RuntimeClientError('invalid_argument', 'Pass --saved or --active, not both.')
  }
  if (into !== undefined && (bool(flags, 'saved') || bool(flags, 'active'))) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--saved/--active go with --top; with --into the destination folder decides the section.'
    )
  }
  const section = bool(flags, 'saved') ? 'saved' : bool(flags, 'active') ? 'active' : undefined
  return { kind: 'moveFolder', folder, ...(into ? { into } : {}), ...(section ? { section } : {}) }
}

function moveSessionOp(flags: Flags, target: SessionTarget): SessionFolderOp {
  const folder = getOptionalStringFlag(flags, 'folder')
  const chosen = [folder !== undefined, bool(flags, 'saved'), bool(flags, 'unfile')]
  if (chosen.filter(Boolean).length !== 1) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Pass exactly one of --folder <id|path>, --saved or --unfile.'
    )
  }
  return folder !== undefined
    ? { kind: 'moveSession', ...target, destination: 'folder', folder }
    : { kind: 'moveSession', ...target, destination: bool(flags, 'saved') ? 'saved' : 'unfile' }
}

/**
 * Checks a `--folder` reference before a terminal is created for it, so a typo fails without
 * leaving a stray terminal behind. Returns the folder id (or the Saved Sessions root).
 */
export async function resolveFolderForNewTerminal(
  client: RuntimeClient,
  ref: string
): Promise<string> {
  refuseRemote(client)
  const response = await client.call<SessionFolderListResult>(SESSION_FOLDERS_RPC.list)
  const resolved = resolveSessionFolderRef(response.result.folders, ref)
  if (!resolved.ok) {
    throw new RuntimeClientError('invalid_argument', resolved.error)
  }
  return resolved.target.kind === 'folder' ? resolved.target.folder.id : SAVED_SESSIONS_REF_ID
}

/** Launch filing: an older runtime's strict schema refuses the marker, so it files without it. */
async function callLaunchFiling(
  client: RuntimeClient,
  op: SessionFolderOp,
  launch: 'terminal-create' | 'session-launch'
): Promise<SessionFolderMutationResult> {
  try {
    return (
      await client.call<SessionFolderMutationResult>(SESSION_FOLDERS_RPC.mutate, { op, launch })
    ).result
  } catch (error) {
    if (
      error instanceof RuntimeClientError &&
      error.code === 'invalid_argument' &&
      /\blaunch\b/.test(error.message)
    ) {
      return (await client.call<SessionFolderMutationResult>(SESSION_FOLDERS_RPC.mutate, { op }))
        .result
    }
    throw error
  }
}

/** Files a just-created terminal into a folder, waiting briefly for the sidebar to list it. */
export async function fileNewTerminal(
  client: RuntimeClient,
  terminal: RuntimeTerminalCreate,
  folderId: string,
  launch: 'terminal-create' | 'session-launch' = 'terminal-create'
): Promise<SessionFolderMutationResult> {
  if (!terminal.paneKey && !terminal.tabId) {
    throw new RuntimeClientError(
      'session_folder_failed',
      `Created terminal ${terminal.handle} in the background, so it has no sidebar row to file. Move it later with: omni session move --pane <paneKey> --folder <id|path> --reason "<why>"`
    )
  }
  try {
    return await callLaunchFiling(
      client,
      {
        kind: 'moveSession',
        ...(terminal.paneKey ? { paneKey: terminal.paneKey } : {}),
        ...(terminal.tabId ? { tabId: terminal.tabId } : {}),
        destination: 'folder',
        folder: folderId,
        waitMs: NEW_TERMINAL_WAIT_MS
      },
      launch
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new RuntimeClientError(
      'session_folder_failed',
      `Created terminal ${terminal.handle}, but could not file it in the folder: ${message}`
    )
  }
}

export const SESSION_FOLDER_HANDLERS: Record<string, CommandHandler> = {
  'folder list': async ({ client, json }) => {
    refuseRemote(client)
    const response = await client.call<SessionFolderListResult>(SESSION_FOLDERS_RPC.list)
    printResult(response, json, formatList)
  },
  'folder create': async (context) => {
    const { flags } = context
    const parent = getOptionalStringFlag(flags, 'parent')
    await mutate(context, {
      kind: 'createFolder',
      name: getRequiredStringFlag(flags, 'name'),
      ...(parent ? { parent } : {}),
      ...(bool(flags, 'saved') ? { saved: true } : {})
    })
  },
  'folder move': async (context) => mutate(context, moveFolderOp(context.flags)),
  'folder rename': async (context) =>
    mutate(context, {
      kind: 'renameFolder',
      folder: getRequiredStringFlag(context.flags, 'folder'),
      name: getRequiredStringFlag(context.flags, 'name')
    }),
  'folder color': async (context) => {
    const color = getOptionalStringFlag(context.flags, 'color')
    if (!color) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Missing required --color. Use one of: ${SESSION_FOLDER_COLOR_NAMES}.`
      )
    }
    await mutate(context, {
      kind: 'colorFolder',
      folder: getRequiredStringFlag(context.flags, 'folder'),
      color: color.toLowerCase() === 'none' ? null : color
    })
  },
  'folder delete': async (context) =>
    // Why no op field for --keep-sessions: the sidebar's one Delete folder already keeps them.
    mutate(context, {
      kind: 'deleteFolder',
      folder: getRequiredStringFlag(context.flags, 'folder')
    }),
  'session move': async (context) => {
    refuseRemote(context.client)
    const target = await resolveSessionTarget(context.client, context.flags)
    await mutate(context, moveSessionOp(context.flags, target))
  },
  'session archive': async (context) => {
    refuseRemote(context.client)
    const target = await tabOrSessionTarget(context, 'archive')
    await mutate(context, {
      kind: 'archiveSession',
      ...target,
      archived: !bool(context.flags, 'unarchive')
    })
  },
  'session delete': async (context) => {
    refuseRemote(context.client)
    const unverified = bool(context.flags, 'unverified')
    if (unverified && !sessionProvenance(context.flags).request) {
      throw new RuntimeClientError(
        'invalid_argument',
        'session delete --unverified needs --request "<the person\'s own words>": only the person decides a session this computer cannot verify may go. Nothing changed.'
      )
    }
    const target = await tabOrSessionTarget(context, 'delete')
    await mutate(context, {
      kind: 'deleteSession',
      ...target,
      ...(bool(context.flags, 'force') ? { force: true } : {}),
      ...(unverified ? { unverified: true } : {})
    })
  }
}
