import type { RuntimeTerminalShow } from '../../shared/runtime-types'
import { SESSION_MANAGE_RPC, type SessionManageListResult } from '../../shared/session-manage-types'
import {
  sessionWorkflowAnchorRef,
  type SessionWorkflowAnchorRef
} from '../../shared/session-workflow-anchor'
import { isTerminalLeafId } from '../../shared/stable-pane-id'
import type { HandlerContext } from '../dispatch'
import { getOptionalStringFlag } from '../flags'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'
import { resolveSessionRefTarget } from './session-ref-target'

/** The conversation an `omni session …` command acts on, as the sidebar finds it. */
export type SessionTarget =
  | { paneKey: string }
  | { paneKey?: string; tabId: string; workflow?: SessionWorkflowAnchorRef }

const LIST_TIMEOUT_MS = 60_000

/**
 * `--tab-id <tabId>`: a row with no pane. A workflow conversation (Council, Discover, Evolve,
 * Build + Review) is sent with its controller and run, so the window acts on exactly that anchor.
 */
export async function resolveTabTarget(
  client: RuntimeClient,
  tabId: string
): Promise<{ tabId: string; workflow?: SessionWorkflowAnchorRef }> {
  const listed = await client.call<SessionManageListResult>(
    SESSION_MANAGE_RPC.list,
    { includeArchived: true },
    { timeoutMs: LIST_TIMEOUT_MS }
  )
  const anchor = listed.result.sessions.find(
    (entry) => entry.tabId === tabId && entry.paneKey === null && entry.workflow
  )
  const workflow = sessionWorkflowAnchorRef(anchor?.workflow)
  return workflow ? { tabId, workflow } : { tabId }
}

/**
 * `--terminal <handle>` (a handle from `terminal list`/`terminal create`), `--pane <paneKey>`,
 * `--ref <ref>` (from `session search` or `session list`), or — by default — the pane the command
 * runs in (ORCA_PANE_KEY).
 */
export async function resolveSessionTarget(
  client: RuntimeClient,
  flags: HandlerContext['flags']
): Promise<SessionTarget> {
  const terminal = getOptionalStringFlag(flags, 'terminal')
  const pane = getOptionalStringFlag(flags, 'pane')
  const ref = getOptionalStringFlag(flags, 'ref')
  if (terminal !== undefined && pane !== undefined) {
    throw new RuntimeClientError('invalid_argument', 'Pass --terminal or --pane, not both.')
  }
  if (ref !== undefined && (terminal !== undefined || pane !== undefined)) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Pass --ref alone, not with --terminal or --pane.'
    )
  }
  if (ref !== undefined) {
    return resolveSessionRefTarget(client, ref)
  }
  if (terminal !== undefined) {
    const response = await client.call<{ terminal: RuntimeTerminalShow }>('terminal.show', {
      terminal
    })
    const { tabId, leafId } = response.result.terminal
    // Why both: the pane key names the exact split and its tab must agree; never another split.
    return !tabId.includes(':') && isTerminalLeafId(leafId)
      ? { paneKey: `${tabId}:${leafId}`, tabId }
      : { tabId }
  }
  const paneKey = pane ?? process.env.ORCA_PANE_KEY?.trim()
  if (!paneKey) {
    throw new RuntimeClientError(
      'invalid_argument',
      'This is not running inside an OmniConsole terminal pane (ORCA_PANE_KEY is not set). Pass --terminal <handle> or --pane <paneKey> to name the session.'
    )
  }
  return { paneKey }
}
