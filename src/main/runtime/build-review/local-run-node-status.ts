import type { LocalRunNode } from '../../../shared/local-run-graph'
import { deriveLocalRunNodeState } from '../../../shared/local-run-node-state'
import type {
  LocalRunNodeSnapshot,
  LocalRunQuestionSnapshot,
  LocalRunSnapshot
} from '../../../shared/local-run-types'
import type { OrchestrationDb } from '../orchestration/db'
import type { WorkerUnitQuestion, WorkerUnitRegistry } from './build-review-worker-registry'
import type { LocalRunWorkerUnit } from './local-run-state'

/**
 * What the agent hook says about a worker's terminal. `waiting` and `blocked` both
 * mean the same thing to a person: that agent stopped and owes nothing until someone
 * answers it.
 */
export type LocalRunHookStatus = {
  state: 'working' | 'blocked' | 'waiting' | 'done'
  lastAssistantMessage: string | null
  /** When this state was entered; pinned across same-state pings, so it names the turn. */
  stateStartedAt: number
}

export type LocalRunNodeRuntimeLike = {
  node: LocalRunNode
  snapshot: LocalRunNodeSnapshot
  unit: LocalRunWorkerUnit
  /**
   * The terminal question this node's worker was already answered on. Without it a
   * hook row that still says `waiting` (the agent has not repainted yet) would
   * re-raise the question the person just answered.
   */
  answeredTerminalQuestionId: string | null
}

export type RefreshLocalRunNodeStatesArgs = {
  db: OrchestrationDb
  snapshot: LocalRunSnapshot
  nodes: Map<string, LocalRunNodeRuntimeLike>
  registry: WorkerUnitRegistry
  /** The agent hook row for a worker terminal, or null when there is no fresh one. */
  hook: (terminalHandle: string) => LocalRunHookStatus | null
}

function isLiveWorker(unit: LocalRunWorkerUnit): boolean {
  return unit.status === 'running' || unit.status === 'starting'
}

/**
 * The one question this node is waiting on, or null.
 *
 * An ask through the Run mailbox wins: it is an explicit question with a message the
 * answer can be delivered to. A worker that merely went `waiting` in its terminal
 * asked its own pane, not the Run, so its question is the last thing it said and the
 * answer has to be typed back into that terminal.
 */
export function localRunNodeQuestion(args: {
  entry: LocalRunNodeRuntimeLike
  mailboxQuestion: WorkerUnitQuestion | null
  hook: LocalRunHookStatus | null
  /** This node's Task row is already completed or failed. */
  taskSettled: boolean
}): LocalRunQuestionSnapshot | null {
  // Why: a settled Task means the Dispatch is settled, and the runtime then refuses
  // both answer paths — a reply is "closed because its Dispatch is inactive" and the
  // terminal is being torn down. Offering a reply box nobody can use is the defect
  // Build + Review already fixed on 2026-09-07. The Task row settles a beat before the
  // mailbox batch that says so is folded, and that beat is exactly this window.
  if (args.taskSettled) {
    return null
  }
  if (args.mailboxQuestion) {
    return {
      messageId: args.mailboxQuestion.messageId,
      source: 'mailbox',
      question: args.mailboxQuestion.question,
      options: args.mailboxQuestion.options,
      askedAt: args.mailboxQuestion.askedAt
    }
  }
  const { entry, hook } = args
  if (!hook || (hook.state !== 'waiting' && hook.state !== 'blocked')) {
    return null
  }
  if (!isLiveWorker(entry.unit) || !entry.unit.terminalHandle) {
    return null
  }
  const messageId = `terminal:${entry.unit.dispatchId ?? entry.unit.terminalHandle}:${hook.stateStartedAt}`
  if (entry.answeredTerminalQuestionId === messageId) {
    return null
  }
  return {
    messageId,
    source: 'terminal',
    question:
      hook.lastAssistantMessage?.trim() ||
      `${entry.node.id} stopped in its terminal and is waiting for an answer.`,
    options: [],
    askedAt: new Date(hook.stateStartedAt).toISOString()
  }
}

/**
 * Recompute every node's state from stored rows: the Task row, its worker Dispatch,
 * its decision gates, the question message its worker left open, and the agent hook
 * for its terminal. Nothing here is inferred from what the runner intended to do —
 * only from what the orchestration store and the hooks actually hold.
 *
 * This runs on every push, not once per batch: a node's whole turn happens INSIDE one
 * batch, so refreshing only between batches froze a running node at its last
 * between-batch state for as long as its worker ran.
 */
export function refreshLocalRunNodeStates(args: RefreshLocalRunNodeStatesArgs): void {
  for (const entry of args.nodes.values()) {
    const taskId = entry.snapshot.taskId
    const task = taskId ? args.db.getTask(taskId) : undefined
    const pendingGate = taskId ? args.db.listGates({ taskId, status: 'pending' }).at(-1) : undefined
    const dispatch = entry.unit.dispatchId
      ? args.db.getDispatchContextById(entry.unit.dispatchId)
      : undefined
    const question = localRunNodeQuestion({
      entry,
      mailboxQuestion: args.registry.pendingQuestionFor(entry.unit),
      hook: entry.unit.terminalHandle ? args.hook(entry.unit.terminalHandle) : null,
      taskSettled: task?.status === 'completed' || task?.status === 'failed'
    })
    entry.snapshot.gateId = pendingGate?.id ?? entry.snapshot.gateId
    entry.snapshot.question = question
    entry.snapshot.dispatchId = entry.unit.dispatchId
    entry.snapshot.terminalHandle = entry.unit.terminalHandle
    entry.snapshot.error = entry.unit.error
    entry.snapshot.state = deriveLocalRunNodeState({
      taskStatus: task?.status ?? null,
      dispatchStatus: dispatch?.status ?? null,
      pendingGate: Boolean(pendingGate),
      openQuestion: Boolean(question),
      presetId: entry.node.presetId
    })
  }
  args.snapshot.updatedAt = new Date().toISOString()
}
