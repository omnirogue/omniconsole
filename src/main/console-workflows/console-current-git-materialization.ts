import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { gitExecFileAsync } from '../git/runner'
import { readConsoleFolderSelectedFile } from './console-folder-selected-file'
import type { ConsoleLocalJob } from './console-local-execution-contract'
import {
  assertConsoleGitSnapshotIsolated,
  consoleCurrentGitSource
} from './console-current-git-source'
import {
  assertConsoleFolderHydrationUnchanged,
  assertSafeParents
} from './console-folder-hydration-guard'

/** This baseline is disposable only while the isolated worktree still equals the captured HEAD. */
export async function consoleCurrentGitHydrationSources(job: ConsoleLocalJob, cwd: string) {
  const current = consoleCurrentGitSource(job)
  if (!current) {
    throw new Error('The Git snapshot has no frozen current source.')
  }
  assertConsoleGitSnapshotIsolated(job, cwd)
  const [head, status] = await Promise.all([
    gitExecFileAsync(['rev-parse', '--verify', 'HEAD'], { cwd }),
    gitExecFileAsync(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd })
  ])
  if (head.stdout.trim() !== current.git.head_sha || status.stdout) {
    throw new Error('The isolated Git snapshot worktree changed before input materialization.')
  }
  return Promise.all(
    current.paths.map(async (target_path) => {
      try {
        const file = await readConsoleFolderSelectedFile(cwd, target_path)
        return {
          target_path,
          mode: file.mode,
          file: { sha256: createHash('sha256').update(file.content).digest('hex') }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
        return { target_path, mode: 0o644, file: { sha256: null } }
      }
    })
  )
}

export async function materializeConsoleCurrentGitSource(
  job: ConsoleLocalJob,
  cwd: string,
  preparedInputPaths: string[]
): Promise<void> {
  const current = consoleCurrentGitSource(job)
  if (!current || current.requiresCandidate) {
    throw new Error('Only an initial Git round can apply the original captured files.')
  }
  const saved = new Map<string, Buffer>()
  for (const path of preparedInputPaths) {
    const bytes = await readFile(path)
    saved.set(createHash('sha256').update(bytes).digest('hex'), bytes)
  }
  const files = current.source.files.map((file) => {
    const bytes = saved.get(file.file.sha256)
    if (!bytes || bytes.length !== file.file.size_bytes) {
      throw new Error('The captured Git input bytes are unavailable or changed after download.')
    }
    return { path: file.target_path, bytes }
  })
  const sources = await consoleCurrentGitHydrationSources(job, cwd)
  for (const source of sources) {
    await assertSafeParents(cwd, source.target_path)
  }
  for (const source of sources) {
    await assertConsoleFolderHydrationUnchanged(cwd, source.target_path, source.file.sha256)
    await assertSafeParents(cwd, source.target_path)
    await rm(resolve(cwd, source.target_path), { force: true })
  }
  for (const file of files) {
    const path = resolve(cwd, file.path)
    await assertSafeParents(cwd, file.path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, file.bytes, {
      flag: 'wx',
      mode: sources.find((source) => source.target_path === file.path)!.mode
    })
  }
}
