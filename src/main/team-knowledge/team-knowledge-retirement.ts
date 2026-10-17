import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { writeFileAtomicallyIfUnchanged } from '../codex-accounts/fs-utils'

export const TEAM_KNOWLEDGE_MARKER_START = '<!-- omni-team-knowledge:start -->'
export const TEAM_KNOWLEDGE_MARKER_END = '<!-- omni-team-knowledge:end -->'
const MAX_FILE_BYTES = 2 * 1024 * 1024
const VERSION = 1
type Target = {
  path: string
  status: 'missing' | 'unmanaged' | 'ready' | 'invalid' | 'removed'
  beforeSha: string | null
  afterSha: string | null
  removedBytes: number
  reason?: string
  backup?: string
}
type Snapshot = { target: Target; before?: string; after?: string; mode?: number }
export type RetirementReport = {
  version: number
  status: 'disabled' | 'dry-run' | 'blocked' | 'complete'
  targets: Target[]
  reason?: string
}

export function teamKnowledgeTargets(home: string = homedir()): string[] {
  return ['.claude/CLAUDE.md', '.codex/AGENTS.md', '.grok/AGENTS.md', '.gemini/GEMINI.md'].map(
    (path) => join(home, ...path.split('/'))
  )
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex')

function inspect(path: string): Snapshot {
  const target: Target = {
    path,
    status: 'invalid',
    beforeSha: null,
    afterSha: null,
    removedBytes: 0
  }
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) {
      return { target: { ...target, reason: 'Expected a bounded regular instruction file.' } }
    }
    const bytes = readFileSync(path)
    const before = bytes.toString('utf8')
    if (bytes.length > MAX_FILE_BYTES || !Buffer.from(before).equals(bytes)) {
      return { target: { ...target, reason: 'Instruction file is not valid UTF-8.' } }
    }
    target.beforeSha = sha(before)
    target.afterSha = target.beforeSha
    const starts = before.split(TEAM_KNOWLEDGE_MARKER_START).length - 1
    const ends = before.split(TEAM_KNOWLEDGE_MARKER_END).length - 1
    if (starts === 0 && ends === 0) {
      return { target: { ...target, status: 'unmanaged' } }
    }
    const start = before.indexOf(TEAM_KNOWLEDGE_MARKER_START)
    const end = before.indexOf(TEAM_KNOWLEDGE_MARKER_END)
    const afterStart = before.slice(start + TEAM_KNOWLEDGE_MARKER_START.length)
    if (
      starts !== 1 ||
      ends !== 1 ||
      end < start ||
      (start > 0 && before[start - 1] !== '\n') ||
      !/^(\r?\n)/.test(afterStart) ||
      before[end - 1] !== '\n'
    ) {
      return {
        target: { ...target, reason: 'Managed markers must be one ordered standalone pair.' }
      }
    }
    let afterEnd = end + TEAM_KNOWLEDGE_MARKER_END.length
    if (before.slice(afterEnd, afterEnd + 2) === '\r\n') {
      afterEnd += 2
    } else if (before[afterEnd] === '\n') {
      afterEnd += 1
    } else if (afterEnd !== before.length) {
      return { target: { ...target, reason: 'Managed end marker is not on its own line.' } }
    }
    const after = before.slice(0, start) + before.slice(afterEnd)
    return {
      target: {
        ...target,
        status: 'ready',
        afterSha: sha(after),
        removedBytes: Buffer.byteLength(before) - Buffer.byteLength(after)
      },
      before,
      after,
      mode: stat.mode
    }
  } catch (error) {
    return {
      target: {
        ...target,
        ...((error as NodeJS.ErrnoException).code === 'ENOENT'
          ? { status: 'missing' as const }
          : { reason: 'Instruction file could not be inspected.' })
      }
    }
  }
}

