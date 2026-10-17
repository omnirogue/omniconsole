import { isFolderRepo } from '../../../shared/repo-kind'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { LocalRunGraph, LocalRunNode } from '../../../shared/local-run-graph'
import { localRunNodesInLevelOrder } from '../../../shared/local-run-node-state'
import type { LocalRunSnapshot } from '../../../shared/local-run-types'
import type { OrcaRuntimeService } from '../omni-runtime'
import { evaluateDagConvergence } from '../orchestration/coordinator-dag-convergence'
import { reblockTasksWithPendingGates } from '../orchestration/coordinator-decision-gates'
import { createDesktopCoordinator } from '../orchestration/desktop-coordinator'
import type { OrchestrationCaller } from './build-review-rpc-call'
import { WorkerUnitRegistry } from './build-review-worker-registry'
import {
  assertNotCancelled,
  CancelledError,
  releaseWorker,
  stopLiveWorker,
  type ActiveRun,
  type WorkerHostContext,
  type WorkerLifecycleContext
} from './build-review-worker-lifecycle'
import { answerLocalRunQuestion } from './local-run-answer'
import { buildLocalRunNodeSpec } from './local-run-briefs'
import { prepareLocalRunOutputRoot } from './local-run-artifacts'
import { localRunNodeOutputDir, localRunNodeReportPath } from './local-run-placement'
import { runLocalRunPool, type LocalRunNodeRuntime } from './local-run-batch'
import {
  localRunStrandedSuffix,
  localRunStuckMessage,
  startLocalRunStaleWatch,
  type LocalRunStaleWatch
} from './local-run-attention'
import {
  createLocalRunWorkerUnit,
  localRunNodeSnapshot,
  pushLocalRunEvent,
  setLocalRunStage
} from './local-run-state'
import { localRunIdleSettler } from './local-run-idle-settle'
import { RunMailboxPump } from './local-run-mailbox-pump'
import { refreshLocalRunNodeStates } from './local-run-node-status'

const IDLE_POLL_MS = 1_500
/** How often the derivation is re-read while workers run and nobody is talking. */
const STATUS_WATCH_MS = 1_000

export type LocalRunnerDeps = {
  runtime: OrcaRuntimeService
  call: OrchestrationCaller
  changed: (snapshot: LocalRunSnapshot) => void
}

/**
 * The mechanical DAG runner for unadmitted local work.
 *
 * There is no LLM coordinator anywhere in here: it waits, reads what workers wrote,
 * renders the next brief from stored rows and files, and starts the next workers. It
 * refuses to run a card-bound Run — a card's execution is the hub's to admit, and a
 * personal graph is never business authority.
 */
export class LocalRunRunner {
  private readonly registry = new WorkerUnitRegistry()
  private readonly nodes = new Map<string, LocalRunNodeRuntime>()
  private pump: RunMailboxPump | null = null
  private host: WorkerHostContext | null = null
  private statusWatch: ReturnType<typeof setInterval> | null = null
  private staleWatch: LocalRunStaleWatch | null = null

  constructor(
    private readonly deps: LocalRunnerDeps,
    private readonly snapshot: LocalRunSnapshot,
    private readonly run: ActiveRun
  ) {}

  private get ctx(): WorkerLifecycleContext {
    return { call: this.deps.call, changed: () => this.publish() }
  }

  /**
   * Recompute every node from stored rows, then push. Every push goes through here:
   * a snapshot that says QUEUED while its worker is running is the state a person
   * acts on, and the renderer only ever sees what was pushed.
   */
  private publish(): void {
    if (this.snapshot.runId) {
      refreshLocalRunNodeStates({
        db: this.deps.runtime.getOrchestrationDb(),
        snapshot: this.snapshot,
        nodes: this.nodes,
        registry: this.registry,
        hook: (handle) => this.deps.runtime.getFreshAgentHookStatusForHandle(handle)
      })
    }
    this.deps.changed(this.snapshot)
  }

  /**
   * Nothing pushes while the pump sits in a 60 s wait window and no worker speaks, so
   * a node that changed state without sending a message would stay stale on the card
   * for a whole window. This ticks the derivation instead.
   */
  private startStatusWatch(): void {
    this.statusWatch ??= setInterval(() => {
      try {
        this.publish()
      } catch {
        // A push is never worth failing a run over; the next tick tries again.
      }
    }, STATUS_WATCH_MS).unref()
    this.staleWatch ??= startLocalRunStaleWatch(this.deps, this.snapshot)
  }

