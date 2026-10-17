import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment, hasAppEnvironment } from '../../../shared/app-environment'
import {
  isBuildReviewActive,
  type BuildReviewPipelineSnapshot
} from '../../../shared/build-review-pipeline'
import { normalizeLegacyCheckedFindings } from '../../../shared/review-findings'
import { durableWriteTempPath, writeFileDurableSync } from '../../durable-file-write'
import { cloneSnapshot, pushEvent, setStage } from './build-review-pipeline-state'

/** Directory under userData holding one JSON file per Build + Review run. */
export const BUILD_REVIEW_PIPELINES_DIRECTORY = 'build-review-pipelines'

export const BUILD_REVIEW_RESTART_ERROR =
  'The app restarted while this run was going, so it stopped. Choose Retry to run it again.'
const WORKER_RESTART_ERROR = 'The app restarted before this agent finished.'

const PIPELINE_FILE = /^(brp_[A-Za-z0-9_-]+)\.json$/
const DEBOUNCE_MS = 250

type Logger = (message: string, detail?: unknown) => void

function defaultLogger(message: string, detail?: unknown): void {
  console.warn(`[build-review] ${message}`, detail ?? '')
}

/**
 * A run the previous process died inside. Its coordinator, workers and abort controller did not
 * survive, so it cannot be resumed; it is failed, in words, and can be retried. Returns whether
 * the snapshot changed.
 */
export function repairBuildReviewPipelineAfterRestart(
  pipeline: BuildReviewPipelineSnapshot
): boolean {
  if (!isBuildReviewActive(pipeline.stage)) {
    return false
  }
  for (const worker of [pipeline.builder, pipeline.reviewer, ...(pipeline.reviewers ?? [])]) {
    if (worker.status === 'starting' || worker.status === 'running') {
      worker.status = 'failed'
      worker.error = WORKER_RESTART_ERROR
    }
  }
  pipeline.pendingQuestion = null
  pipeline.pendingQuestions = []
  pipeline.error = BUILD_REVIEW_RESTART_ERROR
  pushEvent(pipeline, 'error', 'pipeline', BUILD_REVIEW_RESTART_ERROR)
  setStage(pipeline, 'failed')
  return true
}

function normalizeLegacyFindings(pipeline: BuildReviewPipelineSnapshot): void {
  const rounds = Array.isArray(pipeline.rounds) ? pipeline.rounds : []
  const workers = [
    pipeline.reviewer,
    ...(pipeline.reviewers ?? []),
    ...rounds.flatMap((round) => round.reviewers ?? [])
  ]
  workers.forEach((worker) => normalizeLegacyCheckedFindings(worker?.findings))
}

function isPipelineShape(value: unknown, id: string): value is BuildReviewPipelineSnapshot {
  if (!value || typeof value !== 'object') {
    return false
  }
  const candidate = value as Partial<BuildReviewPipelineSnapshot>
  return (
    candidate.id === id &&
    typeof candidate.worktree === 'string' &&
    typeof candidate.objective === 'string' &&
    typeof candidate.stage === 'string' &&
    !!candidate.builder &&
    !!candidate.reviewer &&
    Array.isArray(candidate.events) &&
    typeof candidate.createdAt === 'string' &&
    typeof candidate.updatedAt === 'string'
  )
}

/**
 * Every Build + Review run on disk, so a restart shows each one as it ended instead of a run
 * the host no longer knows. Personal state: nothing here is claimed or dispatched.
 */
export class BuildReviewPipelineStore {
  private readonly pending = new Map<string, BuildReviewPipelineSnapshot>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private directoryReady = false

  constructor(
    private readonly directory: string,
    private readonly log: Logger = defaultLogger
  ) {}

  /** Read every stored run, repairing the ones the previous process died inside. */
  load(): BuildReviewPipelineSnapshot[] {
    let names: string[]
    try {
      names = readdirSync(this.directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log(`Could not read ${this.directory}`, error)
      }
      return []
    }
    const loaded: BuildReviewPipelineSnapshot[] = []
    for (const name of names) {
      const id = PIPELINE_FILE.exec(name)?.[1]
      const pipeline = id ? this.read(join(this.directory, name), id) : null
      if (!pipeline) {
        continue
      }
      if (repairBuildReviewPipelineAfterRestart(pipeline)) {
        this.write(pipeline)
      }
      loaded.push(pipeline)
    }
    return loaded
  }

  /** A settled run is written before this returns; a live one at most every 250 ms. */
  save(pipeline: BuildReviewPipelineSnapshot): void {
    if (!isBuildReviewActive(pipeline.stage)) {
      this.pending.delete(pipeline.id)
      this.write(pipeline)
      return
    }
    this.pending.set(pipeline.id, pipeline)
    this.timer ??= setTimeout(() => this.flush(), DEBOUNCE_MS)
    this.timer.unref?.()
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const queued = [...this.pending.values()]
    this.pending.clear()
    queued.forEach((pipeline) => this.write(pipeline))
  }

  remove(id: string): void {
    this.pending.delete(id)
    if (PIPELINE_FILE.test(`${id}.json`)) {
      try {
        rmSync(join(this.directory, `${id}.json`), { force: true })
      } catch (error) {
        this.log(`Could not remove run ${id}`, error)
      }
    }
  }

  private read(path: string, id: string): BuildReviewPipelineSnapshot | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
      if (isPipelineShape(parsed, id)) {
        normalizeLegacyFindings(parsed)
        return parsed
      }
      this.log(`Skipping ${path}: it is not a Build + Review run`)
    } catch (error) {
      this.log(`Skipping unreadable run file ${path}`, error)
    }
    return null
  }

  /**
   * Write now and say whether it landed: an admission decision must be on disk before anything
   * acts on it, so this throws where the best-effort `save` only logs. Drops a queued save.
   */
  persist(pipeline: BuildReviewPipelineSnapshot): void {
    this.pending.delete(pipeline.id)
    this.writeNow(pipeline)
  }

  private write(pipeline: BuildReviewPipelineSnapshot): void {
    try {
      this.writeNow(pipeline)
    } catch (error) {
      this.log(`Could not persist run ${pipeline.id}`, error)
    }
  }

  private writeNow(pipeline: BuildReviewPipelineSnapshot): void {
    if (!PIPELINE_FILE.test(`${pipeline.id}.json`)) {
      throw new Error(`Refusing to write run ${pipeline.id}: unexpected id`)
    }
    const path = join(this.directory, `${pipeline.id}.json`)
    if (!this.directoryReady) {
      mkdirSync(this.directory, { recursive: true })
      this.directoryReady = true
    }
    // Clone first: the execution keeps mutating the live snapshot.
    // Strict: `persist` is a barrier, so a real directory-sync failure must reach the caller.
    writeFileDurableSync(
      durableWriteTempPath(path),
      path,
      JSON.stringify(cloneSnapshot(pipeline)),
      {
        strictDirectorySync: true
      }
    )
  }
}

/** The desktop host's userData directory for runs; null where no app environment is installed. */
export function defaultBuildReviewPipelineDirectory(): string | null {
  if (!hasAppEnvironment()) {
    return null
  }
  try {
    return join(getAppEnvironment().getPath('userData'), BUILD_REVIEW_PIPELINES_DIRECTORY)
  } catch {
    return null
  }
}
