import type { ArtifactWriteRequest } from '../../shared/artifacts'
import {
  type ArtifactSessionOrigin,
  type ArtifactWriteOrigin,
  sanitizeArtifactSessionOrigin
} from '../../shared/artifact-session'
import { parsePaneKey } from '../../shared/stable-pane-id'

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

/** The stored form of a request's origin, if it carries one. */
export function artifactSessionOriginOf(
  request: Pick<ArtifactWriteRequest, 'origin'>
): ArtifactSessionOrigin | undefined {
  return sanitizeArtifactSessionOrigin(request.origin) ?? undefined
}
