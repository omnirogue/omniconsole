import { parseRemoteRuntimePtyId } from './remote-runtime-pty-id'

export const WEB_TERMINAL_SURFACE_TAB_PREFIX = 'web-terminal-'
export const HOST_TERMINAL_SURFACE_SEPARATOR = '::'

export function toWebTerminalSurfaceTabId(hostSurfaceId: string): string {
  // Why: host session surface ids use `tab::leaf`, but renderer pane keys
  // reserve `:` as the tab/leaf delimiter. Keep host identity while making a
  // local tab id that can safely flow through makePaneKey().
  return `${WEB_TERMINAL_SURFACE_TAB_PREFIX}${encodeURIComponent(hostSurfaceId)}`
}

// Why: encodeURIComponent always escapes '@', so a literal '@@' can only be this
// client-local owner separator — never part of a legacy encoded host id.
const OWNER_QUALIFIED_SURFACE_SEPARATOR = '@@'

/** Client-local id for a paired environment's surface whose host id collides with
 *  another owner's mirror; RPCs still receive the original host id. */
export function toOwnerQualifiedWebTerminalSurfaceTabId(
  environmentId: string,
  hostSurfaceId: string
): string {
  return `${WEB_TERMINAL_SURFACE_TAB_PREFIX}${encodeURIComponent(environmentId)}${OWNER_QUALIFIED_SURFACE_SEPARATOR}${encodeURIComponent(hostSurfaceId)}`
}

export function parseWebTerminalSurfaceTabId(
  tabId: string
): { environmentId: string | null; hostTabId: string } | null {
  if (!tabId.startsWith(WEB_TERMINAL_SURFACE_TAB_PREFIX)) {
    return null
  }
  const rest = tabId.slice(WEB_TERMINAL_SURFACE_TAB_PREFIX.length)
  const separatorIndex = rest.indexOf(OWNER_QUALIFIED_SURFACE_SEPARATOR)
  try {
    return separatorIndex === -1
      ? { environmentId: null, hostTabId: decodeURIComponent(rest) }
      : {
          environmentId: decodeURIComponent(rest.slice(0, separatorIndex)) || null,
          hostTabId: decodeURIComponent(
            rest.slice(separatorIndex + OWNER_QUALIFIED_SURFACE_SEPARATOR.length)
          )
        }
  } catch {
    return null
  }
}

export function toHostSessionTabId(tabId: string): string {
  return parseWebTerminalSurfaceTabId(tabId)?.hostTabId ?? tabId
}

/** True when `tabId` is exactly the client mirror id for `environmentId`'s host tab. */
export function isCanonicalWebTerminalSurfaceTabId(
  tabId: string,
  hostTabId: string,
  environmentId: string
): boolean {
  return (
    tabId === toWebTerminalSurfaceTabId(hostTabId) ||
    tabId === toOwnerQualifiedWebTerminalSurfaceTabId(environmentId, hostTabId)
  )
}

export function isWebTerminalSurfaceTabId(tabId: string): boolean {
  return tabId.startsWith(WEB_TERMINAL_SURFACE_TAB_PREFIX)
}

export function isWebOnlyMirroredTerminalTab(
  tab: { id: string; ptyId?: string | null },
  layout?: { ptyIdsByLeafId?: Record<string, string> }
): boolean {
  if (!isWebTerminalSurfaceTabId(tab.id)) {
    return false
  }
  const ptyIds = [tab.ptyId, ...Object.values(layout?.ptyIdsByLeafId ?? {})].filter(
    (ptyId): ptyId is string => typeof ptyId === 'string' && ptyId.length > 0
  )
  // Legacy web-prefixed tabs with a local PTY are host sessions, not peer mirrors.
  return ptyIds.every((ptyId) => parseRemoteRuntimePtyId(ptyId) !== null)
}
