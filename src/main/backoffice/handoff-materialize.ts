import { createHash } from 'node:crypto'
import { dirname, join, resolve, sep } from 'node:path'
import { checkRootedDirectory } from '../filesystem-directory-chain'
import { writeExclusiveFile } from '../filesystem-exclusive-file'
import { handoffFileDestination, readExistingHandoffFile } from './handoff-file-destination'
import type { ExactHandoffFile } from '../../shared/console-handoff-contract'
import {
  HANDOFF_MANIFEST_NAME,
  buildHandoffManifest,
  isSafeRelativePath,
  parseHandoffManifest,
  type HandoffManifest
} from '../../shared/handoff-manifest'

/**
 * Put a handoff's files on this machine, in the folders the sender had them in.
 *
 * Files that travelled by git are already on disk once the branch is checked out; this handles the
 * rest. Every file is verified twice over: the download itself checks the bytes against the thread's
 * own record, and this checks them again against the manifest the sender wrote, so a file that
 * changed between the two records is refused instead of written.
 */
export type MaterializeHandoffFile = {
  rel: string
  name: string
  sha256: string
  size: number
  /** Written, skipped because the same bytes were already there, or refused with a reason. */
  outcome: 'written' | 'unchanged' | 'refused'
  path?: string
  reason?: string
}

export type MaterializeHandoffResult = {
  root: string
  files: MaterializeHandoffFile[]
  /** True when every file the manifest listed for this route is on disk with the right bytes. */
  complete: boolean
}

export type HandoffMaterializeIo = {
  /** Fetch one thread file's exact bytes; the caller's downloader verifies them thread-side. */
  download: (file: { id: string; rel: string }) => Promise<ExactHandoffFile>
}

