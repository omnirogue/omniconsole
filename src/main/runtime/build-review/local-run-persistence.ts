import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  getAppEnvironment,
  hasAppEnvironment,
  type AppEnvironment
} from '../../../shared/app-environment'
import { LOCAL_RUN_NODE_STATES } from '../../../shared/local-run-node-state'
import type { LocalRunSnapshot, LocalRunStage } from '../../../shared/local-run-types'
import { durableWriteTempPath, writeFileDurableSync } from '../../durable-file-write'
import { cloneLocalRunSnapshot, pushLocalRunEvent, setLocalRunStage } from './local-run-state'

/** Directory name under userData holding one JSON file per local run. */
export const LOCAL_RUNS_DIRECTORY = 'local-runs'

/** Node/run error recorded for work the previous process was still executing when it died. */
export const LOCAL_RUN_RESTART_ERROR = 'app_restart'

export const LOCAL_RUN_RESTART_EVENT =
  'The app restarted while this run was active, so it could not be resumed.'

/**
 * How long a change made while the run is executing may sit unwritten. A running run
 * mutates on every worker turn, so writing each one straight through would fsync
 * dozens of times a second. Every other stage — `created` and the three terminal
 * ones — is written before `save` returns, because those are the states a person
 * quits on and none of them churns.
 */
const DEBOUNCE_MS = 250

const RUN_FILE = /^(lrn_[A-Za-z0-9_-]+)\.json$/
const STAGES: readonly LocalRunStage[] = [
  'created',
  'starting',
  'running',
  'completed',
  'failed',
  'cancelled'
]

export type LocalRunStoreLogger = (message: string, detail?: unknown) => void

function defaultLogger(message: string, detail?: unknown): void {
  console.warn(`[local-runs] ${message}`, detail ?? '')
}

/**
 * A stage that only a live process can hold. `created` is deliberately excluded:
 * nothing was started, so the run survives a restart untouched and stays startable.
 */
function wasExecuting(stage: LocalRunStage): boolean {
  return stage === 'starting' || stage === 'running'
}

/**
 * Mark a run the previous process died inside as failed. Local runs hold live worker
 * terminals and an abort controller, none of which survive the process, so resuming
 * one is not possible — saying so is the only honest answer. Returns whether the
 * snapshot was changed.
 */
export function repairLocalRunAfterRestart(snapshot: LocalRunSnapshot): boolean {
  if (!wasExecuting(snapshot.stage)) {
    return false
  }
  for (const node of snapshot.nodes) {
    if (node.state === 'running' || node.state === 'reviewing') {
      node.state = 'failed'
      node.error = LOCAL_RUN_RESTART_ERROR
    }
  }
  snapshot.error ??= LOCAL_RUN_RESTART_ERROR
  pushLocalRunEvent(snapshot, 'error', 'run', LOCAL_RUN_RESTART_EVENT)
  setLocalRunStage(snapshot, 'failed')
  return true
}

function isSnapshotShape(value: unknown, id: string): value is LocalRunSnapshot {
  if (!value || typeof value !== 'object') {
    return false
  }
  const candidate = value as Partial<LocalRunSnapshot>
  return (
    candidate.id === id &&
    typeof candidate.workspacePath === 'string' &&
    typeof candidate.stage === 'string' &&
    STAGES.includes(candidate.stage) &&
    Array.isArray(candidate.nodes) &&
    candidate.nodes.every(
      (node) =>
        !!node &&
        typeof node.id === 'string' &&
        LOCAL_RUN_NODE_STATES.includes(node.state as (typeof LOCAL_RUN_NODE_STATES)[number])
    ) &&
    Array.isArray(candidate.events) &&
    !!candidate.graph &&
    typeof candidate.graph === 'object' &&
    typeof candidate.createdAt === 'string' &&
    typeof candidate.updatedAt === 'string'
  )
}

/**
 * Every local run this person started, on disk. One JSON file per run, written
 * atomically, so the Jobs list and the canvas still hold them after a restart —
 * the orchestration rows outlived the process and the run should too.
 *
 * This is personal state, not a queue: nothing here is claimed, dispatched or
 * shared with another machine.
 */
