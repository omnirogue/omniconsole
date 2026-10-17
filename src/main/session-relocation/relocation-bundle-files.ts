/**
 * The native files of one provider conversation as a relocation bundle: relative, non-escaping
 * paths with exact sizes and SHA-256 digests, read only from regular files. A symlink, an escaping
 * path or a credential-shaped name refuses the whole bundle, so a bundle can never carry an
 * account's credentials or anything outside the conversation. Electron-free: relays run it too.
 */

import { createHash } from 'node:crypto'
import { createReadStream, lstatSync, readdirSync, type Stats } from 'node:fs'
import { join } from 'node:path'
import type { SessionHostRelocationProvider } from '../../shared/session-host-capabilities'
import {
  isRelocationManifestPath,
  sessionHostRelocationManifestDigest,
  type SessionHostRelocationManifest
} from '../../shared/session-host-payload-schema'
import { sessionHostRefusal, type SessionHostRefusal } from '../../shared/session-host-refusal'

/** Carries the refusal the host answers with; nothing it guards has moved yet. */
export class SessionRelocationRefusal extends Error {
  constructor(readonly refusal: SessionHostRefusal) {
    super(refusal.message)
    this.name = 'SessionRelocationRefusal'
  }
}

export function refuseRelocation(
  code: SessionHostRefusal['code'],
  message: string
): SessionRelocationRefusal {
  return new SessionRelocationRefusal(sessionHostRefusal(code, message))
}

/** A manifest path and the absolute file it is read from (export) or written to (import). */
export type RelocationBundleFile = { path: string; absolute: string }

const MAX_FILES = 10_000
// Why names, not content: account credentials live in files with these names; transcripts never do.
const CREDENTIAL_NAMES = [
  /^\.?credentials(\.json)?$/i,
  /^auth\.json$/i,
  /^\.env(\..*)?$/i,
  /^(settings|settings\.local|config)\.(json|toml)$/i,
  /^\.?netrc$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|keychain)$/i,
  /(token|secret|password|oauth)/i
]

export function isCredentialShapedPath(path: string): boolean {
  return path
    .split('/')
    .some((segment) => CREDENTIAL_NAMES.some((pattern) => pattern.test(segment)))
}

function checkPath(path: string): void {
  if (!isRelocationManifestPath(path)) {
    throw refuseRelocation(
      'invalid-request',
      `${JSON.stringify(path)} would leave the conversation's bundle, so nothing was exported.`
    )
  }
  if (isCredentialShapedPath(path)) {
    throw refuseRelocation(
      'not-eligible',
      `${path} is named like a credential, and a relocation never carries credentials. Nothing was moved.`
    )
  }
}

function regularFile(absolute: string, path: string): Stats {
  let info: Stats
  try {
    info = lstatSync(absolute)
  } catch {
    throw refuseRelocation('not-eligible', `${path} could not be read. Nothing was moved.`)
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw refuseRelocation(
      'not-eligible',
      `${path} is ${info.isSymbolicLink() ? 'a symbolic link' : 'not a regular file'}; a relocation copies only the conversation's own files. Nothing was moved.`
    )
  }
  return info
}

export async function relocationFileDigest(
  absolute: string,
  path: string
): Promise<{ bytes: number; sha256: string }> {
  regularFile(absolute, path)
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(absolute)) {
    const buffer = chunk as Buffer
    bytes += buffer.length
    hash.update(buffer)
  }
  return { bytes, sha256: hash.digest('hex') }
}

/**
 * Every regular file under `root`, as `prefix/<relative>` manifest paths. A symlink anywhere refuses
 * the bundle rather than being skipped: following it could leave the conversation, and skipping it
 * would make the history incomplete.
 */
