/**
 * Builds the wake copy of a session asleep on its review (PLAN section 4): relocate's export of the
 * conversation, and for a `~/Work` folder up to 20 MB of the files the session wrote. Only a
 * workspace another computer can have moves: a folder inside `~/Work`, or a clean git worktree
 * whose branch head is exactly on origin. Anything else says why, in OmniOS's fixed words.
 */

import { lstat, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, isAbsolute, join, relative, sep } from 'node:path'
import type {
  ArtifactReviewSleep,
  ArtifactReviewSleepWorkspace,
  WakeCopyRefusal
} from '../../shared/artifact-review-sleep'
import { isRelocationManifestPath } from '../../shared/session-host-payload-schema'
import { gitExecFileAsync } from '../git/runner'
import { exportRelocationBundle } from '../session-relocation/relocation-bundle-import'
import { isCredentialShapedPath } from '../session-relocation/relocation-bundle-files'
import {
  packWakeCopy,
  WAKE_COPY_MAX_BYTES,
  type WakeCopyFile,
  type WakeCopyHeader,
  type WakeCopyWorkspace
} from './review-wake-copy-pack'

const WRITTEN_MAX_BYTES = 20 * 1024 * 1024
/** A network git call never holds the review pass longer than this. */
export const WAKE_COPY_GIT_NETWORK_TIMEOUT_MS = 30_000
// Why an allowlist: a folder session writes documents and code; configs and keys stay home.
const WRITTEN_TYPES = new Set(
  'md markdown txt html htm css csv tsv svg png jpg jpeg gif webp pdf ts tsx js jsx mjs cjs py rb go rs java kt swift sql ipynb'.split(
    ' '
  )
)
const IMAGE_TYPES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf'])
const SECRET_NAMES =
  /(credential|service[-_]?account|kubeconfig|\.kdbx$|\.npmrc$|\.pypirc$|\.pgpass$|\.htpasswd$|\.dockercfg$|private[-_]?key)/i
const TEXT_SCAN_MAX_BYTES = 2 * 1024 * 1024
// Why key shapes, not words: ordinary code says `token: string`; a real key looks like one of these.
const SECRET_TEXT = new RegExp(
  [
    '-----BEGIN [A-Z ]*PRIVATE KEY-----',
    'sk-ant-[A-Za-z0-9_-]{20,}',
    'sk-(?:proj-)?[A-Za-z0-9_-]{32,}',
    'gh[pousr]_[A-Za-z0-9]{36,}',
    'github_pat_[A-Za-z0-9_]{40,}',
    'glpat-[A-Za-z0-9_-]{20,}',
    'xox[abpr]-[A-Za-z0-9-]{10,}',
    'AKIA[0-9A-Z]{16}',
    'AIza[0-9A-Za-z_-]{35}',
    'odt_[A-Za-z0-9_-]{20,}',
    'whsec_[A-Za-z0-9]{24,}',
    '[rs]k_(?:live|test)_[0-9A-Za-z]{20,}',
    'EAA[0-9A-Za-z]{90,}',
    'eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}',
    '[a-z][a-z0-9+.-]*://[^/\\s:@]+:[^/\\s@]+@'
  ].join('|'),
  // Why case-insensitive: a URL scheme (`POSTGRES://`) is; the key shapes are long enough either way.
  'i'
)

type Refused = { refused: WakeCopyRefusal }

/** The folder relative to `~/Work` with `/` separators; '' is `~/Work` itself; null outside it. */
export async function workRelativePath(folder: string, home = homedir()): Promise<string | null> {
  const work = await realpath(join(home, 'Work')).catch(() => null)
  const target = await realpath(folder).catch(() => null)
  if (!work || !target) {
    return null
  }
  const rel = relative(work, target)
  if (rel === '') {
    return ''
  }
  const path = rel.split(sep).join('/')
  return !isAbsolute(rel) && isRelocationManifestPath(path) ? path : null
}

async function git(cwd: string, args: string[], timeout?: number): Promise<string> {
  return (await gitExecFileAsync(args, { cwd, ...(timeout ? { timeout } : {}) })).stdout.trim()
}

/** The head origin lists for exactly `refs/heads/<branch>`, or '' when it has none. */
export function listedHead(listing: string, branch: string): string {
  const line = listing
    .split('\n')
    .map((entry) => entry.trim().split(/\s+/))
    .find(([, ref]) => ref === `refs/heads/${branch}`)
  return line?.[0] ?? ''
}

/** Strips any user and password from a URL remote (null when it cannot be read); scp-style stays. */
export function publicRemoteUrl(url: string): string | null {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    return url
  }
  try {
    const parsed = new URL(url)
    parsed.username = ''
    parsed.password = ''
    return parsed.toString()
  } catch {
    return null
  }
}