export class HandoffMaterializeError extends Error {
  constructor(
    readonly code: 'invalid_request' | 'outside_root' | 'manifest_unreadable',
    message: string
  ) {
    super(message)
    this.name = 'HandoffMaterializeError'
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function decode(file: ExactHandoffFile): Buffer {
  return Buffer.from(file.contentBase64, 'base64')
}

/** Resolve `rel` under `root`, refusing anything that would land outside it. */
export function resolveUnderRoot(root: string, rel: string): string {
  if (!isSafeRelativePath(rel)) {
    throw new HandoffMaterializeError('outside_root', `${rel} is not a path inside the folder.`)
  }
  const base = resolve(root)
  const target = resolve(base, rel.replace(/\\/g, '/'))
  if (target !== base && !target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)) {
    throw new HandoffMaterializeError('outside_root', `${rel} would be written outside the folder.`)
  }
  return target
}

/**
 * A request sent as plain attachments carries no manifest (every Person request does this), so its
 * files go side by side into the chosen folder under the names the thread gives them.
 */
export function attachmentsManifest(
  sessionLabel: string,
  files: readonly { name: string; sha256: string; size: number }[]
): HandoffManifest {
  return buildHandoffManifest({
    createdAt: new Date(),
    source: { sessionLabel: sessionLabel.slice(0, 500) },
    memo: '',
    files: files
      .filter((file) => isSafeRelativePath(file.name) && !/[\\/]/.test(file.name))
      .slice(0, 64)
      .map((file) => ({
        rel: file.name,
        name: file.name,
        route: 'pin' as const,
        sha256: file.sha256,
        size: file.size
      }))
  })
}

/** The manifest of a handoff, read from the thread's own files. */
export async function readHandoffManifestFile(
  files: readonly { id: string; name: string; rel?: string; path?: string }[],
  download: HandoffMaterializeIo['download']
): Promise<HandoffManifest> {
  const entry = files.find((file) => file.name === HANDOFF_MANIFEST_NAME)
  if (!entry) {
    throw new HandoffMaterializeError(
      'manifest_unreadable',
      `This handoff carries no ${HANDOFF_MANIFEST_NAME}, so its files have no folders to go back to.`
    )
  }
  const exact = await download({
    id: entry.id,
    rel: entry.rel ?? entry.path ?? entry.name
  })
  const manifest = parseHandoffManifest(decode(exact).toString('utf8'))
  if (!manifest) {
    throw new HandoffMaterializeError(
      'manifest_unreadable',
      `The ${HANDOFF_MANIFEST_NAME} in this handoff could not be read.`
    )
  }
  return manifest
}

/**
 * Write every non-git file of `manifest` under `root`. Files already present with the same bytes
 * are left alone, so running this twice is safe and says so.
 */
export async function materializeHandoffFiles(input: {
  root: string
  /** Existing workspace anchoring a destination prefix that may not exist yet. */
  workspacePath?: string
  manifest: HandoffManifest
  /** Thread file rows, matched to manifest entries by name then by sha256. */
  threadFiles: readonly {
    id: string
    name: string
    sha256: string
    rel?: string
    path?: string
  }[]
  io: HandoffMaterializeIo
}): Promise<MaterializeHandoffResult> {
  const { root, manifest, threadFiles, io } = input
  if (!root.trim()) {
    throw new HandoffMaterializeError('invalid_request', 'Choose where the files should go.')
  }
  const destination = await handoffFileDestination(input.workspacePath ?? root, root)
  const results: MaterializeHandoffFile[] = []
  for (const entry of manifest.files) {
    if (entry.route === 'git' || entry.name === HANDOFF_MANIFEST_NAME) {
      continue
    }
    const base = {
      rel: entry.rel,
      name: entry.name,
      sha256: entry.sha256,
      size: entry.size
    }
    let target: string
    try {
      target = resolveUnderRoot(destination.destination, entry.rel)
    } catch (error) {
      results.push({
        ...base,
        outcome: 'refused',
        reason: error instanceof Error ? error.message : String(error)
      })
      continue
    }
    let existing: Buffer | null
    try {
      existing = await readExistingHandoffFile(destination.root, target, entry.size)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        results.push({
          ...base,
          outcome: 'refused',
          reason: `Cannot read ${entry.rel}: ${error instanceof Error ? error.message : String(error)}`
        })
        continue
      }
      existing = null
    }
    if (existing && existing.length === entry.size && sha256(existing) === entry.sha256) {
      results.push({ ...base, outcome: 'unchanged', path: target })
      continue
    }
    if (existing) {
      results.push({
        ...base,
        outcome: 'refused',
        reason: `${entry.rel} already contains different work. Choose an empty destination folder.`
      })
      continue
    }
    const row =
      threadFiles.find((file) => file.name === entry.name && file.sha256 === entry.sha256) ??
      threadFiles.find((file) => file.sha256 === entry.sha256)
    if (!row) {
      results.push({
        ...base,
        outcome: 'refused',
        reason: `${entry.name} is named in the manifest but is not on this handoff.`
      })
      continue
    }
    let bytes: Buffer
    try {
      bytes = decode(
        await io.download({
          id: row.id,
          rel: row.rel ?? row.path ?? entry.rel
        })
      )
    } catch (error) {
      results.push({
        ...base,
        outcome: 'refused',
        reason: error instanceof Error ? error.message : String(error)
      })
      continue
    }
    // The download verified these bytes against the thread's record; this verifies them against
    // the sender's manifest. A file that changed between the two is refused, never written.
    if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) {
      results.push({
        ...base,
        outcome: 'refused',
        reason: `${entry.name} does not match the version the sender recorded.`
      })
      continue
    }
    try {
      await checkRootedDirectory(destination.root, dirname(target), 'create')
      await writeExclusiveFile(target, bytes, {
        validateDestinationParent: () => checkRootedDirectory(destination.root, dirname(target)),
        temporaryDirectory: destination.root.path,
        validateTemporaryParent: () => checkRootedDirectory(destination.root, destination.root.path)
      })
      results.push({ ...base, outcome: 'written', path: target })
    } catch (error) {
      results.push({
        ...base,
        outcome: 'refused',
        reason: `Cannot write ${entry.rel}: ${error instanceof Error ? error.message : String(error)}`
      })
    }
  }
  return {
    root,
    files: results,
    complete: results.every((file) => file.outcome !== 'refused')
  }
}

/** Where a handoff's files go by default: the workspace root the recipient picked. */
export function defaultMaterializeRoot(workspacePath: string, manifest: HandoffManifest): string {
  // A git-backed handoff puts non-repo files beside the repo, under one named folder, so a
  // checkout never collides with them.
  return manifest.git
    ? join(workspacePath, '.omni', 'handoffs', manifest.git.sha.slice(0, 12))
    : workspacePath
}
