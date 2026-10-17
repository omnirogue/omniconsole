import {
  isLocalRunEditingPreset,
  localRunParallelNodeIds
} from '../../../shared/local-run-node-state'
import type { LocalRunSnapshot } from '../../../shared/local-run-types'
import type { TaskRow } from '../orchestration/types'
import type { WorkerUnitRegistry } from './build-review-worker-registry'
import {
  assertNotCancelled,
  releaseWorker,
  settleDelivery,
  stopLiveWorker,
  type ActiveRun,
  type WorkerHostContext,
  type WorkerLifecycleContext,
  type WorkerPlacement
} from './build-review-worker-lifecycle'
import { runWorkerUnit } from './build-review-worker-unit'
import { applyDeliveryToTarget } from './build-review-messages'
import { readLocalRunReport } from './local-run-artifacts'
import { buildLocalRunNodeSpec, localRunGateQuestion } from './local-run-briefs'
import { deliverLocalRunNode } from './local-run-deliver'
import { resolveLocalRunPlacement } from './local-run-placement'
import type { LocalRunNodeRuntimeLike } from './local-run-node-status'
import { pushLocalRunEvent } from './local-run-state'
import type { RunMailboxPump } from './local-run-mailbox-pump'
import type { LocalRunnerDeps } from './local-run-runner'
import type { LocalRunArtifacts } from './local-run-artifacts'

export type LocalRunNodeRuntime = LocalRunNodeRuntimeLike & {
  artifacts: LocalRunArtifacts | null
}

export type LocalRunBatchArgs = {
  ctx: WorkerLifecycleContext
  host: WorkerHostContext
  run: ActiveRun
  registry: WorkerUnitRegistry
  pump: RunMailboxPump
  snapshot: LocalRunSnapshot
  nodes: Map<string, LocalRunNodeRuntime>
  deps: LocalRunnerDeps
}

/** How often a pool with live workers re-reads ready Tasks, so a gate answered mid-run starts. */
const POOL_POLL_MS = 1_500

type StartGate = (start: () => Promise<void>) => Promise<void>

/**
 * One turn of the runner: open any gate that is now due and keep up to maxConcurrent
 * nodes running, starting the next ready node as soon as a slot frees instead of
 * waiting for the slowest worker. Starts stay serialized, every wait shares the Run's
 * one mailbox pump, and a settled node's result is read before its dependents are
 * listed. Returns whether it did anything, so the caller can tell "waiting for a
 * person" from "stuck".
 */
export async function runLocalRunPool(args: LocalRunBatchArgs): Promise<boolean> {
  const inFlight = new Map<LocalRunNodeRuntime, Promise<LocalRunNodeRuntime>>()
  const parallelIds = localRunParallelNodeIds(args.snapshot.graph)
  let startChain: Promise<void> = Promise.resolve()
  // Why: two workers may WAIT at once (that is the pump), but two simultaneous
  // worker-starts would race the same coordinator terminal and Run generation.
  const startGate: StartGate = (start) => {
    const queued = startChain.then(start)
    startChain = queued.catch(() => undefined)
    return queued
  }
  let progressed = false
  for (;;) {
    assertNotCancelled(args.run)
    const ready = (await listReadyNodes(args)).filter((entry) => !inFlight.has(entry))
    const gated = ready.filter((entry) => entry.node.gate && !entry.snapshot.gateId)
    for (const entry of gated) {
      await openNodeGate(args, entry)
      progressed = true
    }
    const startable = ready
      .filter((entry) => !entry.node.gate || Boolean(entry.snapshot.gateId))
      .filter((entry) => !gated.includes(entry))
      .slice(0, Math.max(0, args.snapshot.maxConcurrent - inFlight.size))
    if (startable.length > 0 && inFlight.size === 0) {
      // One Run, one Delivery: a drained pool acknowledges it before new workers start.
      await drainDelivery(args)
    }
    const concurrent = inFlight.size + startable.length
    for (const entry of startable) {
      const placement = placeNode(args, entry, parallelIds.has(entry.node.id) && concurrent > 1)
      // Two editing workers never share the workspace root; this one waits for the slot.
      if (
        holdsWorkspaceRoot(entry, placement) &&
        [...inFlight.keys()].some((running) =>
          holdsWorkspaceRoot(running, running.snapshot.placement ?? undefined)
        )
      ) {
        continue
      }
      inFlight.set(entry, startNode(args, entry, placement, startGate))
      progressed = true
    }
    if (inFlight.size === 0) {
      break
    }
    const settled = await nextSettled(args.run, inFlight)
    if (!settled) {
      continue
    }
    inFlight.delete(settled)
    await collectNodeResult(args, settled)
    progressed = true
    args.host.changed()
  }
  if (progressed) {
    await drainDelivery(args)
  }
  return progressed
}

