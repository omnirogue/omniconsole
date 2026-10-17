import {
  LOCAL_RUN_MAX_CONCURRENT,
  localRunFleetNodeIds,
  normalizeLocalRunGraph,
  type LocalRunGraph
} from '../../../shared/local-run-graph'
import {
  isLocalRunActive,
  type LocalRunChangedPayload,
  type LocalRunSnapshot
} from '../../../shared/local-run-types'
import { hasAppEnvironment, getAppEnvironment } from '../../../shared/app-environment'
import type { OrcaRuntimeService } from '../omni-runtime'
import { createOrchestrationCaller, type OrchestrationCaller } from './build-review-rpc-call'
import { CancelledError, type ActiveRun } from './build-review-worker-lifecycle'
import { defaultLocalRunDirectory, LocalRunStore } from './local-run-persistence'
import { LocalRunRunner } from './local-run-runner'
import { cloneLocalRunSnapshot, createLocalRunSnapshot } from './local-run-state'

const MAX_SETTLED_RUNS = 50
const DEFAULT_MAX_CONCURRENT = 3

export type LocalRunServiceOptions = {
  /**
   * Where run snapshots are kept. Defaults to `local-runs` under this profile's
   * user-data path; null turns persistence off (a host with no app environment).
   */
  directory?: string | null
}

/**
 * Every local Run this desktop is executing. Nothing here is a queue, a claim or a
 * seat: a local Run is one person's own graph on one workspace, started by hand.
 */
export class LocalRunService {
  private readonly runs = new Map<string, LocalRunSnapshot>()
  private readonly active = new Map<string, ActiveRun>()
  // Why keep the runner: only it can answer a worker, because only it holds the
  // registry, the live worker handles and the coordinator terminal.
  private readonly runners = new Map<string, LocalRunRunner>()
  private readonly call: OrchestrationCaller
  private readonly store: LocalRunStore | null

  constructor(
    private readonly runtime: OrcaRuntimeService,
    call?: OrchestrationCaller,
    options: LocalRunServiceOptions = {}
  ) {
    this.call = call ?? createOrchestrationCaller(runtime)
    const directory =
      options.directory === undefined ? defaultLocalRunDirectory() : options.directory
    this.store = directory ? new LocalRunStore(directory) : null
    for (const snapshot of this.store?.load() ?? []) {
      this.runs.set(snapshot.id, snapshot)
    }
    // A run that completes seconds before a quit must still be on disk afterwards.
    if (this.store && hasAppEnvironment()) {
      getAppEnvironment().onWillQuit(() => this.store?.flush())
    }
  }

