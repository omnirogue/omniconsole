/**
 * `omni session show`: asks the window to pull a sidebar conversation into view. Reading nothing
 * and moving nothing for a paired device or another computer: only the local CLI may drive the
 * host window, the same line `terminal.focus` draws with its navigation target.
 */

import {
  navigationTargetsHost,
  resolveRuntimeNavigationTarget
} from '../../shared/runtime-navigation'
import type {
  SessionManageRendererRequest,
  SessionManageSidebarRow
} from '../../shared/session-manage-relay'
import {
  isSessionShowReply,
  type SessionShowMode,
  type SessionShowPlacement,
  type SessionShowResult
} from '../../shared/session-show'
import type { RpcContext } from '../runtime/rpc/core'
import { describeMissingTarget, findSessionManageRow } from './session-manage-inventory'
import type { BackgroundRuntimeTerminal } from './session-manage-background-terminals'

export const SESSION_SHOW_REMOTE_SUMMARY =
  'Not shown: only the omni CLI on the computer running OmniConsole moves its window; a paired device or another computer keeps its own view.'
export const SESSION_SHOW_OLD_WINDOW_SUMMARY =
  'Not shown: this OmniConsole window cannot show sessions side by side yet. Update the app and try again.'

export type SessionShowDeps = {
  readRows: () => Promise<SessionManageSidebarRow[]>
  relay: (
    request: Extract<SessionManageRendererRequest, { kind: 'showSession' }>
  ) => Promise<unknown>
  /** A runtime-owned terminal no window tab shows, named by the same target. */
  findBackground?: (target: {
    paneKey?: string
    tabId?: string
  }) => BackgroundRuntimeTerminal | null
  /** Opens that terminal visibly in the window (adopts it); `navigated` when the window did. */
  adoptBackground?: (handle: string) => Promise<{ tabId: string | null; navigated: boolean }>
}

export type SessionShowInput = {
  target: { paneKey?: string; tabId?: string }
  mode: SessionShowMode
  flash: boolean
  drivesHostWindow: boolean
}

/** Local, in-process callers only: a paired client's show stays on the caller's own view. */
export function callerDrivesHostWindow(
  context: Pick<RpcContext, 'clientKind' | 'clientId' | 'pairedDeviceId'>
): boolean {
  if (context.pairedDeviceId || context.clientId) {
    return false
  }
  return navigationTargetsHost(resolveRuntimeNavigationTarget({ clientKind: context.clientKind }))
}

function placementSummary(placement: SessionShowPlacement, title: string): string {
  switch (placement) {
    case 'split':
      return `Showing “${title}” on the right, split beside the current view.`
    case 'grid':
      return `Showing “${title}” in the Grid, on the right of the current view.`
    case 'grid-replaced':
      return `The Grid was full: “${title}” took the place of its least recently used pane.`
    case 'already-shown':
      return `“${title}” is already on screen; it is highlighted.`
    case 'replaced':
      return `Showing “${title}” in place of the current view.`
  }
}

export async function showSession(
  deps: SessionShowDeps,
  input: SessionShowInput
): Promise<SessionShowResult> {
  const { mode } = input
  const refused = {
    shown: false,
    mode,
    placement: null,
    keptKeyboardFocus: false
  } as const
  if (!input.drivesHostWindow) {
    return { ...refused, target: null, summary: SESSION_SHOW_REMOTE_SUMMARY }
  }
  const row = findSessionManageRow(await deps.readRows(), input.target)
  if (!row) {
    const background = deps.findBackground?.(input.target)
    if (background && deps.adoptBackground) {
      return adoptBackgroundSession(deps.adoptBackground, input, background)
    }
    throw new Error(describeMissingTarget(input.target))
  }
  const target = {
    paneKey: row.paneKey,
    tabId: row.tabId,
    title: row.title,
    worktreeId: row.worktreeId
  }
  const reply = await deps.relay({
    kind: 'showSession',
    ...(row.paneKey ? { paneKey: row.paneKey } : {}),
    ...(row.tabId ? { tabId: row.tabId } : {}),
    mode,
    flash: input.flash
  })
  if (!isSessionShowReply(reply)) {
    return { ...refused, target, summary: SESSION_SHOW_OLD_WINDOW_SUMMARY }
  }
  const summary = placementSummary(reply.placement, row.title)
  return {
    shown: true,
    mode,
    placement: reply.placement,
    keptKeyboardFocus: reply.keptKeyboardFocus,
    target,
    summary: reply.keptKeyboardFocus
      ? `${summary} Keyboard focus stayed where you were typing.`
      : summary
  }
}

/** Adopts a terminal that runs in the background, not in a window, into the window visibly. */
async function adoptBackgroundSession(
  adopt: NonNullable<SessionShowDeps['adoptBackground']>,
  input: SessionShowInput,
  background: BackgroundRuntimeTerminal
): Promise<SessionShowResult> {
  const title = background.title?.trim() || 'Terminal'
  const adopted = await adopt(background.handle)
  return {
    shown: adopted.navigated,
    mode: input.mode,
    placement: null,
    keptKeyboardFocus: false,
    target: {
      paneKey: background.paneKey,
      tabId: adopted.tabId ?? background.tabId,
      title,
      worktreeId: background.worktreeId
    },
    summary: adopted.navigated
      ? `Opened “${title}” in the window; it was running in the background, not in a window.`
      : `“${title}” still runs in the background, not in a window: the window could not open it.`
  }
}
