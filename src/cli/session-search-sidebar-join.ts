/**
 * `omni session search` hits joined to this controller's sidebar, the way the sidebar's own search
 * joins them: each hit gets its `--ref`, and every row holding that conversation (archived ones
 * included). No row means its tab was closed; `omni session resume --ref` reopens it.
 */

import {
  SESSION_MANAGE_RPC,
  type SessionManageEntry,
  type SessionManageListResult
} from '../shared/session-manage-types'
import { sessionManageHostKey } from '../shared/session-manage-query'
import { formatSessionReference, rowsForSessionReference } from '../shared/session-reference'
import type {
  SessionSearchHit,
  SessionSearchHitRow,
  SessionSearchResult
} from '../shared/session-search-types'
import type { RuntimeClient } from './runtime-client'

const LIST_TIMEOUT_MS = 60_000

export function sessionSearchHitRef(hit: SessionSearchHit): string | null {
  const hostId = sessionManageHostKey(hit.executionHostId)
  return hostId
    ? formatSessionReference({ agent: hit.agent, sessionId: hit.sessionId, hostId })
    : null
}

function hitRow(entry: SessionManageEntry): SessionSearchHitRow {
  return {
    paneKey: entry.paneKey,
    tabId: entry.tabId,
    title: entry.title,
    state: entry.state,
    verdict: entry.verdict,
    archived: entry.archived,
    ...(entry.archiveKind !== undefined ? { archiveKind: entry.archiveKind } : {}),
    folder: entry.folder
  }
}

/** Joins hits to the listed rows; `sessions: null` (no list) leaves each hit's rows unknown. */
export function joinSessionSearchSidebar(
  result: SessionSearchResult,
  sessions: readonly SessionManageEntry[] | null,
  unavailable?: string
): SessionSearchResult {
  // Why: an older controller lists rows without provider ids, so "no row" would be a guess.
  const reportsIds = sessions?.every((entry) => 'providerSessionId' in entry) ?? false
  const joinable = sessions !== null && reportsIds
  const hits = result.hits.map((hit) => {
    const ref = sessionSearchHitRef(hit)
    const hostId = sessionManageHostKey(hit.executionHostId)
    return {
      ...hit,
      ...(ref ? { ref } : {}),
      ...(joinable && hostId
        ? {
            sidebar: rowsForSessionReference(
              { sessionId: hit.sessionId, hostId, transcriptPath: hit.transcriptPath },
              sessions
            ).map(hitRow)
          }
        : {})
    }
  })
  return {
    ...result,
    hits,
    sidebarJoin: joinable
      ? { state: 'joined' }
      : {
          state: 'unavailable',
          reason:
            unavailable ??
            'This OmniConsole lists sessions without their provider conversation, so hits could not be matched to sidebar rows. Update it.'
        }
  }
}

/** Reads the sidebar (archived rows included) only when there is a hit to join; local CLI only. */
export async function withSessionSearchSidebar(
  client: RuntimeClient,
  result: SessionSearchResult
): Promise<SessionSearchResult> {
  if (result.hits.length === 0) {
    return result
  }
  if (client.isRemote) {
    return joinSessionSearchSidebar(
      result,
      null,
      'Sidebar rows are joined only by the omni CLI on the computer running OmniConsole.'
    )
  }
  try {
    const listed = await client.call<SessionManageListResult>(
      SESSION_MANAGE_RPC.list,
      { includeArchived: true },
      { timeoutMs: LIST_TIMEOUT_MS }
    )
    const sessions = Array.isArray(listed.result?.sessions) ? listed.result.sessions : null
    return joinSessionSearchSidebar(result, sessions)
  } catch (error) {
    return joinSessionSearchSidebar(
      result,
      null,
      `The sidebar could not be read (${error instanceof Error ? error.message : String(error)}), so each hit's row is unknown.`
    )
  }
}
