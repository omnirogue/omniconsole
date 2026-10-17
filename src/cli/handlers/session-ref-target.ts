import { SESSION_MANAGE_RPC, type SessionManageListResult } from '../../shared/session-manage-types'
import { parseSessionReference, rowsForSessionReference } from '../../shared/session-reference'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'

const LIST_TIMEOUT_MS = 60_000

/**
 * The one sidebar pane holding a `--ref` conversation, archived rows included. Resolved at the
 * moment of acting; the command then re-checks that pane like any `--pane`.
 */
export async function resolveSessionRefTarget(
  client: RuntimeClient,
  value: string
): Promise<{ paneKey: string }> {
  const reference = parseSessionReference(value)
  if (!reference) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--ref ${value} is not a session reference. Use the ref omni session search or omni session list prints: <claude|codex>:<id>@<host>.`
    )
  }
  const listed = await client.call<SessionManageListResult>(
    SESSION_MANAGE_RPC.list,
    { includeArchived: true },
    { timeoutMs: LIST_TIMEOUT_MS }
  )
  const sessions = listed.result.sessions
  if (sessions.length > 0 && !sessions.some((entry) => 'providerSessionId' in entry)) {
    throw new RuntimeClientError(
      'unsupported',
      'This OmniConsole lists sessions without their provider conversation, so --ref cannot be matched. Update it, or use --pane from omni session list.'
    )
  }
  const panes = rowsForSessionReference(reference, sessions).filter(
    (entry): entry is typeof entry & { paneKey: string } => entry.paneKey !== null
  )
  if (panes.length === 0) {
    throw new RuntimeClientError(
      'not_found',
      `No sidebar row holds ${value}: its tab was closed. Reopen it first with omni session resume --ref ${value}.`
    )
  }
  if (panes.length > 1) {
    throw new RuntimeClientError(
      'invalid_argument',
      `${value} is open in ${panes.length} panes (${panes.map((entry) => entry.paneKey).join(', ')}); name one with --pane.`
    )
  }
  return { paneKey: panes[0]!.paneKey }
}
