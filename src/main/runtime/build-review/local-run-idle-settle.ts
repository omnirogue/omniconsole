import { existsSync } from 'node:fs'
import type { LocalRunSnapshot } from '../../../shared/local-run-types'
import type { OrchestrationMessageSummary } from '../../../shared/orchestration-check-output'
import type { WorkerReportOutcome, WorkerReportSettlement } from '../orchestration/types'
import { applyDeliveryToTarget } from './build-review-messages'
import type { WorkerHostContext, WorkerLifecycleContext } from './build-review-worker-lifecycle'
import type { OrchestrationCaller } from './build-review-rpc-call'
import type { WorkerUnitLike, WorkerUnitRegistry } from './build-review-worker-registry'
import { readLocalRunReport } from './local-run-artifacts'
import type { LocalRunNodeRuntimeLike } from './local-run-node-status'

/**
 * How many CONSECUTIVE empty wait windows a worker must be idle-with-a-report before
 * its node is settled from that report. One window is not evidence: an agent reads as
 * `idle` for the moment between two tool calls, and settling then would take a node
 * away from a worker that is still writing it.
 */
const REQUIRED_IDLE_WINDOWS = 2
/** Only the head of a report is searched for an outcome declaration. */
const OUTCOME_HEAD_LINES = 20
const DECLARES_FAILURE = /outcome:?\s*\**\s*failed/i

const SETTLED_SUBJECT = 'Settled from the report on disk'
const SETTLED_EVENT =
  'Settled from the report on disk — the worker went idle without sending worker_done'

/** What the runner knows about the node behind one live worker. */
export type IdleSettleNode = {
  taskId: string | null
  reportPath: string | null
  /**
   * A question or gate this node still owes a person an answer on. Such a node is
   * never settled mechanically: the worker is stopped BECAUSE it is waiting, and its
   * report on disk describes work it has not been told how to finish.
   */
  hasOpenQuestion: boolean
}

export type IdleSettleStore = { settleWorkerReport: SettleWorkerReport }

export type SettleWorkerReport = (args: {
  taskId: string
  dispatchId: string
  outcome: WorkerReportOutcome
  result: string
}) => WorkerReportSettlement

export type LocalRunIdleSettleDeps = {
  ctx: WorkerLifecycleContext
  host: WorkerHostContext
  registry: WorkerUnitRegistry
  workspacePath: string
  /** The node behind a live worker, or null when the worker is not one of this Run's. */
  nodeFor: (worker: WorkerUnitLike) => IdleSettleNode | null
  /** The same DB settlement a real worker_done goes through. */
  settleWorkerReport: SettleWorkerReport
}

type AgentStatusResult = {
  agentStatus?: { status?: string | null; isRunningAgent?: boolean } | null
}

/** True when the head of a report declares the node failed. */
export function reportDeclaresFailure(text: string): boolean {
  return text
    .split('\n')
    .slice(0, OUTCOME_HEAD_LINES)
    .some((line) => DECLARES_FAILURE.test(line))
}

/**
 * Settle a node from the report its worker left on disk.
 *
 * Measured twice on 2026-09-10: a worker wrote its report and its deliverables, then
 * never managed to send `worker_done` (its `omni` resolved to another program). Its
 * terminal went idle and the node sat RUNNING for half an hour until a person relayed
 * the completion by hand. The evidence the worker finished is on disk; this reads it.
 *
 * It only ever acts on a worker that is BOTH idle in its terminal and has a report,
 * on two consecutive empty wait windows. A worker that is still working, one that is
 * idle without a report, and one whose node owes a person an answer are all left
 * exactly as they are — waiting is the correct state for all three.
 */
export class LocalRunIdleSettler {
  private readonly idleWindows = new Map<WorkerUnitLike, number>()
  private readonly refusalsLogged = new Set<WorkerUnitLike>()

  constructor(private readonly deps: LocalRunIdleSettleDeps) {}

  /** A batch was folded, so nothing in it is stalled; the evidence starts again. */
  onMessages(): void {
    this.idleWindows.clear()
  }

  /** Nothing was said in a whole wait window: look for a worker that finished silently. */
  async onEmptyWindow(): Promise<void> {
    // Why the Set: a worker that was re-bound (a retried dispatch keeps the earlier
    // id mapped to the same unit) appears twice in `live()`, and one window must never
    // count as two.
    for (const worker of new Set(this.deps.registry.live())) {
      try {
        await this.consider(worker)
      } catch (error) {
        // A status read that failed is not evidence of idleness, and one worker must
        // never stop the pump for its siblings.
        this.idleWindows.delete(worker)
        this.deps.host.log(
          'info',
          worker.role,
          `Could not read the worker's terminal status: ${describeError(error)}`
        )
      }
    }
  }