async function gitWorkspace(path: string): Promise<{ workspace: WakeCopyWorkspace } | Refused> {
  try {
    if ((await git(path, ['status', '--porcelain'])) !== '') {
      return { refused: 'uncommitted changes' }
    }
    const branch = await git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')
    const remoteUrl = await git(path, ['remote', 'get-url', 'origin']).catch(() => '')
    if (!branch || !remoteUrl) {
      return { refused: 'unpushed changes' }
    }
    const commit = await git(path, ['rev-parse', 'HEAD'])
    const listed = await git(
      path,
      ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`],
      WAKE_COPY_GIT_NETWORK_TIMEOUT_MS
    )
    // Why exactly equal: the other computer checks out this commit, not a newer push.
    if (listedHead(listed, branch) !== commit) {
      return { refused: 'unpushed changes' }
    }
    const shown = publicRemoteUrl(remoteUrl)
    return shown
      ? { workspace: { kind: 'git', remoteUrl: shown, branch, commit } }
      : { refused: 'could not verify' }
  } catch {
    return { refused: 'could not verify' }
  }
}

export async function wakeCopyWorkspace(
  workspace: ArtifactReviewSleepWorkspace | undefined,
  home = homedir()
): Promise<{ workspace: WakeCopyWorkspace } | Refused> {
  if (!workspace) {
    return { refused: 'could not verify' }
  }
  if (workspace.kind === 'git') {
    return gitWorkspace(workspace.path)
  }
  const workRelative = await workRelativePath(workspace.path, home)
  return workRelative === null
    ? { refused: 'outside Work' }
    : { workspace: { kind: 'folder', workRelativePath: workRelative } }
}

/**
 * Documents, code and images only; never a secret by name, nor text holding a key. Returns the
 * exact bytes it checked (they are what is packed), or null.
 */
async function shareableWrittenFile(
  absolute: string,
  rel: string,
  size: number
): Promise<Buffer | null> {
  const type = extname(rel).slice(1).toLowerCase()
  if (!WRITTEN_TYPES.has(type) || isCredentialShapedPath(rel) || SECRET_NAMES.test(rel)) {
    return null
  }
  if (!IMAGE_TYPES.has(type) && size > TEXT_SCAN_MAX_BYTES) {
    return null
  }
  const bytes = await readFile(absolute).catch(() => null)
  return bytes && (IMAGE_TYPES.has(type) || !SECRET_TEXT.test(bytes.toString('utf8')))
    ? bytes
    : null
}

/** Newest first, regular files inside the folder only, never credential-shaped, 20 MB at most. */
export async function wakeCopyWrittenFiles(
  paths: readonly string[],
  folder: string
): Promise<WakeCopyFile[]> {
  const root = await realpath(folder).catch(() => null)
  if (!root) {
    return []
  }
  const files: WakeCopyFile[] = []
  let total = 0
  for (const absolute of paths.toReversed()) {
    const info = await lstat(absolute).catch(() => null)
    const real = info?.isFile() ? await realpath(absolute).catch(() => null) : null
    const rel = real ? relative(root, real).split(sep).join('/') : ''
    if (
      !info ||
      !real ||
      isAbsolute(relative(root, real)) ||
      !isRelocationManifestPath(rel) ||
      files.some((file) => file.path === rel) ||
      total + info.size > WRITTEN_MAX_BYTES
    ) {
      continue
    }
    const bytes = await shareableWrittenFile(real, rel, info.size)
    if (!bytes || total + bytes.length > WRITTEN_MAX_BYTES) {
      continue
    }
    total += bytes.length
    files.push({ path: rel, absolute: real, bytes })
  }
  return files
}

export type BuiltWakeCopy = { blob: Buffer; sha256: string; header: WakeCopyHeader }

export async function buildWakeCopy(input: {
  slug: string
  title: string | null
  sessionId: string
  sleep: ArtifactReviewSleep
  host: string
  writtenPaths: readonly string[]
  home?: string
}): Promise<BuiltWakeCopy | Refused> {
  const { sleep } = input
  if (!sleep.transcriptPath) {
    return { refused: 'could not verify' }
  }
  const place = await wakeCopyWorkspace(sleep.workspace, input.home)
  if ('refused' in place) {
    return place
  }
  const exported = await exportRelocationBundle(sleep.provider, {
    sessionId: input.sessionId,
    transcriptPath: sleep.transcriptPath
  }).catch(() => null)
  if (!exported) {
    return { refused: 'could not verify' }
  }
  const raw = exported.manifest.files.reduce((sum, file) => sum + file.bytes, 0)
  if (raw > WAKE_COPY_MAX_BYTES * 4) {
    return { refused: 'too large' }
  }
  const written =
    place.workspace.kind === 'folder' && sleep.workspace
      ? await wakeCopyWrittenFiles(input.writtenPaths, sleep.workspace.path)
      : []
  const packed = await packWakeCopy({
    header: {
      version: 1,
      slug: input.slug,
      revision: sleep.revision,
      provider: sleep.provider,
      sessionId: input.sessionId,
      title: input.title,
      model: sleep.model ?? null,
      effort: sleep.effort ?? null,
      writerVersion: exported.writerVersion,
      host: input.host,
      workspace: place.workspace,
      manifest: exported.manifest
    },
    conversation: exported.files,
    written
  })
  return packed.blob.length > WAKE_COPY_MAX_BYTES ? { refused: 'too large' } : packed
}
