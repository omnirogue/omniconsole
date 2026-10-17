import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import {
  HANDOFF_FILE_MAX_BYTES,
  HANDOFF_THREAD_FILE_MAX_BYTES,
  type ExactHandoffFile
} from '../../shared/console-handoff-contract'
import { capturedHandoffFile } from '../../shared/exact-handoff-file-read'
import type { SourceStat } from '../runtime/conversation-fleet-source-io'
import { writeSkillTarGzip, type SkillTarWriteEntry } from '../skills/skill-package-tar'
import {
  createHandoffAttachmentIo,
  HANDOFF_FOLDER_MAX_ENTRIES,
  HandoffAttachmentError,
  type HandoffAttachmentIo
} from './handoff-attachment-source'

const TOO_LARGE = 'The file or folder archive exceeds the 10 MiB attachment limit.'
const SOURCE_CHANGED = 'The selected file or folder changed during capture. Attach it again.'
const UNSAFE_ENTRY = 'Folders must contain regular files and folders, without symbolic links.'

type FolderEntry = { path: string; archivePath: string; stat: SourceStat; names?: string[] }

function sameStat(left: SourceStat, right: SourceStat): boolean {
  return (['type', 'size', 'mtimeMs', 'ctimeMs', 'ino', 'dev', 'mode'] as const).every(
    (field) => left[field] === right[field]
  )
}

function sortedNames(names: string[]): string[] {
  if (
    new Set(names).size !== names.length ||
    names.some(
      (name) =>
        !name ||
        name === '.' ||
        name === '..' ||
        /[\\/]/.test(name) ||
        Array.from(name).some((character) => character.charCodeAt(0) < 32)
    )
  ) {
    throw new HandoffAttachmentError('The folder contains a path that cannot be archived safely.')
  }
  return [...names].sort()
}

function checkArchiveBudget(tarBytes: number): void {
  // The existing deterministic gzip uses stored blocks, so its final size is known before reads.
  if (18 + tarBytes + 5 * (Math.floor(tarBytes / 65_535) + 1) > HANDOFF_FILE_MAX_BYTES) {
    throw new HandoffAttachmentError(TOO_LARGE)
  }
}

async function folderEntries(
  root: string,
  rootName: string,
  io: HandoffAttachmentIo
): Promise<FolderEntry[]> {
  const api = isWindowsAbsolutePathLike(root) ? win32 : posix
  const entries: FolderEntry[] = []
  let tarBytes = 1024
  async function visit(path: string, archivePath: string, depth: number): Promise<void> {
    if (depth > 32 || entries.length >= HANDOFF_FOLDER_MAX_ENTRIES) {
      throw new HandoffAttachmentError('Choose a folder with at most 1,024 entries and 32 levels.')
    }
    const stat = await io.lstat(path)
    if (
      !['file', 'directory'].includes(stat.type) ||
      api.relative(path, await io.realpath(path)) !== ''
    ) {
      throw new HandoffAttachmentError(UNSAFE_ENTRY)
    }
    if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
      throw new HandoffAttachmentError('The source computer could not verify the file size.')
    }
    tarBytes += 512 + (stat.type === 'file' ? Math.ceil(stat.size / 512) * 512 : 0)
    checkArchiveBudget(tarBytes)
    const names = stat.type === 'directory' ? sortedNames(await io.readNames(path)) : undefined
    entries.push({ path, archivePath, stat, ...(names ? { names } : {}) })
    for (const name of names ?? []) {
      await visit(api.join(path, name), `${archivePath}/${name}`, depth + 1)
    }
  }
  await visit(root, rootName, 0)
  return entries
}

async function verifyFolder(entries: FolderEntry[], io: HandoffAttachmentIo): Promise<void> {
  for (const entry of entries) {
    const api = isWindowsAbsolutePathLike(entry.path) ? win32 : posix
    if (
      !sameStat(entry.stat, await io.lstat(entry.path)) ||
      api.relative(entry.path, await io.realpath(entry.path)) !== '' ||
      (entry.names &&
        JSON.stringify(entry.names) !== JSON.stringify(sortedNames(await io.readNames(entry.path))))
    ) {
      throw new HandoffAttachmentError(SOURCE_CHANGED)
    }
  }
}

async function captureFolder(
  root: string,
  name: string,
  io: HandoffAttachmentIo
): Promise<ExactHandoffFile> {
  if (`${name}.tar.gz`.length > 255) {
    throw new HandoffAttachmentError('The folder name is too long for an attachment.')
  }
  sortedNames([name])
  const entries = await folderEntries(root, name, io)
  const archiveEntries: SkillTarWriteEntry[] = []
  for (const entry of entries) {
    archiveEntries.push({
      path: entry.archivePath,
      size: entry.stat.type === 'directory' ? 0 : entry.stat.size,
      executable: Boolean((entry.stat.mode ?? 0) & 0o111),
      ...(entry.stat.type === 'directory'
        ? { directory: true }
        : { bytes: await io.readExact(entry.path, HANDOFF_FILE_MAX_BYTES, entry.stat) })
    })
  }
  const directory = await mkdtemp(join(tmpdir(), 'omni-handoff-attachment-'))
  try {
    const path = join(directory, 'folder.tar.gz')
    await writeSkillTarGzip(path, archiveEntries)
    await verifyFolder(entries, io)
    const bytes = await readFile(path)
    if (bytes.length > HANDOFF_FILE_MAX_BYTES) {
      throw new HandoffAttachmentError(TOO_LARGE)
    }
    return capturedHandoffFile(`${name}.tar.gz`, bytes)
  } catch (error) {
    if (error instanceof Error && error.message === 'skill-package-tar-path-limit') {
      throw new HandoffAttachmentError('A folder path is too long for a portable archive.')
    }
    throw error
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** Captures the chosen path on its owner; folders travel as one exact, portable archive. */
export async function captureHandoffAttachment(
  filePath: string,
  io: HandoffAttachmentIo = createHandoffAttachmentIo(),
  threadUpload = false
): Promise<ExactHandoffFile> {
  const api = isWindowsAbsolutePathLike(filePath) ? win32 : posix
  const stat = await io.lstat(filePath)
  if (api.relative(filePath, await io.realpath(filePath)) !== '') {
    throw new HandoffAttachmentError(UNSAFE_ENTRY)
  }
  const name = api.basename(filePath)
  if (stat.type === 'directory') {
    return captureFolder(filePath, name, io)
  }
  if (stat.type !== 'file') {
    throw new HandoffAttachmentError(UNSAFE_ENTRY)
  }
  const limit = threadUpload ? HANDOFF_THREAD_FILE_MAX_BYTES : HANDOFF_FILE_MAX_BYTES
  if (stat.size > limit) {
    throw new HandoffAttachmentError(
      `${name}: ${stat.size} bytes exceeds the ${limit} byte (${limit / 1024 / 1024} MiB) limit. Split the file or use the card’s Google Drive folder.`
    )
  }
  return capturedHandoffFile(name, await io.readExact(filePath, limit, stat), threadUpload)
}