export class LocalRunStore {
  private readonly pending = new Map<string, LocalRunSnapshot>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private directoryReady = false

  constructor(
    private readonly directory: string,
    private readonly log: LocalRunStoreLogger = defaultLogger
  ) {}

  /**
   * Read every persisted run, repairing the ones the previous process died inside.
   * Unreadable or malformed files are skipped with a warning: one corrupt run must
   * never cost a person the rest of their history, let alone start-up.
   */
  load(): LocalRunSnapshot[] {
    let names: string[]
    try {
      names = readdirSync(this.directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log(`Could not read ${this.directory}`, error)
      }
      return []
    }
    const loaded: LocalRunSnapshot[] = []
    for (const name of names) {
      const id = RUN_FILE.exec(name)?.[1]
      if (!id) {
        continue
      }
      const snapshot = this.read(join(this.directory, name), id)
      if (!snapshot) {
        continue
      }
      if (repairLocalRunAfterRestart(snapshot)) {
        // Persist the repair now: a second restart must not re-append the notice.
        this.write(snapshot)
      }
      loaded.push(snapshot)
    }
    return loaded
  }

  /**
   * Record a change. Anything but a live run is written before this returns, because
   * a person who quits the moment a run completes must still find it next launch.
   */
  save(snapshot: LocalRunSnapshot): void {
    if (!wasExecuting(snapshot.stage)) {
      this.pending.delete(snapshot.id)
      this.write(snapshot)
      return
    }
    this.pending.set(snapshot.id, snapshot)
    this.timer ??= setTimeout(() => this.flush(), DEBOUNCE_MS)
    this.timer.unref?.()
  }

  /** Write everything still debounced. Called on quit and by `save` for settled runs. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const queued = Array.from(this.pending.values())
    this.pending.clear()
    for (const snapshot of queued) {
      this.write(snapshot)
    }
  }

  /** Forget a run the service evicted, so disk does not outgrow what it will show. */
  remove(id: string): void {
    this.pending.delete(id)
    if (!RUN_FILE.test(`${id}.json`)) {
      return
    }
    try {
      rmSync(join(this.directory, `${id}.json`), { force: true })
    } catch (error) {
      this.log(`Could not remove run ${id}`, error)
    }
  }

  private read(path: string, id: string): LocalRunSnapshot | null {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf-8'))
    } catch (error) {
      this.log(`Skipping unreadable run file ${path}`, error)
      return null
    }
    if (!isSnapshotShape(parsed, id)) {
      this.log(`Skipping run file ${path}: it is not a local run snapshot`)
      return null
    }
    return parsed
  }

  private write(snapshot: LocalRunSnapshot): void {
    if (!RUN_FILE.test(`${snapshot.id}.json`)) {
      this.log(`Refusing to write run ${snapshot.id}: unexpected id`)
      return
    }
    const path = join(this.directory, `${snapshot.id}.json`)
    try {
      if (!this.directoryReady) {
        mkdirSync(this.directory, { recursive: true })
        this.directoryReady = true
      }
      // Clone first: the runner keeps mutating the live snapshot, and JSON.stringify
      // over a moving object is how a half-written node list gets published.
      const payload = JSON.stringify(cloneLocalRunSnapshot(snapshot))
      writeFileDurableSync(durableWriteTempPath(path), path, payload)
    } catch (error) {
      this.log(`Could not persist run ${snapshot.id}`, error)
    }
  }
}

/**
 * Where the desktop keeps local runs, mirroring how the orchestration DB path is
 * built. Returns null in a host with no app environment installed (tests, and the
 * plain-Node runtime fork), where persistence is simply off rather than a throw.
 */
export function defaultLocalRunDirectory(): string | null {
  if (!hasAppEnvironment()) {
    return null
  }
  let environment: AppEnvironment
  try {
    environment = getAppEnvironment()
  } catch {
    return null
  }
  return join(environment.getPath('userData'), LOCAL_RUNS_DIRECTORY)
}
