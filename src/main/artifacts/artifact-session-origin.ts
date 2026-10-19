import type { ArtifactWriteRequest } from '../../shared/artifacts'
import {
  type ArtifactSessionOrigin,
  type ArtifactWriteOrigin,
  sanitizeArtifactSessionOrigin
} from '../../shared/artifact-session'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { ledgerIdentityForPane } from '../session-ledger/ledger-lookup'

/** The slice of the runtime that knows which pane and workspace a terminal handle belongs to. */
export type ArtifactTerminalIdentitySource = {
  getTerminalPaneKey: (handle: string) => string | null
  getTerminalWorktreeIdForPaneKey: (paneKey: string) => string | null
}

function safeLookup(lookup: () => string | null): string | null {
  try {
    return lookup()
  } catch {
    // Why: an unknown or retired handle must never fail the publish itself.
    return null
  }
}

/**
 * Resolve the session an artifact was published from. The handle is the identity the IDE owns,
 * so what it resolves to wins; the env-reported pane key and workspace id are the fallback for a
 * terminal the runtime no longer tracks. Returns null when nothing identifies a session.
 */
export function resolveArtifactSessionOrigin(
  runtime: ArtifactTerminalIdentitySource,
  origin: ArtifactWriteOrigin | undefined
): ArtifactSessionOrigin | null {
  if (!origin) {
    return null
  }
  const handle = origin.terminalHandle
  const handlePaneKey = handle ? safeLookup(() => runtime.getTerminalPaneKey(handle)) : null
  const reportedPaneKey = origin.paneKey && parsePaneKey(origin.paneKey) ? origin.paneKey : null
  const paneKey = handlePaneKey ?? reportedPaneKey
  const paneWorktreeId = paneKey
    ? safeLookup(() => runtime.getTerminalWorktreeIdForPaneKey(paneKey))
    : null
  return sanitizeArtifactSessionOrigin({
    paneKey: paneKey ?? undefined,
    worktreeId: paneWorktreeId ?? origin.worktreeId
  })
}

/** The request the artifact service sees: the handle is consumed here and never stored. */
export function withResolvedArtifactOrigin<T extends ArtifactWriteRequest>(
  runtime: ArtifactTerminalIdentitySource,
  request: T
): T {
  const { origin, ...rest } = request
  const resolved = resolveArtifactSessionOrigin(runtime, origin)
  return (resolved ? { ...rest, origin: resolved } : rest) as T
}

type PinnedRequest = Pick<ArtifactWriteRequest, 'origin' | 'verifiedSession'>

/** The terminal now runs another conversation than the one verified for this write. */
export function artifactSessionSwitched(request: PinnedRequest): boolean {
  const paneKey = sanitizeArtifactSessionOrigin(request.origin)?.paneKey
  const pin = request.verifiedSession
  if (!paneKey || !pin) {
    return false
  }
  const now = ledgerIdentityForPane(paneKey)
  return (
    (pin.ledgerId !== undefined && pin.ledgerId !== now.ledgerId) ||
    (pin.nativeSessionId !== undefined && pin.nativeSessionId !== now.nativeSessionId)
  )
}

/**
 * The stored form of a request's origin, if it carries one. Read when each piece is published, so
 * a conversation that replaced the verified one meanwhile never inherits the page.
 */
export function artifactSessionOriginOf(request: PinnedRequest): ArtifactSessionOrigin | undefined {
  const origin = sanitizeArtifactSessionOrigin(request.origin) ?? undefined
  return origin && artifactSessionSwitched(request) ? undefined : origin
}

/** What an update stores: null clears a terminal whose command was refused, undefined keeps it. */
export function artifactUpdateOriginOf(
  request: PinnedRequest & Pick<ArtifactWriteRequest, 'unboundReason'>
): ArtifactSessionOrigin | null | undefined {
  return request.unboundReason || artifactSessionSwitched(request)
    ? null
    : artifactSessionOriginOf(request)
}