  async execute(): Promise<void> {
    try {
      setLocalRunStage(this.snapshot, 'starting')
      await this.openCoordinator()
      await this.createTasks()
      setLocalRunStage(this.snapshot, 'running')
      this.startStatusWatch()
      this.publish()
      await this.loop()
      // Why not "converged": the DAG converges when every Task is terminal, and a
      // FAILED Task is terminal. A run whose node failed has not produced what it
      // was asked for, and reporting it as completed is the favourable-absence
      // answer the operator would act on.
      const failed = this.snapshot.nodes.filter((node) => node.state === 'failed')
      if (failed.length > 0) {
        throw new Error(
          `Finished with failed node(s): ${failed
            .map((node) => `${node.id}${node.error ? ` (${node.error})` : ''}`)
            .join('; ')}${localRunStrandedSuffix(this.snapshot)}`
        )
      }
      setLocalRunStage(this.snapshot, 'completed')
    } catch (error) {
      const cancelled = error instanceof CancelledError || this.run.abort.signal.aborted
      this.snapshot.error = cancelled ? 'cancelled' : describeError(error)
      setLocalRunStage(this.snapshot, cancelled ? 'cancelled' : 'failed')
      pushLocalRunEvent(this.snapshot, cancelled ? 'info' : 'error', 'run', this.snapshot.error)
    } finally {
      if (this.statusWatch) {
        clearInterval(this.statusWatch)
        this.statusWatch = null
      }
      this.staleWatch?.stop()
      this.staleWatch = null
      await this.pump?.stop()
      this.registry.fail(new CancelledError())
      await this.stopEveryLiveWorker()
      await this.closeCoordinator()
      this.deps.changed(this.snapshot)
    }
  }

  /**
   * Why: a folder workspace has no repo record at all (its id is a `folder:` key), so
   * asking for one fails with repo_not_found. Only git-backed workspaces are asked.
   */
  private async resolveWorkspaceKind(workspace: {
    id: string
    repoId: string
  }): Promise<'folder' | 'git'> {
    if (parseWorkspaceKey(workspace.id)?.type === 'folder') {
      return 'folder'
    }
    const repo = await this.deps.runtime.showRepo(`id:${workspace.repoId}`)
    return isFolderRepo(repo) ? 'folder' : 'git'
  }

  /**
   * Bind the graph to a fresh orchestration Run through a hidden coordinator terminal
   * in the workspace, exactly as Build + Review does — and never to a card.
   */
  private async openCoordinator(): Promise<void> {
    const workspace = await this.deps.runtime.showManagedTerminalWorkspace(
      `path:${this.snapshot.workspacePath}`
    )
    this.snapshot.workspaceId = workspace.id
    this.snapshot.workspaceKind = await this.resolveWorkspaceKind(workspace)
    assertNotCancelled(this.run)
    const handle = await createDesktopCoordinator(
      this.deps.runtime,
      workspace.id,
      'Local run coordinator',
      { launchCause: { trigger: 'workflow', reference: { workflowRunId: this.snapshot.id } } }
    )
    this.snapshot.coordinatorTerminalHandle = handle
    const created = await this.deps.call<{
      run: { id: string; hub_task_id?: string | null }
      projectionTaskId?: string
    }>('orchestration.runCreate', {
      objective: localRunObjective(this.snapshot.graph),
      from: handle
    })
    // Why: a card-bound Run's execution belongs to the hub. Creating local tasks on
    // one would invent business work nobody admitted, so refuse before any task.
    if (created.run.hub_task_id || created.projectionTaskId) {
      throw new Error(
        'This Run is bound to an omnios card. A local graph is unadmitted personal work and cannot create tasks on a card-bound Run.'
      )
    }
    this.snapshot.runId = created.run.id
    prepareLocalRunOutputRoot({
      workspacePath: this.snapshot.workspacePath,
      runId: created.run.id,
      hasRepository: this.snapshot.workspaceKind === 'git'
    })
    pushLocalRunEvent(
      this.snapshot,
      'info',
      'run',
      `Run ${created.run.id} bound to ${handle} in ${this.snapshot.workspacePath}`
    )
    this.host = {
      coordinatorTerminalHandle: handle,
      runId: created.run.id,
      briefWithDispatch: true,
      log: (kind, role, text) =>
        pushLocalRunEvent(this.snapshot, kind === 'error' ? 'error' : 'node', role, text),
      changed: () => this.publish()
    }
    // Why the settler: twice on 2026-09-10 a worker wrote its report and its
    // deliverables and then never managed to send worker_done, holding its node
    // RUNNING for half an hour. What it produced is on disk; this settles it from that.
    const idle = localRunIdleSettler(this.deps, this.host, this.registry, this.nodes, this.snapshot)
    this.pump = new RunMailboxPump(this.ctx, this.host, this.run, this.registry, idle)
  }

