/**
 * The wake copy's one-file container (PLAN section 4, OAOS-12 Phase 2): relocate's exported
 * conversation files, plus files the session wrote in its `~/Work` folder, behind a JSON header,
 * gzipped. Unpacking writes the conversation where relocate's import expects a staged bundle and
 * checks every byte count and checksum, so a damaged or hostile copy never reaches a provider home.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { gunzip, gzip } from 'node:zlib'
import {
  isRelocationManifestPath,
  type SessionHostRelocationManifest
} from '../../shared/session-host-payload-schema'
import { isCredentialShapedPath } from '../session-relocation/relocation-bundle-files'

const MAGIC = Buffer.from('OMNIWAKE1\n')
/** OmniOS keeps at most this much per copy (CONTRACT.md); a larger one is not uploaded. */
export const WAKE_COPY_MAX_BYTES = 64 * 1024 * 1024
// Why a cap on the unpacked size too: a small gzip can expand without bound.
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024
const MAX_HEADER_BYTES = 4 * 1024 * 1024

export type WakeCopyWorkspace =
  | { kind: 'folder'; workRelativePath: string }
  | { kind: 'git'; remoteUrl: string; branch: string; commit: string }

/** What the waking computer needs besides the files; OmniOS sees only `requirements`. */
export type WakeCopyHeader = {
  version: 1
  slug: string
  revision: number
  provider: 'claude' | 'codex'
  sessionId: string
  title: string | null
  model: string | null
  effort: string | null
  writerVersion: string | null
  /** The computer the session slept on, for the move line. */
  host: string
  workspace: WakeCopyWorkspace
  manifest: SessionHostRelocationManifest
  /** Files the session wrote, relative to its folder workspace. */
  written: { path: string; bytes: number; sha256: string }[]
}

/** `bytes`: the exact contents already checked, packed as they are rather than read again. */
export type WakeCopyFile = { path: string; absolute: string; bytes?: Buffer }

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** Reads every file now and packs it; the caller checks the result against the size limit. */
export async function packWakeCopy(input: {
  header: Omit<WakeCopyHeader, 'written'>
  conversation: ReadonlyMap<string, string>
  written: readonly WakeCopyFile[]
}): Promise<{ blob: Buffer; sha256: string; header: WakeCopyHeader }> {
  const bodies: Buffer[] = []
  for (const file of input.header.manifest.files) {
    const absolute = input.conversation.get(file.path)
    if (!absolute) {
      throw new Error(`The exported conversation lacks ${file.path}.`)
    }
    const bytes = await readFile(absolute)
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) {
      throw new Error(`${file.path} changed while it was being copied.`)
    }
    bodies.push(bytes)
  }
  const written: WakeCopyHeader['written'] = []
  for (const file of input.written) {
    const bytes = file.bytes ?? (await readFile(file.absolute))
    written.push({ path: file.path, bytes: bytes.length, sha256: sha256(bytes) })
    bodies.push(bytes)
  }
  const header: WakeCopyHeader = { ...input.header, written }
  const json = Buffer.from(JSON.stringify(header), 'utf8')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(json.length)
  const blob = await promisify(gzip)(Buffer.concat([MAGIC, length, json, ...bodies]))
  return { blob, sha256: sha256(blob), header }
}

// Why: on Windows `name:stream`, a trailing dot or space, and device names open something else.
const WINDOWS_TRAP = /(^|\/)(con|prn|aux|nul|com\d|lpt\d)(\.[^/]*)?(\/|$)|:|[. ](\/|$)/i

function safePath(path: string): boolean {
  return isRelocationManifestPath(path) && !WINDOWS_TRAP.test(path)
}

function safeWrittenPath(path: string): boolean {
  return safePath(path) && !isCredentialShapedPath(path)
}

function readHeader(raw: Buffer): { header: WakeCopyHeader; offset: number } {
  if (raw.length < MAGIC.length + 4 || !raw.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('This is not a wake copy this version can read.')
  }
  const length = raw.readUInt32BE(MAGIC.length)
  const offset = MAGIC.length + 4 + length
  if (length > MAX_HEADER_BYTES || offset > raw.length) {
    throw new Error('The wake copy is damaged.')
  }
  const header = JSON.parse(
    raw.subarray(MAGIC.length + 4, offset).toString('utf8')
  ) as WakeCopyHeader
  if (
    header?.version !== 1 ||
    !Array.isArray(header.manifest?.files) ||
    !Array.isArray(header.written) ||
    (header.provider !== 'claude' && header.provider !== 'codex') ||
    typeof header.sessionId !== 'string' ||
    header.manifest.provider !== header.provider ||
    header.manifest.providerSessionId !== header.sessionId
  ) {
    throw new Error('The wake copy is damaged.')
  }
  return { header, offset }
}

/**
 * Checks the copy and writes it under `stagingRoot`: the conversation in `bundle/` (relocate's
 * import verifies it again against the manifest) and written files in `written/`.
 */
export async function unpackWakeCopy(
  blob: Buffer,
  expectedSha256: string,
  stagingRoot: string
): Promise<{ header: WakeCopyHeader; bundleRoot: string; writtenRoot: string }> {
  if (sha256(blob) !== expectedSha256) {
    throw new Error('The wake copy does not match its checksum.')
  }
  const raw = await promisify(gunzip)(blob, { maxOutputLength: MAX_UNPACKED_BYTES })
  const { header, offset } = readHeader(raw)
  const bundleRoot = join(stagingRoot, 'bundle')
  const writtenRoot = join(stagingRoot, 'written')
  const entries = [
    ...header.manifest.files.map((file) => ({
      ...file,
      root: bundleRoot,
      ok: safePath(file.path)
    })),
    ...header.written.map((file) => ({
      ...file,
      root: writtenRoot,
      ok: safeWrittenPath(file.path)
    }))
  ]
  // Why every check before the first write: a refused copy leaves nothing behind.
  let at = offset
  const checked: { target: string; bytes: Buffer }[] = []
  for (const entry of entries) {
    if (!entry.ok || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      throw new Error(`The wake copy names an unsafe file: ${JSON.stringify(entry.path)}.`)
    }
    const bytes = raw.subarray(at, at + entry.bytes)
    at += entry.bytes
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
      throw new Error(`${entry.path} in the wake copy is damaged.`)
    }
    checked.push({ target: join(entry.root, ...entry.path.split('/')), bytes })
  }
  if (at !== raw.length) {
    throw new Error('The wake copy holds more than its header lists.')
  }
  for (const { target, bytes } of checked) {
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, bytes, { flag: 'wx' })
  }
  return { header, bundleRoot, writtenRoot }
}