function placeNode(
  args: LocalRunBatchArgs,
  entry: LocalRunNodeRuntime,
  parallel: boolean
): WorkerPlacement {
  return resolveLocalRunPlacement({
    workspaceKind: args.snapshot.workspaceKind,
    workspacePath: args.snapshot.workspacePath,
    runId: args.snapshot.runId!,
    taskId: entry.snapshot.taskId!,
    nodeId: entry.node.id,
    presetId: entry.node.presetId,
    parallel
  })
}

function holdsWorkspaceRoot(
  entry: LocalRunNodeRuntime,
  placement: Pick<WorkerPlacement, 'worktree' | 'cwd'> | undefined
): boolean {
  return (
    placement?.worktree === 'current' &&
    !placement.cwd &&
    isLocalRunEditingPreset(entry.node.presetId)
  )
}

/** Start one node; the promise settles with the node once its worker reported or failed. */
function startNode(
  args: LocalRunBatchArgs,
  entry: LocalRunNodeRuntime,
  placement: WorkerPlacement,
  startGate: StartGate
): Promise<LocalRunNodeRuntime> {
  entry.snapshot.placement = {
    worktree: placement.worktree,
    ...(placement.name ? { name: placement.name } : {}),
    ...(placement.cwd ? { cwd: placement.cwd } : {})
  }
  return runWorkerUnit({
    ctx: args.ctx,
    host: args.host,
    run: args.run,
    worker: entry.unit,
    title: `${entry.node.presetId} · ${entry.node.id}`,
    spec: nodeSpec(args, entry),
    createTask: async () => entry.snapshot.taskId!,
    waitForReport: (unit) => args.registry.waitFor(unit),
    placement: {
      ...placement,
      ...(entry.node.actor.accountChoiceId
        ? { accountChoiceId: entry.node.actor.accountChoiceId }
        : {})
    },
    onDispatch: (dispatchId) => {
      const early = args.registry.bind(entry.unit, dispatchId)
      if (early.length > 0) {
        applyDeliveryToTarget(args.registry.asMailboxTarget(args.host.log), early)
        args.registry.notify()
      }
      entry.snapshot.dispatchId = dispatchId
      // Requested vs reported effort for this node's start, mirrored onto the snapshot
      // the card reads; startWorker writes it just before this callback runs.
      if (entry.unit.effortParity) {
        entry.snapshot.effortParity = entry.unit.effortParity
      }
      args.pump.ensure()
      // Why push here: this is the moment the node starts EXECUTING. Without it the card
      // kept showing the state the node had before it started until something else pushed.
      args.host.changed()
    },
    startGate,
    settle: false
  }).then(
    () => entry,
    async (error: unknown) => {
      // A cancelled run stops and releases every worker itself.
      if (!args.run.abort.signal.aborted) {
        entry.unit.error ??= describeError(error)
        pushLocalRunEvent(args.snapshot, 'error', entry.node.id, entry.unit.error)
        // Why: runWorkerUnit only releases on the wait path. A start that threw after
        // worker-start handed back a dispatch would otherwise leave an agent editing
        // this workspace with nobody waiting for it.
        await stopLiveWorker(args.ctx, args.host, entry.unit, entry.unit.error)
        await releaseWorker(args.ctx, args.host, entry.unit)
      }
      return entry
    }
  )
}

/** The next node to settle, or null after one poll interval or a cancel. */
function nextSettled(
  run: ActiveRun,
  inFlight: Map<LocalRunNodeRuntime, Promise<LocalRunNodeRuntime>>
): Promise<LocalRunNodeRuntime | null> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (entry: LocalRunNodeRuntime | null): void => {
      clearTimeout(timer)
      run.abort.signal.removeEventListener('abort', cancel)
      resolve(entry)
    }
    const cancel = (): void => finish(null)
    if (run.abort.signal.aborted) {
      cancel()
      return
    }
    timer = setTimeout(cancel, POOL_POLL_MS)
    run.abort.signal.addEventListener('abort', cancel, { once: true })
    void Promise.race(inFlight.values()).then(finish)
  })
}

