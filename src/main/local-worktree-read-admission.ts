import { resolve } from 'node:path'
import {
  areWorktreeMetadataProbesExhausted,
  probeWorktreeMetadata
} from './git/worktree-metadata-service'

export const WORKTREE_STORAGE_UNAVAILABLE_MESSAGE =
  'Workspace storage is unavailable. Check folder access or reconnect the drive, then retry.'
export const WORKTREE_STORAGE_HELPER_EXHAUSTED_MESSAGE =
  'Workspace storage checks could not finish. Check folder access, then restart OmniConsole.'

export class WorktreeStorageUnavailableError extends Error {
  constructor(exhausted: boolean) {
    super(
      exhausted ? WORKTREE_STORAGE_HELPER_EXHAUSTED_MESSAGE : WORKTREE_STORAGE_UNAVAILABLE_MESSAGE
    )
    this.name = 'WorktreeStorageUnavailableError'
  }
}

export async function assertLocalWorktreeReadable(
  worktreePath: string,
  signal?: AbortSignal
): Promise<void> {
  const root = resolve(worktreePath)
  const result = (await probeWorktreeMetadata('readable', [root], signal)).get(root)
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
  }
  if (result?.operation !== 'readable' || result.value !== true) {
    throw new WorktreeStorageUnavailableError(areWorktreeMetadataProbesExhausted())
  }
}
