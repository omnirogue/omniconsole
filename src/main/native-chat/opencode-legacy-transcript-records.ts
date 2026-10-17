import { basename, dirname, isAbsolute, join } from 'node:path'
import { TextDecoder } from 'node:util'
import { asRecord, findOpenCodeStorageRoot, timestampMs } from '../ai-vault/session-scanner-values'
import { resolveOpenCodeStorageDirectory } from '../opencode/opencode-data-directory'
import {
  readTranscriptFileVersion,
  transcriptFileVersionChanged,
  type TranscriptFileVersion
} from './transcript-file-version'
import {
  openTranscriptReadStream,
  wslGatedLstat,
  wslGatedReaddir
} from './wsl-transcript-fs-access'

type LegacyRecord = {
  recordType: 'session' | 'message' | 'part'
  recordId: string
  text: string
}
type RecordFile = { path: string; id: string; created: number; version: TranscriptFileVersion }

function requireSafeId(id: string): void {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error('Invalid OpenCode transcript record ID.')
  }
}

function changed(path: string): Error {
  return new Error(`OpenCode transcript source changed while reading: ${path}. Retry capture.`)
}

function missing(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: OpenCode transcript session not found: ${path}`), {
    code: 'ENOENT',
    path
  })
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

async function directoryExists(path: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted()
  try {
    if (!(await wslGatedLstat(path, 'exact', signal)).isDirectory()) {
      throw new Error(`OpenCode transcript source is not a regular directory: ${path}`)
    }
    return true
  } catch (error) {
    if (isMissing(error)) {
      return false
    }
    throw error
  }
}

async function directoryEntries(path: string, signal?: AbortSignal): Promise<string[] | null> {
  if (!(await directoryExists(path, signal))) {
    return null
  }
  return (await wslGatedReaddir(path, 'exact', signal)).map((entry) => entry.name).sort()
}

async function sessionFilePath(
  sessionId: string,
  provided?: string,
  signal?: AbortSignal
): Promise<string> {
  if (provided !== undefined) {
    if (
      !isAbsolute(provided) ||
      provided.split(/[\\/]/).includes('..') ||
      provided.includes('\0')
    ) {
      throw new Error('OpenCode transcript path must be absolute without traversal segments.')
    }
    if (!findOpenCodeStorageRoot(provided) || !provided.endsWith('.json')) {
      throw new Error('OpenCode transcript path must identify a legacy session JSON file.')
    }
    await directoryExists(dirname(dirname(provided)), signal)
    await directoryExists(dirname(provided), signal)
    return provided
  }
  const root = join(resolveOpenCodeStorageDirectory(), 'session')
  const projects = await directoryEntries(root, signal)
  if (!projects) {
    throw missing(root)
  }
  let found: string | undefined
  for (const project of projects) {
    signal?.throwIfAborted()
    const projectPath = join(root, project)
    const stat = await wslGatedLstat(projectPath, 'exact', signal)
    if (stat.isSymbolicLink()) {
      throw new Error(`OpenCode session project is a symlink: ${projectPath}`)
    }
    if (!stat.isDirectory()) {
      continue
    }
    const candidate = join(projectPath, `${sessionId}.json`)
    try {
      await wslGatedLstat(candidate, 'exact', signal)
    } catch (error) {
      if (isMissing(error)) {
        continue
      }
      throw error
    }
    if (found) {
      throw new Error(`OpenCode session ID is ambiguous across storage projects: ${sessionId}`)
    }
    found = candidate
  }
  if (!found) {
    throw missing(join(root, sessionId))
  }
  return found
}

async function verifyVersion(
  path: string,
  version: TranscriptFileVersion,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  try {
    if (transcriptFileVersionChanged(await readTranscriptFileVersion(path, signal), version)) {
      throw changed(path)
    }
  } catch (error) {
    if (isMissing(error)) {
      throw changed(path)
    }
    throw error
  }
}

async function readRecord(
  path: string,
  signal?: AbortSignal
): Promise<{
  text: string
  value: Record<string, unknown>
  version: TranscriptFileVersion
}> {
  signal?.throwIfAborted()
  if (!(await wslGatedLstat(path, 'exact', signal)).isFile()) {
    throw new Error(`OpenCode transcript source is not a regular file: ${path}`)
  }
  const version = await readTranscriptFileVersion(path, signal)
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  const pieces: string[] = []
  let bytes = 0
  try {
    // Read only the initial size so a growing file cannot keep capture open indefinitely.
    if (version.size > 0) {
      for await (const chunk of openTranscriptReadStream(
        path,
        { end: version.size - 1 },
        'exact',
        signal
      )) {
        signal?.throwIfAborted()
        const buffer = Buffer.from(chunk)
        bytes += buffer.length
        pieces.push(decoder.decode(buffer, { stream: true }))
      }
    }
    pieces.push(decoder.decode())
  } catch (error) {
    if (isMissing(error)) {
      throw changed(path)
    }
    if (error instanceof TypeError) {
      throw new Error(`Corrupt UTF-8 in OpenCode transcript: ${path}`)
    }
    throw error
  }
  if (bytes !== version.size) {
    throw changed(path)
  }
  await verifyVersion(path, version, signal)
  const text = pieces.join('')
  let value: Record<string, unknown> | null
  try {
    value = asRecord(JSON.parse(text) as unknown)
  } catch {
    throw new Error(`Corrupt JSON in OpenCode transcript: ${path}`)
  }
  if (!value) {
    throw new Error(`OpenCode transcript record must be a JSON object: ${path}`)
  }
  return { text, value, version }
}

function recordId(value: Record<string, unknown>, path: string): string {
  const id = value.id === undefined ? basename(path, '.json') : value.id
  if (typeof id !== 'string') {
    throw new Error(`Invalid OpenCode record ID: ${path}`)
  }
  requireSafeId(id)
  return id
}

function checkOwner(value: Record<string, unknown>, sessionId: string, messageId?: string): void {
  if (
    (value.sessionID !== undefined && value.sessionID !== sessionId) ||
    (messageId !== undefined && value.messageID !== undefined && value.messageID !== messageId)
  ) {
    throw new Error('OpenCode transcript record belongs to a different session or message.')
  }
}

export async function* readOpenCodeLegacyTranscriptRecords(
  args: { sessionId: string; transcriptPath?: string },
  signal?: AbortSignal
): AsyncGenerator<LegacyRecord> {
  requireSafeId(args.sessionId)
  const path = await sessionFilePath(args.sessionId, args.transcriptPath, signal)
  const root = findOpenCodeStorageRoot(path)!
  const versions = new Map<string, TranscriptFileVersion>()
  const directories = new Map<string, string[] | null>()
  const session = await readRecord(path, signal)
  if (recordId(session.value, path) !== args.sessionId) {
    throw new Error('OpenCode transcript file belongs to a different session.')
  }
  versions.set(path, session.version)
  for (const kind of ['message', 'part']) {
    await directoryExists(join(root, kind), signal)
  }

  async function listRecords(directory: string, messageId?: string): Promise<RecordFile[]> {
    const entries = await directoryEntries(directory, signal)
    directories.set(directory, entries)
    const files: RecordFile[] = []
    const ids = new Set<string>()
    for (const name of entries ?? []) {
      if (!name.endsWith('.json')) {
        continue
      }
      const filePath = join(directory, name)
      const record = await readRecord(filePath, signal)
      checkOwner(record.value, args.sessionId, messageId)
      const id = recordId(record.value, filePath)
      if (ids.has(id)) {
        throw new Error(`Duplicate OpenCode transcript record ID: ${id}`)
      }
      ids.add(id)
      const created = timestampMs(asRecord(record.value.time)?.created)
      files.push({
        path: filePath,
        id,
        created: Number.isFinite(created) ? created : Infinity,
        version: record.version
      })
      versions.set(filePath, record.version)
    }
    return files.sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  async function readVerified(
    file: RecordFile,
    recordType: 'message' | 'part'
  ): Promise<LegacyRecord> {
    await verifyVersion(file.path, file.version, signal)
    const record = await readRecord(file.path, signal)
    if (transcriptFileVersionChanged(record.version, file.version)) {
      throw changed(file.path)
    }
    return { recordType, recordId: file.id, text: record.text }
  }

  // Keep only ordering metadata between records; large tool payloads stay one file at a time.
  const messages = await listRecords(join(root, 'message', args.sessionId))
  const parts = new Map<string, RecordFile[]>()
  for (const message of messages) {
    parts.set(message.id, await listRecords(join(root, 'part', message.id), message.id))
  }
  yield { recordType: 'session', recordId: args.sessionId, text: session.text }
  for (const message of messages) {
    yield await readVerified(message, 'message')
    for (const part of parts.get(message.id) ?? []) {
      yield await readVerified(part, 'part')
    }
  }
  for (const [filePath, version] of versions) {
    await verifyVersion(filePath, version, signal)
  }
  for (const [directory, entries] of directories) {
    if (JSON.stringify(await directoryEntries(directory, signal)) !== JSON.stringify(entries)) {
      throw changed(directory)
    }
  }
}