  /**
   * Deliver a person's answer to the worker waiting on it, then re-derive. The runner
   * owns this because it owns the registry, the worker handles and the coordinator
   * terminal — the three things the two answer paths need.
   */
  async answer(messageId: string, body: string): Promise<void> {
    await answerLocalRunQuestion({
      runtime: this.deps.runtime,
      call: this.deps.call,
      registry: this.registry,
      snapshot: this.snapshot,
      nodes: this.nodes,
      messageId,
      body
    })
    this.publish()
  }

  /** Every Task up front, with its dependency edges, so the DAG is stored not inferred. */
  private async createTasks(): Promise<void> {
    const taskIdByNode = new Map<string, string>()
    for (const node of localRunNodesInLevelOrder(this.snapshot.graph)) {
      assertNotCancelled(this.run)
      const deps = node.deps.map((dep) => taskIdByNode.get(dep)).filter((id): id is string => !!id)
      const created = await this.deps.call<{ task: { id: string } }>('orchestration.taskCreate', {
        spec: this.initialSpec(node),
        taskTitle: `${node.presetId} · ${node.id}`,
        deps: JSON.stringify(deps),
        run: this.snapshot.runId ?? undefined,
        callerTerminalHandle: this.host?.coordinatorTerminalHandle ?? undefined
      })
      taskIdByNode.set(node.id, created.task.id)
      const snapshot = localRunNodeSnapshot(this.snapshot, node.id)
      snapshot.taskId = created.task.id
      snapshot.outputDir = localRunNodeOutputDir(
        this.snapshot.workspacePath,
        this.snapshot.runId!,
        created.task.id
      )
      snapshot.reportPath = localRunNodeReportPath(
        this.snapshot.workspacePath,
        this.snapshot.runId!,
        created.task.id
      )
      this.nodes.set(node.id, {
        node,
        snapshot,
        unit: createLocalRunWorkerUnit(node),
        answeredTerminalQuestionId: null,
        artifacts: null
      })
    }
    pushLocalRunEvent(this.snapshot, 'info', 'run', `Created ${taskIdByNode.size} task(s)`)
  }

  private initialSpec(node: LocalRunNode): string {
    return buildLocalRunNodeSpec({
      node,
      workspacePath: this.snapshot.workspacePath,
      outputDir: `${this.snapshot.workspacePath}/.omni/runs/<run>/<task>`,
      reportPath: `${this.snapshot.workspacePath}/.omni/runs/<run>/<task>.md`,
      inputs: []
    })
  }

  private async loop(): Promise<void> {
    const db = this.deps.runtime.getOrchestrationDb()
    const log = (message: string) => pushLocalRunEvent(this.snapshot, 'info', 'run', message)
    for (;;) {
      assertNotCancelled(this.run)
      reblockTasksWithPendingGates(db)
      this.staleWatch?.scan()
      const progressed = await runLocalRunPool({
        ctx: this.ctx,
        host: this.host!,
        run: this.run,
        registry: this.registry,
        pump: this.pump!,
        snapshot: this.snapshot,
        nodes: this.nodes,
        deps: this.deps
      })
      this.publish()
      const convergence = evaluateDagConvergence(db, log, this.snapshot.runId ?? undefined)
      if (convergence !== 'active') {
        return
      }
      if (progressed) {
        continue
      }
      // Nothing was startable and nothing is live: either a person still owes an
      // answer, or a failed dependency has stranded the rest of the graph.
      if (!this.snapshot.nodes.some((node) => node.state === 'needs-input')) {
        throw new Error(localRunStuckMessage(this.snapshot))
      }
      await this.sleep(IDLE_POLL_MS)
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      this.run.abort.signal.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  /**
   * Whatever ended this run, a worker that is still live keeps editing the workspace
   * until someone stops it. Do that before the coordinator terminal goes away.
   */
  private async stopEveryLiveWorker(): Promise<void> {
    if (!this.host) {
      return
    }
    for (const entry of this.nodes.values()) {
      await stopLiveWorker(this.ctx, this.host, entry.unit, this.snapshot.error ?? 'run ended')
      await releaseWorker(this.ctx, this.host, entry.unit)
    }
  }

  private async closeCoordinator(): Promise<void> {
    const handle = this.snapshot.coordinatorTerminalHandle
    if (handle) {
      await this.deps.runtime.closeTerminal(handle).catch(() => undefined)
    }
  }
}

function localRunObjective(graph: LocalRunGraph): string {
  return `Local run of ${graph.nodes.length} node(s) in ${graph.workspacePath}`
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
