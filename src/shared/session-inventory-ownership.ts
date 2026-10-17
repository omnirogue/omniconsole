import { parseExecutionHostId } from './execution-host'
import { parseRemoteRuntimePtyId } from './remote-runtime-pty-id'
import { parseWebTerminalSurfaceTabId } from './terminal-surface-id'

/**
 * Who owns a workspace's session inventory, as the caller's catalog resolves it.
 *
 * Why one shared rule: the desktop renderer publication and every runtime
 * inventory path (list, listAll, both subscriptions, headless hydration) must
 * agree on what this runtime may export, or a paired computer's mirror is
 * republished under this computer's identity and echoes back to its owner.
 */
export type SessionInventoryWorkspaceProvenance =
  // Local, folder, direct-SSH and legacy records without connection metadata.
  | { kind: 'owned' }
  // Explicitly owned by a paired runtime: its inventory is that runtime's to publish.
  | { kind: 'peer'; environmentId: string }
  // Conflicting catalog records: only positive per-tab ownership evidence may publish.
  | { kind: 'unresolved' }

export type SessionInventoryTabEvidence = {
  /** The host-side tab id (terminal parent tab id, or unified tab id). */
  tabId?: string | null
  /** The unified tab's recorded execution host, when one was stamped. */
  executionHostId?: string | null
  /** PTY ids bound to the tab: the tab's own plus its layout leaves. */
  ptyIds?: readonly (string | null | undefined)[]
  /** The paired environment an editor or browser row was mirrored from. */
  mirroredFromEnvironmentId?: string | null
}

export type SessionInventoryTabOwnership =
  | { kind: 'owned' }
  | { kind: 'peer'; environmentId: string | null }
  // Quarantined: stays visible on this computer but is never republished as its own.
  | { kind: 'unverified'; reason: 'conflicting-provenance' | 'unresolved-workspace' }

/**
 * Resolve a workspace from every execution host the catalog names for it. A missing host
 * or a nonexistent local path is not foreign evidence: no host at all means local.
 */
export function classifySessionInventoryWorkspaceHosts(
  hostIds: readonly (string | null | undefined)[]
): SessionInventoryWorkspaceProvenance {
  const peers = new Set<string>()
  let owned = false
  for (const hostId of hostIds) {
    const parsed = parseExecutionHostId(hostId)
    if (parsed?.kind === 'runtime') {
      peers.add(parsed.environmentId)
    } else {
      owned = true
    }
  }
  if (peers.size === 0) {
    return { kind: 'owned' }
  }
  if (!owned) {
    // Why: records naming only paired runtimes leave nothing here to publish, whichever one owns it.
    return { kind: 'peer', environmentId: [...peers].sort()[0]! }
  }
  return { kind: 'unresolved' }
}

/**
 * The one input order both sides use: hosts recorded on the workspace itself (worktree or folder
 * records) win; only when none is recorded do the repo records sharing its repo id decide. Only
 * saved catalog records count — never the host a window currently has open.
 */
export type SessionInventoryWorkspaceRecords = {
  workspaceHostIds: readonly (string | null | undefined)[]
  repoHostIds: readonly (string | null | undefined)[]
}

function recordedWorkspaceHostIds(
  records: SessionInventoryWorkspaceRecords
): readonly (string | null | undefined)[] {
  const recorded = records.workspaceHostIds.filter((hostId) => parseExecutionHostId(hostId))
  return recorded.length > 0 ? recorded : records.repoHostIds
}

export function classifySessionInventoryWorkspaceRecords(
  records: SessionInventoryWorkspaceRecords
): SessionInventoryWorkspaceProvenance {
  return classifySessionInventoryWorkspaceHosts(recordedWorkspaceHostIds(records))
}

/** The one paired runtime the saved records credit exclusively, or null (local, mixed, none). */
export function exclusiveRuntimeOwnerOfWorkspaceRecords(
  records: SessionInventoryWorkspaceRecords
): string | null {
  const environments = new Set<string>()
  for (const hostId of recordedWorkspaceHostIds(records)) {
    const parsed = parseExecutionHostId(hostId)
    if (parsed?.kind !== 'runtime') {
      return null
    }
    environments.add(parsed.environmentId)
  }
  return environments.size === 1 ? [...environments][0]! : null
}

/**
 * Classify one tab with per-tab provenance: a unified tab stamped `runtime:*`, a remote-runtime
 * PTY id, a mirrored editor/browser source or a web-terminal mirror id is peer evidence; a local
 * or direct-SSH PTY and a local/SSH execution host are owned evidence. Legacy tabs with no
 * evidence are local (src/shared/repo-types.ts `connectionId`; execution-host.ts fallback).
 */
export function classifySessionInventoryTab(
  workspace: SessionInventoryWorkspaceProvenance,
  evidence: SessionInventoryTabEvidence
): SessionInventoryTabOwnership {
  if (workspace.kind === 'peer') {
    return { kind: 'peer', environmentId: workspace.environmentId }
  }
  const peerEnvironmentIds = new Set<string | null>()
  let ownedEvidence = false
  const host = parseExecutionHostId(evidence.executionHostId)
  if (host?.kind === 'runtime') {
    peerEnvironmentIds.add(host.environmentId)
  } else if (host) {
    ownedEvidence = true
  }
  let hasLocalPty = false
  for (const ptyId of evidence.ptyIds ?? []) {
    if (typeof ptyId !== 'string' || ptyId.length === 0) {
      continue
    }
    const remote = parseRemoteRuntimePtyId(ptyId)
    if (remote) {
      peerEnvironmentIds.add(remote.environmentId)
    } else {
      hasLocalPty = true
    }
  }
  ownedEvidence ||= hasLocalPty
  if (evidence.mirroredFromEnvironmentId?.trim()) {
    peerEnvironmentIds.add(evidence.mirroredFromEnvironmentId.trim())
  }
  const surface = evidence.tabId ? parseWebTerminalSurfaceTabId(evidence.tabId) : null
  // Why: legacy web-prefixed tabs backed by a local PTY are host sessions (PR #1035).
  if (surface && !hasLocalPty) {
    peerEnvironmentIds.add(surface.environmentId)
  }
  if (peerEnvironmentIds.size === 0) {
    return workspace.kind === 'unresolved' && !ownedEvidence
      ? { kind: 'unverified', reason: 'unresolved-workspace' }
      : { kind: 'owned' }
  }
  if (ownedEvidence) {
    return { kind: 'unverified', reason: 'conflicting-provenance' }
  }
  const named = [...peerEnvironmentIds].filter((id): id is string => id !== null)
  return { kind: 'peer', environmentId: named.length === 1 ? named[0]! : null }
}

export function isPublishableSessionInventoryTab(
  workspace: SessionInventoryWorkspaceProvenance,
  evidence: SessionInventoryTabEvidence
): boolean {
  return classifySessionInventoryTab(workspace, evidence).kind === 'owned'
}
