/**
 * The contract for handing work to a new session on another computer (`--host ssh:<id>`). The move
 * is a handoff: a new conversation there starts from the source's brief and its pushed branch; the
 * source conversation itself does not travel. Nothing here provisions, rents or connects a host.
 */

import type { TransferPending, TransferSession } from './session-manage-transfer-contract'

export type SessionTransferHostRequest = {
  /** `ssh:<target-id>`, exactly as `omni host list` names it. */
  hostId: string
  /** A workspace selector on that host; required for folder workspaces. */
  workspace?: string
}

/** A source workspace's git state, read on the computer that runs it (this one). */
export type TransferSourceWork =
  | { kind: 'folder'; path: string | null }
  | {
      kind: 'git'
      path: string | null
      /** Null on a detached HEAD or when git could not be read. */
      branch: string | null
      head: string | null
      /** `none`: the branch was never pushed; `unknown`: that could not be read. */
      upstream: { name: string; ahead: number } | 'none' | 'unknown'
      uncommitted: number
    }

export type HostMoveWorkspace = {
  id: string
  path: string
  /** The branch it has checked out now; null for a folder workspace. */
  branch: string | null
  name: string
}

export type HostMovePlan = {
  hostId: `ssh:${string}`
  label: string
  workspace: HostMoveWorkspace
  /** Aligned with the transfer's sources. */
  works: TransferSourceWork[]
}

/** Everything a move reads on, or starts on, another computer; nothing here provisions or rents. */
export type SessionTransferHostDeps = {
  /** Read-only: the host, the workspace the work continues in and each source's git state. */
  plan(sources: TransferSession[], request: SessionTransferHostRequest): Promise<HostMovePlan>
  readWork(source: TransferSession): Promise<TransferSourceWork>
  /** Starts the target there through the existing agent launch, the prompt as its first turn. */
  launch(
    plan: HostMovePlan,
    source: TransferSession,
    title: string,
    prompt: string
  ): Promise<{ target: TransferSession; pending: TransferPending }>
  /** Whether that computer is connected now; lost contact is `unverifiable`, never an exit. */
  reachable(hostId: string): boolean
  /** Its name for people, or null when this computer has no such host. */
  label(hostId: string): string | null
}