  private async consider(worker: WorkerUnitLike): Promise<void> {
    const node = this.deps.nodeFor(worker)
    if (
      !node?.taskId ||
      !node.reportPath ||
      !worker.dispatchId ||
      node.hasOpenQuestion ||
      this.deps.registry.pendingQuestionFor(worker)
    ) {
      this.idleWindows.delete(worker)
      return
    }
    if (!(await this.isIdle(worker))) {
      this.idleWindows.delete(worker)
      return
    }
    if (!existsSync(node.reportPath)) {
      this.idleWindows.delete(worker)
      return
    }
    const windows = (this.idleWindows.get(worker) ?? 0) + 1
    this.idleWindows.set(worker, windows)
    if (windows >= REQUIRED_IDLE_WINDOWS) {
      this.settle(worker, node.taskId, node.reportPath)
    }
  }

  /** The worker's own terminal, read through the same runtime access liveness uses. */
  private async isIdle(worker: WorkerUnitLike): Promise<boolean> {
    if (!worker.terminalHandle) {
      return false
    }
    const shown = await this.deps.ctx.call<AgentStatusResult>('terminal.agentStatus', {
      terminal: worker.terminalHandle
    })
    return shown.agentStatus?.status === 'idle'
  }

  private settle(worker: WorkerUnitLike, taskId: string, reportPath: string): void {
    const artifacts = readLocalRunReport({
      workspacePath: this.deps.workspacePath,
      runId: this.deps.host.runId ?? '',
      taskId,
      reportedPath: reportPath,
      reportBody: null
    })
    if (artifacts.source !== 'report-file') {
      // The file was there a moment ago and cannot be read now; that is not a report.
      this.idleWindows.delete(worker)
      return
    }
    const outcome: WorkerReportOutcome = reportDeclaresFailure(artifacts.text)
      ? 'failed'
      : 'succeeded'
    const body = `${SETTLED_EVENT}. The report is at ${reportPath}.`
    const settlement = this.deps.settleWorkerReport({
      taskId,
      dispatchId: worker.dispatchId!,
      outcome,
      result: JSON.stringify({
        // Why not `worker_report`: no worker reported this. The row says who read it.
        provenance: 'report_file_settlement',
        outcome,
        reportedBy: worker.terminalHandle,
        subject: SETTLED_SUBJECT,
        body,
        completedBy: worker.terminalHandle,
        filesModified: artifacts.producedFiles,
        reportPath,
        completedAt: new Date().toISOString()
      })
    })
    if (settlement.action === 'rejected') {
      this.idleWindows.set(worker, 0)
      if (!this.refusalsLogged.has(worker)) {
        this.refusalsLogged.add(worker)
        this.deps.host.log(
          'error',
          worker.role,
          `Could not settle ${taskId} from the report on disk: ${settlement.reason}`
        )
      }
      return
    }
    this.deps.host.log('info', worker.role, `${SETTLED_EVENT} (${outcome})`)
    // Why the mailbox fold and not a direct write: the node, its inputs to the next
    // node and its events must be identical to a worker-sent completion.
    applyDeliveryToTarget(this.deps.registry.asMailboxTarget(this.deps.host.log), [
      settledMessage({
        worker,
        taskId,
        outcome,
        reportPath,
        filesModified: artifacts.producedFiles,
        body
      })
    ])
    this.idleWindows.delete(worker)
    this.deps.host.changed()
    this.deps.registry.notify()
  }
}

/** The worker_done the worker would have sent, synthesized from what it left behind. */
function settledMessage(args: {
  worker: WorkerUnitLike
  taskId: string
  outcome: WorkerReportOutcome
  reportPath: string
  filesModified: string[]
  body: string
}): OrchestrationMessageSummary {
  return {
    id: `idle-settle:${args.worker.dispatchId}`,
    from_handle: args.worker.terminalHandle ?? 'local-run',
    type: 'worker_done',
    subject: SETTLED_SUBJECT,
    body: args.body,
    payload: JSON.stringify({
      taskId: args.taskId,
      dispatchId: args.worker.dispatchId,
      outcome: args.outcome,
      reportPath: args.reportPath,
      filesModified: args.filesModified
    })
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The settler for one local Run, reading each live worker's node off the snapshot.
 *
 * Positional and terse on purpose: the runner is at its line budget, and none of this
 * wiring is the runner's subject.
 */
export function localRunIdleSettler(
  deps: { call: OrchestrationCaller; runtime: { getOrchestrationDb: () => IdleSettleStore } },
  host: WorkerHostContext,
  registry: WorkerUnitRegistry,
  nodes: Map<string, LocalRunNodeRuntimeLike>,
  snapshot: LocalRunSnapshot
): LocalRunIdleSettler {
  return new LocalRunIdleSettler({
    ctx: { call: deps.call, changed: () => host.changed() },
    host,
    registry,
    workspacePath: snapshot.workspacePath,
    nodeFor: (worker) => {
      const entry = [...nodes.values()].find((candidate) => candidate.unit === worker)
      return entry
        ? {
            taskId: entry.snapshot.taskId,
            reportPath: entry.snapshot.reportPath,
            // A gate or a question a person still owes an answer to. `gateQuestion` is
            // set for the whole life of a gated node, which is deliberate: a node a
            // person had to authorise is never completed by a file appearing on disk.
            hasOpenQuestion: Boolean(entry.snapshot.question || entry.snapshot.gateQuestion)
          }
        : null
    },
    settleWorkerReport: (args) => deps.runtime.getOrchestrationDb().settleWorkerReport(args)
  })
}
