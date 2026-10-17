import { resolve } from 'node:path'
import type { Store } from '../persistence'
import { assertLocalWorktreeReadable } from '../local-worktree-read-admission'
import { resolveAuthorizedPath } from './filesystem-auth'
import {
  ensureAuthorizedRootsCache,
  findRegisteredWorktreeRoot,
  resolveRegisteredWorktreePath
} from './registered-worktree-roots-cache'

export async function assertRegisteredWorktreeReadable(
  targetPath: string,
  store: Store,
  signal?: AbortSignal
): Promise<void> {
  await ensureAuthorizedRootsCache(store)
  const root = findRegisteredWorktreeRoot(resolve(targetPath))
  if (root) {
    await assertLocalWorktreeReadable(root, signal)
  }
}

export async function resolveAuthorizedReadPath(targetPath: string, store: Store): Promise<string> {
  await assertRegisteredWorktreeReadable(targetPath, store)
  return resolveAuthorizedPath(targetPath, store)
}

export async function resolveRegisteredWorktreeReadPath(
  targetPath: string,
  store: Store,
  signal?: AbortSignal
): Promise<string> {
  // Exact registered roots need no I/O; the Git read owns their single admission.
  return resolveRegisteredWorktreePath(targetPath, store, () =>
    assertRegisteredWorktreeReadable(targetPath, store, signal)
  )
}
