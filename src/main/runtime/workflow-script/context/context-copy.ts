import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { workflowContextSkippedName } from './context-exclusions'

export const WORKFLOW_CONTEXT_MAX_BYTES = 2 * 1024 ** 3
export const WORKFLOW_CONTEXT_MAX_FILES = 250_000
const PARALLEL_COPIES = 16

/** What one run's context folder may hold, all sources together. */
export class WorkflowContextBudget {
  bytes = 0
  files = 0

  constructor(
    readonly maxBytes = WORKFLOW_CONTEXT_MAX_BYTES,
    readonly maxFiles = WORKFLOW_CONTEXT_MAX_FILES
  ) {}

  take(size: number): void {
    this.bytes += size
    this.files += 1
    if (this.bytes > this.maxBytes) {
      throw new Error(
        `The chosen files, folders and repos are larger than ${Math.round(this.maxBytes / 1024 ** 3)} GB together. Choose smaller folders or specific files.`
      )
    }
    if (this.files > this.maxFiles) {
      throw new Error(
        `The chosen files, folders and repos hold more than ${this.maxFiles.toLocaleString('en-US')} files together. Choose smaller folders or specific files.`
      )
    }
  }
}

/**
 * Copies a file or folder into `target`, cloning on APFS and Btrfs (COPYFILE_FICLONE falls back
 * to a byte copy elsewhere). Links are never copied or followed, so nothing outside the chosen
 * folder can be reached through the copy; credential names, node_modules and .git are left out.
 */
export async function copyWorkflowContextTree(
  source: string,
  target: string,
  budget: WorkflowContextBudget,
  signal?: AbortSignal
): Promise<void> {
  const queue: [string, string][] = [[source, target]]
  let failure: unknown
  const copyOne = async ([from, to]: [string, string]) => {
    const info = await lstat(from)
    if (info.isFile()) {
      budget.take(info.size)
      await copyFile(from, to, constants.COPYFILE_FICLONE)
    } else if (info.isDirectory()) {
      await mkdir(to, { recursive: true })
      for (const entry of await readdir(from, { withFileTypes: true })) {
        if ((entry.isFile() || entry.isDirectory()) && !workflowContextSkippedName(entry.name)) {
          queue.push([join(from, entry.name), join(to, entry.name)])
        }
      }
    }
  }
  // A directory's entries are queued only after it exists, so workers never race its mkdir.
  const worker = async () => {
    while (!failure && queue.length) {
      if (signal?.aborted) {
        failure = new Error('Copying the chosen files was cancelled.')
        return
      }
      try {
        await copyOne(queue.pop()!)
      } catch (error) {
        failure ??= error
      }
    }
  }
  while (!failure && queue.length) {
    await Promise.all(Array.from({ length: Math.min(PARALLEL_COPIES, queue.length) }, worker))
  }
  if (failure) {
    throw failure
  }
}
