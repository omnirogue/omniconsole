import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { getAppEnvironment } from '../../../../shared/app-environment'
import { findJudgeStep } from '../../../../shared/workflow-graph-find'
import type { WorkflowSpec } from '../../../../shared/workflow-graph'
import type { GraphOutcome } from './graph-plan-types'

/** One JEV ballot as a run keeps it: the inputs it judged, what it returned, and why it failed. */
export type GraphJevRecord = {
  /** Digest of the JEV request; a replay with other inputs asks again instead of reusing it. */
  digest: string
  /** Historical replay can reconstruct a run without rereading its former workspace. */
  requestDigest?: string
  outcome: GraphOutcome
  detail?: string
  at: number
}

/** A run's own folder beside its attempts; the id is checked so no path can leave the root. */
export function graphExecutionFolder(executionId: string, root?: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(executionId)) {
    throw new Error('Invalid workflow execution id')
  }
  const base = root ?? join(getAppEnvironment().getPath('userData'), 'local-workflow-attempts')
  return join(base, executionId)
}

/**
 * A run's JEV ballots, beside its attempts (`local-workflow-attempts/<execution>/`). JEV runs no
 * agent, so its ballots live here rather than in the call store: the program writes each once
 * and replays it, and the run view reads the same file, so both always show the same ranking.
 */
// POSIX makes a rename survive power loss only once its folder is synced; Windows cannot open a
// folder to sync it, and NTFS journals the rename itself.
function syncFolder(folder: string): void {
  if (process.platform === 'win32') {
    return
  }
  const handle = openSync(folder, 'r')
  try {
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
}

export class GraphJevStore {
  /** `durable`: each write reaches the disk before it returns (the web call's start marker). */
  constructor(
    private readonly file: string,
    private readonly durable = false
  ) {}

  /** A run's host-answered calls: its JEV ballots (the default), its checks, or checks started. */
  static forExecution(
    executionId: string,
    root?: string,
    file:
      | 'jev-ballots.json'
      | 'checks.json'
      | 'check-starts.json'
      | 'github-facts.json'
      | 'github-harvest.json'
      | 'evidence.json'
      | 'web-sources.json'
      | 'web-calls.json' = 'jev-ballots.json'
  ): GraphJevStore {
    return new GraphJevStore(
      join(graphExecutionFolder(executionId, root), file),
      file === 'web-calls.json'
    )
  }

  all(): Record<string, GraphJevRecord> {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, GraphJevRecord>) : {}
    } catch {
      return {}
    }
  }

  /** The file is there but is no record map: what it held is lost, which is not the same as none. */
  damaged(): boolean {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      return !parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ENOENT'
    }
  }

  read(callId: string): GraphJevRecord | undefined {
    return this.all()[callId]
  }

  write(callId: string, record: GraphJevRecord): void {
    this.save({ ...this.all(), [callId]: record })
  }

  remove(callId: string): void {
    const { [callId]: _removed, ...rest } = this.all()
    this.save(rest)
  }

  private save(next: Record<string, GraphJevRecord>): void {
    mkdirSync(dirname(this.file), { recursive: true })
    // Written whole and renamed into place, so a reader never sees half a file.
    const temporary = `${this.file}.${process.pid}.tmp`
    if (!this.durable) {
      writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 })
      renameSync(temporary, this.file)
      return
    }
    const handle = openSync(temporary, 'w', 0o600)
    try {
      writeSync(handle, JSON.stringify(next))
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
    renameSync(temporary, this.file)
    syncFolder(dirname(this.file))
    syncFolder(dirname(dirname(this.file)))
  }
}

/**
 * A transient JEV screen failure (rate-limited, overloaded, network, timeout) is never cached
 * (graph-jev-screen.ts): only a non-retryable one is ever written, and always with `detail` set.
 * So for a Find run's judge/screen call, a failed run whose store carries no `detail` for that
 * call (whether no record at all, or every recorded page actually succeeded) can only have failed
 * on a page that was never persisted — a retryable, transient miss. Offering Retry for it is safe
 * either way: a page that really did fail for good replays that same failure again, cheaply.
 */
export function graphFindHasRetryableScreenFailure(
  spec: WorkflowSpec,
  store: GraphJevStore
): boolean {
  const judge = spec.find ? findJudgeStep(spec) : undefined
  if (!judge) {
    return false
  }
  const prefix = `${judge.id}/screen`
  const all = store.all()
  const screenRecords = Object.entries(all).filter(
    ([id]) => id === prefix || id.startsWith(`${prefix}/`)
  )
  return screenRecords.every(([, record]) => !record.detail)
}
