/**
 * `omni session history|actions` — the readers an agent uses to see what was already done to a
 * session, and by whom, before it moves or renames anything.
 */

import { SESSION_FOLDERS_RPC, type SessionFolderListResult } from '../../shared/session-folder-cli'
import { SESSION_ORGANIZATION_RPC } from '../../shared/session-organization-change'
import {
  parseSinceDuration,
  SESSION_ACTION_ACTOR_FILTERS,
  SESSION_ORGANIZATION_ACTIONS_RPC,
  type OrganizationActionsResult,
  type OrganizationSessionHistory
} from '../../shared/session-organization-readers'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { getOptionalPositiveIntegerFlag, getOptionalStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'
import {
  formatSessionActions,
  formatSessionHistory,
  type FolderNames
} from '../session-history-format'
import { resolveSessionTarget } from './session-folder-target'
import { refuseRemote } from './session-manage-access'

const DEFAULT_SINCE_MS = 24 * 60 * 60 * 1000

/** Best effort: without the window, moves show folder ids instead of paths. */
async function folderNames(client: RuntimeClient): Promise<FolderNames> {
  try {
    const response = await client.call<SessionFolderListResult>(SESSION_FOLDERS_RPC.list)
    return new Map(response.result.folders.map((folder) => [folder.id, folder.path]))
  } catch {
    return new Map()
  }
}

function listFlag(flags: HandlerContext['flags'], name: string): string[] | undefined {
  const raw = getOptionalStringFlag(flags, name)
  if (raw === undefined) {
    return undefined
  }
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (values.length === 0) {
    throw new RuntimeClientError('invalid_argument', `--${name} needs at least one value.`)
  }
  return values
}

export function parseActionsFlags(
  flags: HandlerContext['flags'],
  now: number = Date.now()
): { since: number; actors?: string[]; kinds?: string[]; limit?: number } {
  const sinceRaw = getOptionalStringFlag(flags, 'since')
  const window = sinceRaw === undefined ? DEFAULT_SINCE_MS : parseSinceDuration(sinceRaw)
  if (window === null) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--since takes a duration such as 30m, 24h or 7d.'
    )
  }
  const actors = listFlag(flags, 'actor')
  const unknown = actors?.filter(
    (actor) => !(SESSION_ACTION_ACTOR_FILTERS as readonly string[]).includes(actor)
  )
  if (unknown?.length) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Unknown --actor ${unknown.join(', ')}. Use ${SESSION_ACTION_ACTOR_FILTERS.join(', ')}.`
    )
  }
  const kinds = listFlag(flags, 'kind')
  const limit = getOptionalPositiveIntegerFlag(flags, 'limit')
  return {
    since: Math.max(0, Math.floor(now - window)),
    ...(actors ? { actors } : {}),
    ...(kinds ? { kinds } : {}),
    ...(limit ? { limit: Math.min(limit, 2000) } : {})
  }
}

export const SESSION_HISTORY_HANDLERS: Record<string, CommandHandler> = {
  'session history': async ({ client, flags, json }) => {
    refuseRemote(client)
    const target = await resolveSessionTarget(client, flags)
    const response = await client.call<OrganizationSessionHistory>(
      SESSION_ORGANIZATION_RPC.history,
      { target }
    )
    const folders = json ? new Map<string, string>() : await folderNames(client)
    printResult(response, json, (history) => formatSessionHistory(history, folders))
  },
  'session actions': async ({ client, flags, json }) => {
    refuseRemote(client)
    const response = await client.call<OrganizationActionsResult>(
      SESSION_ORGANIZATION_ACTIONS_RPC,
      parseActionsFlags(flags)
    )
    const folders = json ? new Map<string, string>() : await folderNames(client)
    printResult(response, json, (result) => formatSessionActions(result, folders))
  }
}