  list(): LocalRunSnapshot[] {
    return [...this.runs.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map(cloneLocalRunSnapshot)
  }

  show(id: string): LocalRunSnapshot {
    return cloneLocalRunSnapshot(this.require(id))
  }

  /** Validate and record a graph. Nothing starts until `start` is called. */
  create(graph: unknown): LocalRunSnapshot {
    const normalized = normalizeLocalRunGraph(graph)
    if (!normalized) {
      throw new Error(
        'A local run needs a workspace path and a finite graph of nodes whose dependencies all exist.'
      )
    }
    const fleet = localRunFleetNodeIds(normalized)
    if (fleet.length > 0) {
      // Why refuse instead of running them here: fleet placement is admitted through
      // the console. Starting it locally would execute work the console never admitted.
      throw new Error(
        `Fleet-placed nodes are admitted through the console, never started locally: ${fleet.join(', ')}.`
      )
    }
    const clash = this.activeRunFor(normalized.workspacePath)
    if (clash) {
      throw new Error(`Run ${clash.id} is still ${clash.stage} in this workspace.`)
    }
    const snapshot = createLocalRunSnapshot({
      graph: normalized,
      // Refined against the resolved workspace when the coordinator opens.
      workspaceKind: 'folder',
      maxConcurrent: Math.min(
        normalized.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
        LOCAL_RUN_MAX_CONCURRENT
      )
    })
    this.runs.set(snapshot.id, snapshot)
    this.evictSettled()
    this.changed(snapshot)
    return cloneLocalRunSnapshot(snapshot)
  }

  start(id: string): LocalRunSnapshot {
    const snapshot = this.require(id)
    if (snapshot.stage !== 'created') {
      throw new Error(`Run ${id} has already been started.`)
    }
    const run: ActiveRun = {
      abort: new AbortController(),
      pendingAck: null,
      seenMessageIds: new Set(),
      execution: null
    }
    this.active.set(snapshot.id, run)
    const runner = new LocalRunRunner(
      { runtime: this.runtime, call: this.call, changed: (next) => this.changed(next) },
      snapshot,
      run
    )
    this.runners.set(snapshot.id, runner)
    run.execution = runner.execute().finally(() => {
      this.active.delete(snapshot.id)
      this.runners.delete(snapshot.id)
    })
    return cloneLocalRunSnapshot(snapshot)
  }

  async cancel(id: string): Promise<LocalRunSnapshot> {
    const snapshot = this.require(id)
    const run = this.active.get(id)
    if (!run || !isLocalRunActive(snapshot.stage)) {
      return cloneLocalRunSnapshot(snapshot)
    }
    run.abort.abort()
    // The execution owns every worker and the coordinator terminal; it performs the
    // stop/release sequence itself so a cancel cannot race a start in flight.
    await run.execution?.catch(() => undefined)
    return cloneLocalRunSnapshot(snapshot)
  }

  /**
   * Answer a node's decision gate. The orchestration store puts the Task back to
   * ready, and the runner's next turn picks it up — no state is duplicated here.
   */
  async resolveGate(id: string, gateId: string, resolution: string): Promise<LocalRunSnapshot> {
    const snapshot = this.require(id)
    await this.call('orchestration.gateResolve', {
      id: gateId,
      resolution,
      from: snapshot.coordinatorTerminalHandle ?? undefined,
      run: snapshot.runId ?? undefined
    })
    const node = snapshot.nodes.find((entry) => entry.gateId === gateId)
    if (node) {
      // Why gateId stays: it records that this node's gate was already opened. The
      // runner reads it to know not to open a second one, and the state comes from
      // whether a PENDING gate row still exists, not from this field.
      node.state = 'queued'
    }
    this.changed(snapshot)
    return cloneLocalRunSnapshot(snapshot)
  }

  /**
   * Answer the worker that is waiting on `messageId`. A worker that asked through the
   * Run mailbox is released by replying to its question; a worker that stopped in its
   * own terminal is answered by delivering the body as a prompt to that terminal. The
   * runner routes it, because only it knows which of the two this question is.
   */
  async reply(id: string, messageId: string, body: string): Promise<LocalRunSnapshot> {
    const snapshot = this.require(id)
    const runner = this.runners.get(id)
    if (!runner) {
      throw new Error(`Run ${id} is no longer executing, so its workers can no longer be answered.`)
    }
    await runner.answer(messageId, body)
    return cloneLocalRunSnapshot(snapshot)
  }

  private activeRunFor(workspacePath: string): LocalRunSnapshot | undefined {
    for (const snapshot of this.runs.values()) {
      if (snapshot.workspacePath === workspacePath && isLocalRunActive(snapshot.stage)) {
        return snapshot
      }
    }
    return undefined
  }

  private evictSettled(): void {
    const settled = [...this.runs.values()]
      .filter((snapshot) => !this.active.has(snapshot.id) && !isLocalRunActive(snapshot.stage))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1))
    while (settled.length > MAX_SETTLED_RUNS) {
      const oldest = settled.shift()
      if (oldest) {
        this.runs.delete(oldest.id)
        this.store?.remove(oldest.id)
      }
    }
  }

  private require(id: string): LocalRunSnapshot {
    const snapshot = this.runs.get(id)
    if (!snapshot) {
      throw new Error(`Local run ${id} was not found.`)
    }
    return snapshot
  }

  private changed(snapshot: LocalRunSnapshot): void {
    this.store?.save(snapshot)
    const payload: LocalRunChangedPayload = { localRunId: snapshot.id, stage: snapshot.stage }
    this.runtime.notifyLocalRunChanged(payload)
  }
}

export type { LocalRunGraph }
export { CancelledError }

const servicesByRuntime = new WeakMap<OrcaRuntimeService, LocalRunService>()

export function getLocalRunService(runtime: OrcaRuntimeService): LocalRunService {
  const existing = servicesByRuntime.get(runtime)
  if (existing) {
    return existing
  }
  const service = new LocalRunService(runtime)
  servicesByRuntime.set(runtime, service)
  return service
}