function writeReport(path: string, report: RetirementReport): void {
  const next = `${JSON.stringify(report, null, 2)}\n`
  let previous: string | null = null
  try {
    previous = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
  if (!writeFileAtomicallyIfUnchanged(path, previous, next, { mode: 0o600 })) {
    throw new Error('Retirement report changed concurrently; rerun the dry-run.')
  }
}

/** The apply launch requires the exact prior dry-run; no instruction bodies enter receipts. */
export function retireTeamKnowledge(options: {
  userDataPath: string
  home?: string
  env?: NodeJS.ProcessEnv
}): RetirementReport {
  const env = options.env ?? process.env
  const mode = env.OMNI_TEAM_KNOWLEDGE_RETIREMENT
  if (
    env.OMNI_TEAM_KNOWLEDGE_RETIREMENT_DISABLED === '1' ||
    !['dry-run', 'apply'].includes(mode ?? '')
  ) {
    return { version: VERSION, status: 'disabled', targets: [] }
  }
  const root = join(options.userDataPath, 'team-knowledge-retirement')
  const snapshots = teamKnowledgeTargets(options.home).map(inspect)
  const report: RetirementReport = {
    version: VERSION,
    status: 'dry-run',
    targets: snapshots.map((s) => s.target)
  }
  mkdirSync(root, { recursive: true, mode: 0o700 })
  if (report.targets.some((t) => t.status === 'invalid')) {
    report.status = 'blocked'
    report.reason = 'No files changed: resolve invalid markers or file access and repeat dry-run.'
  }
  const dryRunPath = join(root, 'dry-run.json')
  if (mode === 'dry-run') {
    writeReport(dryRunPath, report)
    return report
  }
  const resultPath = join(root, 'result.json')
  try {
    const completed = JSON.parse(readFileSync(resultPath, 'utf8')) as RetirementReport
    if (
      completed.version === VERSION &&
      completed.status === 'complete' &&
      completed.targets.length === report.targets.length &&
      completed.targets.every(
        (target, index) =>
          target.path === report.targets[index].path &&
          target.afterSha === report.targets[index].beforeSha &&
          ['missing', 'unmanaged'].includes(report.targets[index].status)
      )
    ) {
      return completed
    }
  } catch {
    /* no verified completion */
  }
  let prior: RetirementReport | undefined
  try {
    prior = JSON.parse(readFileSync(dryRunPath, 'utf8')) as RetirementReport
  } catch {
    /* require dry-run */
  }
  if (
    report.status === 'blocked' ||
    prior?.version !== VERSION ||
    prior.status !== 'dry-run' ||
    JSON.stringify(prior.targets) !== JSON.stringify(report.targets)
  ) {
    return {
      ...report,
      status: 'blocked',
      reason: 'A matching successful dry-run is required before apply.'
    }
  }
  try {
    for (const snapshot of snapshots) {
      if (snapshot.target.status !== 'ready') {
        continue
      }
      if (env.OMNI_TEAM_KNOWLEDGE_RETIREMENT_DISABLED === '1') {
        throw new Error('Retirement kill switch is active.')
      }
      const { target, before, after, mode: fileMode } = snapshot
      const current = inspect(target.path)
      if (JSON.stringify(current.target) !== JSON.stringify(target)) {
        throw new Error('Instruction file changed after dry-run.')
      }
      const backup = join(root, `${basename(target.path)}.${target.beforeSha}.bak`)
      try {
        writeFileSync(backup, before!, { flag: 'wx', mode: 0o600 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error
        }
      }
      if (
        !lstatSync(backup).isFile() ||
        lstatSync(backup).isSymbolicLink() ||
        readFileSync(backup, 'utf8') !== before
      ) {
        throw new Error('Backup does not match the original instruction file.')
      }
      target.backup = backup
      if (!writeFileAtomicallyIfUnchanged(target.path, before!, after!, { mode: fileMode })) {
        throw new Error('Instruction file changed during retirement.')
      }
      if (sha(readFileSync(target.path, 'utf8')) !== target.afterSha) {
        throw new Error('Retirement verification failed.')
      }
      target.status = 'removed'
    }
    report.status = 'complete'
  } catch (error) {
    report.status = 'blocked'
    report.reason = error instanceof Error ? error.message : 'Retirement failed.'
  }
  writeReport(resultPath, report)
  return report
}
