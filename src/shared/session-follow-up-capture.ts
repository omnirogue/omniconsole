import { HANDOFF_THREAD_FILE_MAX_BYTES, type ExactHandoffFile } from './console-handoff-contract'
import { rememberFollowUpFile } from './session-follow-up-file-snapshot'
import {
  outputFileName,
  parseDeliverablesManifest,
  resolveWorkspaceOutputPath
} from './session-follow-up-deliverables'
import {
  SESSION_FOLLOW_UP_MAX_FILE_BYTES,
  SESSION_FOLLOW_UP_MAX_FILES,
  type SessionFollowUpFilePin,
  type SessionFollowUpRule
} from './session-follow-up-rule'
import { FollowUpException, type FollowUpHostIo } from './session-follow-up-delivery-contract'
import { packageFileNames, type PackageEntry } from './session-follow-up-package-names'

export type FollowUpCapture = {
  pins: SessionFollowUpFilePin[]
  bytes: Map<string, ExactHandoffFile>
}

function decodeText(file: ExactHandoffFile): string {
  const bytes = Uint8Array.from(atob(file.contentBase64), (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/** The exact paths to deliver, or the names still missing; never a directory listing. */
export async function resolveFollowUpFiles(
  rule: SessionFollowUpRule,
  workspacePath: string,
  io: FollowUpHostIo
): Promise<{ paths: string[]; missing: string[] }> {
  let paths = rule.deliverables.kind === 'files' ? rule.deliverables.paths : []
  const manifestPaths =
    rule.deliverables.kind === 'manifest'
      ? [rule.deliverables.manifestPath]
      : rule.deliverables.kind === 'manifests'
        ? rule.deliverables.manifestPaths
        : []
  for (const path of [...paths, ...manifestPaths]) {
    if (!resolveWorkspaceOutputPath(workspacePath, path)) {
      throw new FollowUpException('outside-workspace', outputFileName(path))
    }
  }
  for (const manifestPath of manifestPaths) {
    const manifestName = outputFileName(manifestPath)
    if (!(await io.exists(manifestPath))) {
      return { paths: [], missing: [manifestName] }
    }
    const manifestFile = await io.readExact(manifestPath)
    if (manifestFile.name !== manifestName) {
      throw new FollowUpException(
        'unreadable',
        manifestName,
        'A deliverables manifest must be a regular file.'
      )
    }
    const manifest = parseDeliverablesManifest(
      decodeText(manifestFile),
      manifestPath,
      workspacePath
    )
    if (manifest.refused.length > 0) {
      throw new FollowUpException('outside-workspace', manifest.refused[0]!)
    }
    // Why: a manifest that names nothing is not a finished run's declaration yet.
    if (manifest.paths.length === 0) {
      return { paths: [], missing: [manifestName] }
    }
    const declared: string[] = []
    for (const path of manifest.paths) {
      const fromRoot = manifest.inWorkspace[path]
      // Why: beside the manifest wins; the workspace reading is only for a file that is not there.
      declared.push(
        fromRoot && !(await io.exists(path)) && (await io.exists(fromRoot)) ? fromRoot : path
      )
    }
    // Why: several runs may declare the same file; it travels once.
    paths = [...new Set([...paths, ...declared])]
  }
  const missing: string[] = []
  for (const path of paths) {
    if (!(await io.exists(path))) {
      missing.push(outputFileName(path))
    }
  }
  return { paths, missing }
}

function packageNames(entries: readonly PackageEntry[]): string[] {
  const resolved = packageFileNames(entries)
  if ('duplicate' in resolved) {
    throw new FollowUpException('duplicate-names', resolved.duplicate)
  }
  return resolved.names
}

function oversizedFile(name: string, size: number, threadUpload: boolean): FollowUpException {
  const limit = threadUpload ? HANDOFF_THREAD_FILE_MAX_BYTES : SESSION_FOLLOW_UP_MAX_FILE_BYTES
  return new FollowUpException(
    'file-too-large',
    name,
    `${name}: ${size} bytes exceeds the ${limit} byte limit for this handoff. Split the file, use a card-less thread for files up to 25 MiB, or deliver separately through the card’s Google Drive folder and remove it from this handoff.`
  )
}

export async function captureFollowUpFiles(
  paths: readonly string[],
  summary: ExactHandoffFile | null,
  io: FollowUpHostIo,
  transcript: ExactHandoffFile | null = null,
  maxTotalBytes = Number.POSITIVE_INFINITY,
  threadUpload = false
): Promise<FollowUpCapture> {
  const generated = [summary, transcript]
    .filter((file) => file !== null)
    .map((file) => ({ sourcePath: null, name: file.name }))
  if (paths.length + generated.length > SESSION_FOLLOW_UP_MAX_FILES) {
    throw new FollowUpException('too-many-files', String(paths.length + generated.length))
  }
  // Why: two of the person's own files sharing a name is refused before any byte is read.
  packageNames([
    ...paths.map((path) => ({ sourcePath: path, name: outputFileName(path) })),
    ...generated
  ])
  const captured: { path: string; file: ExactHandoffFile }[] = []
  let totalBytes = (summary?.size ?? 0) + (transcript?.size ?? 0)
  const checkTotal = (additional: number): void => {
    if (totalBytes + additional > maxTotalBytes) {
      throw new FollowUpException(
        'file-too-large',
        'Agent attachments',
        'An agent handoff supports up to 10 MiB of attachments in total.'
      )
    }
  }
  checkTotal(0)
  const limit = threadUpload ? HANDOFF_THREAD_FILE_MAX_BYTES : SESSION_FOLLOW_UP_MAX_FILE_BYTES
  const sizes = await Promise.all(paths.map((path) => io.size(path)))
  for (const [index, path] of paths.entries()) {
    if (sizes[index]! > limit) {
      throw oversizedFile(outputFileName(path), sizes[index]!, threadUpload)
    }
  }
  for (const [index, path] of paths.entries()) {
    const sourceSize = sizes[index]!
    checkTotal(sourceSize)
    const file = await io.readExact(path)
    checkTotal(file.size)
    totalBytes += file.size
    if (file.size > limit) {
      throw oversizedFile(file.name, file.size, threadUpload)
    }
    captured.push({ path, file })
  }
  // Folders acquire an archive suffix during capture, so the package is named from the final names.
  const names = packageNames([
    ...captured.map(({ path, file }) => ({ sourcePath: path, name: file.name })),
    ...generated
  ])
  const pins: SessionFollowUpFilePin[] = []
  const bytes = new Map<string, ExactHandoffFile>()
  captured.forEach(({ path, file }, index) => {
    const name = names[index]!
    const pin = { sourcePath: path, name, sha256: file.sha256, size: file.size }
    pins.push(pin)
    if (file.size > SESSION_FOLLOW_UP_MAX_FILE_BYTES) {
      rememberFollowUpFile(pin, file)
    }
    bytes.set(name, name === file.name ? file : { ...file, name })
  })
  if (summary) {
    pins.push({ sourcePath: null, name: summary.name, sha256: summary.sha256, size: summary.size })
    bytes.set(summary.name, summary)
  }
  if (transcript) {
    pins.push({
      sourcePath: null,
      generatedKind: 'transcript',
      name: transcript.name,
      sha256: transcript.sha256,
      size: transcript.size
    })
    bytes.set(transcript.name, transcript)
  }
  return { pins, bytes }
}
