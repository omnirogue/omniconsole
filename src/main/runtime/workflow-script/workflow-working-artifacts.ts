import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { redactString } from '../../observability/redactor'
import { runProcess } from '../../../shared/child-process/run-process'

const MAX_FILES = 128
const MAX_FILE_BYTES = 64 * 1024
const MAX_TOTAL_BYTES = 2 * 1024 * 1024
const MAX_DIFF_BYTES = 512 * 1024
const MAX_GIT_OUTPUT = 4 * 1024 * 1024

export type CandidateArtifactFile = {
  relativePath: string
  sha256: string
  contentPreview: string
}

export type CandidateArtifacts = {
  files: CandidateArtifactFile[]
  diff: string
  omissions: { relativePath: string; reason: string }[]
  digest: string
}

export type AnonymousCandidatePacket = {
  label: string
  answer: unknown
  artifacts: CandidateArtifacts
}

function safeRelativePath(path: string): boolean {
  return (
    Boolean(path) &&
    !isAbsolute(path) &&
    path !== '..' &&
    !path.startsWith(`..${sep}`) &&
    !path.split(sep).includes('..') &&
    !path.includes('\0')
  )
}

function excludedPath(path: string): boolean {
  return path
    .split(sep)
    .some((part) =>
      /^(?:\.env(?:\..*)?|\.git|\.npmrc|\.pypirc|\.netrc|\.aws|\.ssh|id_(?:rsa|ed25519)|auth\.json|credentials(?:\.json)?|service-account(?:\.json)?|.*\.(?:pem|p12|pfx|key|secret|secrets))$/i.test(
        part
      )
    )
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runProcess({
    program: 'git',
    args,
    cwd,
    timeoutMs: 15_000,
    maxOutputBytes: MAX_GIT_OUTPUT
  })
  if (result.code !== 0 || result.timedOut || result.stdoutTruncated || result.stderrTruncated) {
    throw new Error('Candidate Git inspection failed or exceeded its output limit')
  }
  return result.stdout
}

function digestOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** Capture an exact, bounded copy of changed text files from one private child worktree. */
export async function captureCandidateArtifacts(
  childWorktreePath: string,
  baseRevision: string
): Promise<CandidateArtifacts> {
  if (!/^[0-9a-f]{40,64}$/i.test(baseRevision)) {
    throw new Error('Candidate base revision must be a pinned commit hash')
  }
  if (!(await lstat(childWorktreePath)).isDirectory()) {
    throw new Error('Candidate worktree path changed')
  }
  const root = await realpath(childWorktreePath)
  let topLevel: string
  try {
    topLevel = await realpath((await git(root, ['rev-parse', '--show-toplevel'])).trim())
  } catch {
    throw new Error('Candidate path is not the worktree root')
  }
  if (topLevel !== root) {
    throw new Error('Candidate path is not the worktree root')
  }
  const resolvedBase = (
    await git(root, ['rev-parse', '--verify', `${baseRevision}^{commit}`])
  ).trim()
  if (resolvedBase.toLowerCase() !== baseRevision.toLowerCase()) {
    throw new Error('Candidate base revision is ambiguous')
  }
  const changed = (
    await git(root, ['diff', '--name-only', '-z', '--no-renames', baseRevision, '--'])
  )
    .split('\0')
    .filter(Boolean)
  const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z']))
    .split('\0')
    .filter(Boolean)
  const paths = [...new Set([...changed, ...untracked])].sort()
  const files: CandidateArtifactFile[] = []
  const omissions: CandidateArtifacts['omissions'] = []
  let totalBytes = 0
  let diffBytes = 0
  const diffs: string[] = []
  for (const path of paths) {
    if (!safeRelativePath(path)) {
      throw new Error('Git returned an unsafe candidate path')
    }
    if (excludedPath(path)) {
      omissions.push({ relativePath: path, reason: 'private configuration' })
      continue
    }
    if (files.length >= MAX_FILES) {
      omissions.push({ relativePath: path, reason: 'file count limit' })
      continue
    }
    const absolute = join(root, path)
    let details
    try {
      details = await lstat(absolute)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        omissions.push({ relativePath: path, reason: 'deleted file' })
        continue
      }
      throw error
    }
    if (
      !details.isFile() ||
      (await realpath(absolute)) !== absolute ||
      !relative(root, absolute) ||
      relative(root, absolute).startsWith(`..${sep}`)
    ) {
      omissions.push({ relativePath: path, reason: 'nonregular or redirected file' })
      continue
    }
    if (details.size > MAX_FILE_BYTES || totalBytes + details.size > MAX_TOTAL_BYTES) {
      omissions.push({ relativePath: path, reason: 'content size limit' })
      continue
    }
    const bytes = await readFile(absolute)
    if (bytes.length !== details.size || bytes.includes(0)) {
      omissions.push({ relativePath: path, reason: 'changed or binary file' })
      continue
    }
    let contentPreview: string
    try {
      contentPreview = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      omissions.push({ relativePath: path, reason: 'non-UTF-8 file' })
      continue
    }
    if (redactString(contentPreview) !== contentPreview) {
      omissions.push({ relativePath: path, reason: 'protected credential content' })
      continue
    }
    files.push({
      relativePath: path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      contentPreview
    })
    totalBytes += bytes.length
    if (changed.includes(path)) {
      const diff = await git(root, [
        'diff',
        '--no-ext-diff',
        '--no-renames',
        baseRevision,
        '--',
        path
      ])
      const size = Buffer.byteLength(diff)
      if (redactString(diff) !== diff) {
        omissions.push({ relativePath: path, reason: 'diff contains protected credential content' })
      } else if (diffBytes + size <= MAX_DIFF_BYTES) {
        diffs.push(diff)
        diffBytes += size
      } else {
        omissions.push({ relativePath: path, reason: 'diff size limit; file content retained' })
      }
    }
    const current = await lstat(absolute)
    if (
      !current.isFile() ||
      current.dev !== details.dev ||
      current.ino !== details.ino ||
      (await realpath(absolute)) !== absolute ||
      !bytes.equals(await readFile(absolute))
    ) {
      throw new Error(`Candidate file changed during capture: ${path}`)
    }
  }
  const value = { files, diff: diffs.join(''), omissions }
  return { ...value, digest: digestOf(value) }
}

/** Reject identifying metadata before candidate material enters blind peer prompts. */
export function anonymousCandidatePacket(
  answer: unknown,
  artifacts: CandidateArtifacts,
  label: string
): AnonymousCandidatePacket {
  if (
    !/^Response [A-Z]$/.test(label) ||
    digestOf({ files: artifacts.files, diff: artifacts.diff, omissions: artifacts.omissions }) !==
      artifacts.digest
  ) {
    throw new Error('Candidate packet label or artifact digest is invalid')
  }
  const contents = JSON.stringify({ answer, artifacts })
  if (
    /(?:\/Users\/|\/home\/|\/private\/tmp\/|[A-Z]:\\Users\\)/i.test(contents) ||
    /\b(?:i am|i'm|i’m|generated by|written by|as an agent from)\s+(?:openai|anthropic|xai|claude|codex|grok|gemini|kimi)\b/i.test(
      contents
    ) ||
    /\b(?:claude|codex|grok|gemini|kimi)\s+(?:model|agent|account|session|worktree)\b/i.test(
      contents
    ) ||
    /\bseat-[a-z0-9_-]+\b/i.test(contents)
  ) {
    throw new Error('Candidate output contains identifying metadata; blind review cannot proceed')
  }
  return { label, answer, artifacts }
}
