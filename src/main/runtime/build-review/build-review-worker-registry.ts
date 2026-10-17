import type { OrchestrationMessageSummary } from '../../../shared/orchestration-check-output'
import type {
  BuildReviewAgentChoice,
  BuildReviewEventKind,
  BuildReviewWorkerReport,
  BuildReviewWorkerStatus
} from '../../../shared/build-review-pipeline'
import type { SessionEffortParity } from '../../../shared/session-effort-parity'

/**
 * One dispatched worker, whatever the caller calls its role. Build + Review's
 * `BuildReviewWorkerSnapshot` and a local DAG node both satisfy this shape, so the
 * lifecycle, the mailbox fold and the registry below are written once for both.
 */
export type WorkerUnitLike = {
  role: string
  choice: BuildReviewAgentChoice
  /** Requested vs reported model/effort for this worker's start; written by startWorker. */
  effortParity?: SessionEffortParity
  status: BuildReviewWorkerStatus
  taskId: string | null
  dispatchId: string | null
  terminalHandle: string | null
  /** Set once that terminal is known closed, so nothing offers to open it. */
  terminalClosed?: boolean
  report: BuildReviewWorkerReport | null
  error: string | null
  /** The startup prompt only a person can answer; set when a start ends there. */
  startupBlocker?: string
}

export type WorkerUnitQuestion = {
  messageId: string
  role: string
  question: string
  options: string[]
  askedAt: string
}

/**
 * Where one check Delivery is folded. A Run has exactly one mailbox, so a batch can
 * carry messages for several workers at once; every message is routed by its
 * `payload.dispatchId` first and only then by the sending terminal.
 */
export type WorkerMailboxTarget = {
  workerForDispatch: (dispatchId: string | undefined) => WorkerUnitLike | null
  workerForTerminal: (handle: string | undefined) => WorkerUnitLike | null
  /** The open question this worker owns, or null. Per worker, never per Run. */
  pendingQuestionFor: (worker: WorkerUnitLike) => WorkerUnitQuestion | null
  setPendingQuestion: (worker: WorkerUnitLike, question: WorkerUnitQuestion | null) => void
  log: (kind: BuildReviewEventKind, role: string, text: string) => void
  /**
   * Keep a message for a dispatch nobody is bound to yet. A worker can report before its start
   * returned to the caller, and a message dropped then is gone: it is marked seen and acked.
   */
  hold?: (dispatchId: string, message: OrchestrationMessageSummary) => void
}

function isLive(worker: WorkerUnitLike): boolean {
  return worker.status === 'running' || worker.status === 'starting'
}

/**
 * Every worker of one Run, keyed by dispatch id. It owns the per-worker pending
 * question and the promise each worker's caller awaits: with a single mailbox pump
 * per Run, nothing but the pump may resolve those promises.
 */
export class WorkerUnitRegistry {
  private readonly byDispatch = new Map<string, WorkerUnitLike>()
  private readonly questions = new Map<WorkerUnitLike, WorkerUnitQuestion>()
  private readonly held = new Map<string, OrchestrationMessageSummary[]>()
  private readonly waiters = new Map<
    WorkerUnitLike,
    { settle: () => void; fail: (e: Error) => void }
  >()

  /**
   * Record the dispatch a started worker was given; later batches route to it by this id.
   * Returns what arrived for it before this call, for the caller to fold in now.
   */
  bind(worker: WorkerUnitLike, dispatchId: string): OrchestrationMessageSummary[] {
    worker.dispatchId = dispatchId
    this.byDispatch.set(dispatchId, worker)
    const early = this.held.get(dispatchId) ?? []
    this.held.delete(dispatchId)
    return early
  }

  hold(dispatchId: string, message: OrchestrationMessageSummary): void {
    this.held.set(dispatchId, [...(this.held.get(dispatchId) ?? []), message])
  }

  forDispatch(dispatchId: string | undefined): WorkerUnitLike | null {
    return dispatchId ? (this.byDispatch.get(dispatchId) ?? null) : null
  }

  forTerminal(handle: string | undefined): WorkerUnitLike | null {
    if (!handle) {
      return null
    }
    for (const worker of this.byDispatch.values()) {
      if (worker.terminalHandle === handle) {
        return worker
      }
    }
    return null
  }

  pendingQuestionFor(worker: WorkerUnitLike): WorkerUnitQuestion | null {
    return this.questions.get(worker) ?? null
  }

  setPendingQuestion(worker: WorkerUnitLike, question: WorkerUnitQuestion | null): void {
    if (question) {
      this.questions.set(worker, question)
    } else {
      this.questions.delete(worker)
    }
  }

  /** Every question still waiting for an answer, with the worker that asked it. */
  openQuestions(): { worker: WorkerUnitLike; question: WorkerUnitQuestion }[] {
    return [...this.questions].map(([worker, question]) => ({ worker, question }))
  }

  /** Workers this Run has dispatched and that have not reported yet. */
  live(): WorkerUnitLike[] {
    return [...this.byDispatch.values()].filter(isLive)
  }

  /**
   * Resolves once the worker stops running. Only `notify()` (called by the pump after
   * it folded a batch) and `fail()` settle it, so a per-worker `check --wait` — which
   * the Run would refuse as a second exclusive waiter — is never needed.
   */
  waitFor(worker: WorkerUnitLike): Promise<void> {
    if (!isLive(worker)) {
      return Promise.resolve()
    }
    const existing = this.waiters.get(worker)
    if (existing) {
      throw new Error(`${worker.role}: this worker is already awaited.`)
    }
    return new Promise<void>((resolve, reject) => {
      this.waiters.set(worker, { settle: resolve, fail: reject })
    })
  }

  /** Resolve every awaited worker that has stopped running. */
  notify(): void {
    // Snapshot first: settling a waiter deletes it from the map being iterated.
    const awaited = [...this.waiters]
    for (const [worker, waiter] of awaited) {
      if (!isLive(worker)) {
        this.waiters.delete(worker)
        waiter.settle()
      }
    }
  }

  /** The pump died or the Run was cancelled: nobody else can settle these promises. */
  fail(error: Error): void {
    const awaited = [...this.waiters]
    for (const [worker, waiter] of awaited) {
      this.waiters.delete(worker)
      waiter.fail(error)
    }
  }

  /** Stop routing to a released worker; its question can no longer be answered. */
  forget(worker: WorkerUnitLike): void {
    this.questions.delete(worker)
    if (worker.dispatchId) {
      this.byDispatch.delete(worker.dispatchId)
    }
  }

  asMailboxTarget(log: WorkerMailboxTarget['log']): WorkerMailboxTarget {
    return {
      workerForDispatch: (dispatchId) => this.forDispatch(dispatchId),
      workerForTerminal: (handle) => this.forTerminal(handle),
      pendingQuestionFor: (worker) => this.pendingQuestionFor(worker),
      setPendingQuestion: (worker, question) => this.setPendingQuestion(worker, question),
      hold: (dispatchId, message) => this.hold(dispatchId, message),
      log
    }
  }
}
