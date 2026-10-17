import type { BigIntStats } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'

export type LocalWorkflowWorkspaceRoot = NonNullable<
  LocalWorkflowHostSnapshot['host']['workspaceRoot']
>

/** Freezes the canonical workspace folder agents may read (same identity rule as output roots). */
export async function freezeWorkflowWorkspaceRoot(
  path: string
): Promise<LocalWorkflowWorkspaceRoot> {
  const canonical = await realpath(path)
  const directory = await lstat(canonical, { bigint: true })
  if (!directory.isDirectory()) {
    throw new Error('The workspace folder is not a directory.')
  }
  return { path: canonical, device: String(directory.dev), inode: String(directory.ino) }
}

/**
 * Before every workspace-read launch: the folder agents read must still be the one admitted.
 * A moved, replaced or retargeted folder refuses the launch instead of reading something else.
 */
export async function assertWorkflowWorkspaceRoot(
  snapshot: Pick<LocalWorkflowHostSnapshot, 'host'>
): Promise<string> {
  const root = snapshot.host.workspaceRoot
  if (!root) {
    throw new Error('This workflow has no workspace folder to read.')
  }
  return assertFrozenWorkspaceFolder(root)
}

/** The frozen folder's canonical path, while it is still the same folder it was when frozen. */
export async function assertFrozenWorkspaceFolder(
  root: LocalWorkflowWorkspaceRoot
): Promise<string> {
  let directory: BigIntStats
  let canonical: string
  try {
    directory = await lstat(root.path, { bigint: true })
    canonical = await realpath(root.path)
  } catch {
    throw new Error(`The workspace folder ${root.path} is missing.`)
  }
  if (
    !directory.isDirectory() ||
    canonical !== root.path ||
    String(directory.dev) !== root.device ||
    String(directory.ino) !== root.inode
  ) {
    throw new Error(
      `The workspace folder ${root.path} was moved or replaced since the workflow started.`
    )
  }
  return root.path
}
