import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { HANDOFF_FILE_MAX_BYTES } from '../../shared/console-handoff-contract'
import { readExactHandoffFile } from '../../shared/exact-handoff-file-read'
import { isSafeRelativePath } from '../../shared/handoff-manifest'
import { iterateNulDelimitedFields } from '../../shared/nul-delimited-fields'
import { gitOptionsForWorktree, type GitRuntimeOptions } from '../git/git-runtime-options'
import { gitExecFileAsyncBuffer, promptGuardGitEnv } from '../git/runner'
import { bulkPathspecCommands } from '../git/source-control/git-pathspec'
import { handoffGit, HandoffGitRouteError } from './handoff-git-exec'

export type HandoffGitFileExpectation = { rel: string; size: number; sha256: string }

export class HandoffGitFilterMismatchError extends HandoffGitRouteError {
  constructor(readonly paths: readonly string[]) {
    super('filter_mismatch', 'Git changes these files on staging; send their exact bytes as pins.')
  }
}

function validateExpectations(files: readonly HandoffGitFileExpectation[]): void {
  if (
    files.length > 64 ||
    new Set(files.map((file) => file.rel)).size !== files.length ||
    files.some(
      (file) =>
        !isSafeRelativePath(file.rel) ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        file.size > HANDOFF_FILE_MAX_BYTES ||
        !/^[a-f0-9]{64}$/.test(file.sha256)
    )
  ) {
    throw new HandoffGitRouteError(
      'invalid_request',
      'The handoff contains invalid Git file expectations.'
    )
  }
}

async function selectedEntries(
  repoRoot: string,
  files: readonly HandoffGitFileExpectation[],
  options: GitRuntimeOptions,
  source: { indexFile: string } | { sha: string }
): Promise<Map<string, string>> {
  const staged = 'indexFile' in source
  const result = new Map<string, string>()
  const args = staged ? ['ls-files', '--stage', '-z', '--'] : ['ls-tree', '-z', source.sha, '--']
  for (const command of bulkPathspecCommands(
    args,
    files.map((file) => file.rel),
    repoRoot,
    options
  )) {
    const output = await handoffGit(
      command,
      repoRoot,
      options,
      staged ? source.indexFile : undefined
    )
    for (const record of iterateNulDelimitedFields(output)) {
      if (!record) {
        continue
      }
      const tab = record.indexOf('\t')
      const rel = record.slice(tab + 1)
      const fields = record.slice(0, tab).split(' ')
      const [mode, second, third] = fields
      const oid = staged ? second : third
      if (
        tab === -1 ||
        fields.length !== 3 ||
        !['100644', '100755'].includes(mode) ||
        (staged ? third !== '0' : second !== 'blob') ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid) ||
        result.has(rel)
      ) {
        throw new HandoffGitRouteError(
          staged ? 'source_changed' : 'checkout_failed',
          `The Git entry for ${rel} is not one regular file.`
        )
      }
      result.set(rel, oid)
    }
  }
  return result
}

async function blobMatches(
  repoRoot: string,
  oid: string | undefined,
  file: HandoffGitFileExpectation,
  options: GitRuntimeOptions
): Promise<boolean> {
  if (!oid) {
    return false
  }
  const size = await handoffGit(['cat-file', '-s', oid], repoRoot, options)
  if (!/^\d+$/.test(size)) {
    throw new Error(`Git did not report a byte size for ${file.rel}.`)
  }
  if (Number(size) !== file.size) {
    return false
  }
  const { stdout } = await gitExecFileAsyncBuffer(['cat-file', 'blob', oid], {
    ...gitOptionsForWorktree(repoRoot, options),
    env: promptGuardGitEnv(),
    maxBuffer: file.size + 1024,
    timeout: 30_000
  })
  return (
    stdout.length === file.size && createHash('sha256').update(stdout).digest('hex') === file.sha256
  )
}

export async function verifyStagedHandoffFiles(
  repoRoot: string,
  indexFile: string,
  files: readonly HandoffGitFileExpectation[],
  options: GitRuntimeOptions
): Promise<void> {
  validateExpectations(files)
  const entries = await selectedEntries(repoRoot, files, options, { indexFile })
  const filtered: string[] = []
  for (const file of files) {
    if (await blobMatches(repoRoot, entries.get(file.rel), file, options)) {
      continue
    }
    try {
      const path = join(repoRoot, file.rel)
      const current = await lstat(path)
      if (!current.isFile() || current.isSymbolicLink() || !entries.has(file.rel)) {
        throw new Error('The selected file is no longer a regular Git entry.')
      }
      const captured = await readExactHandoffFile(path)
      if (captured.size !== file.size || captured.sha256 !== file.sha256) {
        throw new Error('The selected bytes changed.')
      }
    } catch {
      throw new HandoffGitRouteError(
        'source_changed',
        `${file.rel} changed since it was selected. Select it again.`
      )
    }
    filtered.push(file.rel)
  }
  if (filtered.length > 0) {
    throw new HandoffGitFilterMismatchError(filtered)
  }
}

export async function verifyReceivedHandoffFiles(
  repoRoot: string,
  sha: string,
  files: readonly HandoffGitFileExpectation[],
  options: GitRuntimeOptions
): Promise<void> {
  validateExpectations(files)
  const entries = await selectedEntries(repoRoot, files, options, { sha })
  for (const file of files) {
    if (!(await blobMatches(repoRoot, entries.get(file.rel), file, options))) {
      throw new HandoffGitRouteError(
        'checkout_failed',
        `${file.rel} on the branch differs from the bytes the sender recorded. Receive files only to take the loose files without checking out this branch.`
      )
    }
  }
}