export function listRelocationTree(root: string, prefix: string): RelocationBundleFile[] {
  const files: RelocationBundleFile[] = []
  const walk = (directory: string, relative: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name)
      const path = `${relative}/${name}`
      const info = lstatSync(absolute)
      if (info.isSymbolicLink()) {
        throw refuseRelocation(
          'not-eligible',
          `${path} is a symbolic link; a relocation copies only the conversation's own files. Nothing was moved.`
        )
      }
      if (info.isDirectory()) {
        walk(absolute, path)
      } else if (info.isFile()) {
        files.push({ path, absolute })
      } else {
        throw refuseRelocation('not-eligible', `${path} is not a regular file. Nothing was moved.`)
      }
      if (files.length > MAX_FILES) {
        throw refuseRelocation(
          'not-eligible',
          `The conversation has more than ${MAX_FILES} files. Nothing was moved.`
        )
      }
    }
  }
  walk(root, prefix)
  return files
}

export async function buildRelocationManifest(
  provider: SessionHostRelocationProvider,
  providerSessionId: string,
  files: readonly RelocationBundleFile[]
): Promise<SessionHostRelocationManifest> {
  if (files.length === 0 || files.length > MAX_FILES) {
    throw refuseRelocation(
      'not-eligible',
      'The conversation has no files to move. Nothing was moved.'
    )
  }
  const seen = new Set<string>()
  const entries: SessionHostRelocationManifest['files'] = []
  for (const file of files) {
    checkPath(file.path)
    if (seen.has(file.path)) {
      throw refuseRelocation('invalid-request', `${file.path} appears twice. Nothing was moved.`)
    }
    seen.add(file.path)
    entries.push({ path: file.path, ...(await relocationFileDigest(file.absolute, file.path)) })
  }
  const unsigned = { version: 1 as const, provider, providerSessionId, files: entries }
  return { ...unsigned, digest: sessionHostRelocationManifestDigest(unsigned) }
}

/** The manifest as received: its digest recomputed and every path in bounds before any file is read. */
export function checkRelocationManifest(manifest: SessionHostRelocationManifest): void {
  const { digest, ...unsigned } = manifest
  if (sessionHostRelocationManifestDigest(unsigned) !== digest) {
    throw refuseRelocation(
      'invalid-request',
      'The relocation manifest does not match its own digest. Nothing was staged.'
    )
  }
  const paths = new Set<string>()
  for (const file of manifest.files) {
    checkPath(file.path)
    if (paths.has(file.path)) {
      throw refuseRelocation('invalid-request', `${file.path} appears twice. Nothing was staged.`)
    }
    paths.add(file.path)
  }
}

/**
 * The staged bundle is exactly the manifest: every file present with its size and digest, nothing
 * extra, no links. Complete coverage is what lets staging report the conversation ready.
 */
export async function verifyRelocationBundle(
  root: string,
  manifest: SessionHostRelocationManifest
): Promise<void> {
  checkRelocationManifest(manifest)
  const expected = new Map(manifest.files.map((file) => [file.path, file]))
  let found: RelocationBundleFile[]
  try {
    found = listTopLevel(root)
  } catch (error) {
    if (error instanceof SessionRelocationRefusal) {
      throw error
    }
    throw refuseRelocation(
      'not-eligible',
      'The staged bundle could not be read. Nothing was staged.'
    )
  }
  for (const file of found) {
    if (!expected.has(file.path)) {
      throw refuseRelocation(
        'not-eligible',
        `The staged bundle holds ${file.path}, which its manifest does not list. Nothing was staged.`
      )
    }
  }
  for (const file of manifest.files) {
    const staged = await relocationFileDigest(join(root, ...file.path.split('/')), file.path).catch(
      () => null
    )
    if (!staged || staged.bytes !== file.bytes || staged.sha256 !== file.sha256) {
      throw refuseRelocation(
        'not-eligible',
        `${file.path} did not arrive intact (${staged ? 'its contents differ' : 'it is missing'}). Nothing was staged.`
      )
    }
  }
}

function listTopLevel(root: string): RelocationBundleFile[] {
  return readdirSync(root)
    .sort()
    .flatMap((name) => {
      const absolute = join(root, name)
      const info = lstatSync(absolute)
      if (info.isSymbolicLink()) {
        throw refuseRelocation('not-eligible', `${name} is a symbolic link. Nothing was staged.`)
      }
      return info.isDirectory() ? listRelocationTree(absolute, name) : [{ path: name, absolute }]
    })
}
