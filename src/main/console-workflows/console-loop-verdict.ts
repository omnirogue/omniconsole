import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, posix, relative } from 'node:path'
import type {
  ConsoleLocalJob,
  ConsoleWorkflowLoopVerdict
} from './console-local-execution-contract'

const maxVerdictBytes = 65_536
const maxItems = 32
const maxItemText = 256
const maxNotesText = 512

/** A loop reviewer must produce the graph-owned verdict; the hub handoff may still omit its directory. */
export function consoleLoopVerdictRequired(job: ConsoleLocalJob): boolean {
  return (
    job.action === 'review' &&
    job.inputs.some(
      (value) =>
        !!value && typeof value === 'object' && !Array.isArray(value) && 'loop_stage' in value
    )
  )
}

/** Why null for a required verdict: an absent, ambiguous, or escaping root fails closed as a recorded result, never as an unrecordable throw. */
export function consoleLoopVerdictRelativePath(job: ConsoleLocalJob): string | null {
  if (!consoleLoopVerdictRequired(job)) {
    return null
  }
  const roots = (job.ownedPaths ?? [])
    .filter((path) => path.endsWith('/**'))
    .map((path) => path.slice(0, -3))
  if (roots.length !== 1) {
    return null
  }
  const artifactRoot = roots[0]!
  const path = posix.normalize(posix.join(artifactRoot, 'verdict.json'))
  if (
    artifactRoot.includes('\\') ||
    posix.isAbsolute(path) ||
    path === '..' ||
    path.startsWith('../')
  ) {
    return null
  }
  return path
}

export const consoleLoopVerdictContractMessage =
  'The loop reviewer handoff admits no single canonical verdict directory (owned_paths must name exactly one "<dir>/**" inside the worktree).'

/** Refuse before any hub claim or worker start; a reviewer that can never record a verdict must not run. */
export function assertConsoleLoopVerdictContract(job: ConsoleLocalJob): void {
  if (consoleLoopVerdictRequired(job) && !consoleLoopVerdictRelativePath(job)) {
    throw new Error(consoleLoopVerdictContractMessage)
  }
}

/** The failed-result note when a required verdict is absent. */
export function consoleLoopVerdictFailure(job: ConsoleLocalJob): string {
  return consoleLoopVerdictRelativePath(job)
    ? 'The canonical loop verdict file is missing or malformed.'
    : consoleLoopVerdictContractMessage
}

function texts(value: unknown): string[] | null {
  if (
    !Array.isArray(value) ||
    value.length > maxItems ||
    value.some(
      (item) =>
        typeof item !== 'string' || item.length > maxItemText || !item.trim() || item.includes('\0')
    )
  ) {
    return null
  }
  return [...new Set(value.map((item) => item.trim()))]
}

/** Read the graph-owned file itself; terminal prose and native review markers are never verdicts. */
export async function readConsoleLoopVerdict(
  job: ConsoleLocalJob,
  cwd: string
): Promise<ConsoleWorkflowLoopVerdict | null> {
  const path = consoleLoopVerdictRelativePath(job)
  if (!path) {
    return null
  }
  try {
    const root = await realpath(cwd)
    const target = join(root, ...path.split('/'))
    const info = await lstat(target)
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxVerdictBytes) {
      return null
    }
    const resolved = await realpath(target)
    const within = relative(root, resolved)
    if (
      !within ||
      isAbsolute(within) ||
      within === '..' ||
      within.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    ) {
      return null
    }
    const value = JSON.parse(await readFile(resolved, 'utf8')) as Record<string, unknown>
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => !['verdict', 'blockers', 'gaps', 'notes'].includes(key))
    ) {
      return null
    }
    const verdict = typeof value.verdict === 'string' ? value.verdict.trim().toLowerCase() : ''
    const blockers = texts(value.blockers)
    const gaps = texts(value.gaps)
    if (
      (verdict !== 'agree' && verdict !== 'disagree') ||
      blockers === null ||
      gaps === null ||
      typeof value.notes !== 'string' ||
      value.notes.length > maxNotesText ||
      value.notes.includes('\0')
    ) {
      return null
    }
    return {
      verdict,
      blockers,
      gaps,
      notes: value.notes
    }
  } catch {
    return null
  }
}