async function drainDelivery(args: LocalRunBatchArgs): Promise<void> {
  // No worker is live: end the open wait window instead of sitting it out, and let the pump exit.
  args.pump.wake()
  await args.pump.idle()
  await settleDelivery(args.ctx, args.host, args.run).catch(() => undefined)
}

/** Ready Tasks of THIS Run, mapped back to their nodes, in the graph's own order. */
async function listReadyNodes(args: LocalRunBatchArgs): Promise<LocalRunNodeRuntime[]> {
  const listed = await args.ctx.call<{ tasks: TaskRow[] }>('orchestration.taskList', {
    run: args.snapshot.runId ?? undefined,
    ready: true,
    callerTerminalHandle: args.host.coordinatorTerminalHandle ?? undefined
  })
  const readyTaskIds = new Set(listed.tasks.map((task) => task.id))
  return [...args.nodes.values()].filter(
    (entry) =>
      entry.snapshot.taskId &&
      readyTaskIds.has(entry.snapshot.taskId) &&
      entry.unit.status === 'pending'
  )
}

/** A gated node blocks its own Task and surfaces NEEDS INPUT until a person answers. */
async function openNodeGate(args: LocalRunBatchArgs, entry: LocalRunNodeRuntime): Promise<void> {
  const created = await args.ctx.call<{ gate: { id: string } }>('orchestration.gateCreate', {
    task: entry.snapshot.taskId,
    question: localRunGateQuestion(entry.node),
    decisionScope: 'execution',
    ...(entry.node.gate?.options ? { options: JSON.stringify(entry.node.gate.options) } : {}),
    from: args.host.coordinatorTerminalHandle ?? undefined,
    run: args.snapshot.runId ?? undefined
  })
  entry.snapshot.gateId = created.gate.id
  entry.snapshot.gateQuestion = localRunGateQuestion(entry.node)
  pushLocalRunEvent(
    args.snapshot,
    'gate',
    entry.node.id,
    `Needs input: ${localRunGateQuestion(entry.node)}`
  )
}

/** The brief this node runs, carrying exactly what its dependencies produced. */
function nodeSpec(args: LocalRunBatchArgs, entry: LocalRunNodeRuntime): string {
  const inputs = entry.node.deps
    .map((dep) => args.nodes.get(dep))
    .filter((dependency): dependency is LocalRunNodeRuntime => Boolean(dependency?.artifacts))
    .map((dependency) => ({ nodeId: dependency.node.id, artifacts: dependency.artifacts! }))
  return buildLocalRunNodeSpec({
    node: entry.node,
    workspacePath: args.snapshot.workspacePath,
    outputDir: entry.snapshot.outputDir!,
    reportPath: entry.snapshot.reportPath!,
    inputs
  })
}

/**
 * Read what a released worker left behind: its archived transcript first (the live
 * PTY is gone, and the archive is the only remaining evidence of what it did), then
 * the report file the runner dictated, then whatever it produced in its folder.
 */
async function collectNodeResult(
  args: LocalRunBatchArgs,
  entry: LocalRunNodeRuntime
): Promise<void> {
  if (entry.unit.dispatchId) {
    await args.ctx
      .call('orchestration.workerRead', { dispatch: entry.unit.dispatchId, limit: 200 })
      .catch(() => undefined)
  }
  entry.artifacts = readLocalRunReport({
    workspacePath: args.snapshot.workspacePath,
    runId: args.snapshot.runId!,
    taskId: entry.snapshot.taskId!,
    reportedPath: entry.unit.report?.reportPath ?? null,
    reportBody: entry.unit.report?.body ?? null
  })
  entry.snapshot.manifestPath = entry.artifacts.manifestPath
  entry.snapshot.producedFiles = entry.artifacts.producedFiles
  if (entry.artifacts.refusal) {
    pushLocalRunEvent(args.snapshot, 'error', entry.node.id, entry.artifacts.refusal)
  }
  args.registry.forget(entry.unit)
  if (entry.unit.status === 'succeeded' && entry.node.deliver) {
    await deliverLocalRunNode(args.snapshot, entry)
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
