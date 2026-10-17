import type { LocalRunSnapshot } from '../../../shared/local-run-types'
import type { OrcaRuntimeService } from '../omni-runtime'
import type { OrchestrationCaller } from './build-review-rpc-call'
import type { WorkerUnitRegistry } from './build-review-worker-registry'
import type { LocalRunNodeRuntimeLike } from './local-run-node-status'
import { pushLocalRunEvent } from './local-run-state'

export type LocalRunAnswerArgs = {
  runtime: OrcaRuntimeService
  call: OrchestrationCaller
  registry: WorkerUnitRegistry
  snapshot: LocalRunSnapshot
  nodes: Map<string, LocalRunNodeRuntimeLike>
  messageId: string
  body: string
}

/** How much of a person's answer is echoed into the run log; the whole answer is delivered. */
const EVENT_PREVIEW = 200

/**
 * Deliver a person's answer to the worker that is waiting for it.
 *
 * There are two ways a worker stops for a person and they are answered differently.
 * A worker that sent an ask through the Run mailbox is blocked inside
 * `orchestration.ask`, and only an `orchestration.reply` on that question message
 * releases it — the same path Build + Review's reply box uses. A worker that simply
 * stopped in its own terminal never told the Run anything, so there is no message to
 * reply to: the answer is delivered as a prompt into that terminal, exactly as a
 * person typing into the pane would.
 */
export async function answerLocalRunQuestion(args: LocalRunAnswerArgs): Promise<void> {
  const entry = [...args.nodes.values()].find(
    (candidate) => candidate.snapshot.question?.messageId === args.messageId
  )
  const question = entry?.snapshot.question
  if (!entry || !question) {
    throw new Error(`No node of this run is waiting on an answer to ${args.messageId}.`)
  }
  await (question.source === 'mailbox'
    ? answerThroughMailbox(args, entry)
    : answerThroughTerminal(args, entry))
  entry.snapshot.question = null
  pushLocalRunEvent(args.snapshot, 'node', entry.node.id, `Answered: ${preview(args.body)}`)
}

async function answerThroughMailbox(
  args: LocalRunAnswerArgs,
  entry: LocalRunNodeRuntimeLike
): Promise<void> {
  if (!args.snapshot.coordinatorTerminalHandle) {
    throw new Error('The run has no coordinator terminal to reply from.')
  }
  await args.call('orchestration.reply', {
    id: args.messageId,
    body: args.body,
    from: args.snapshot.coordinatorTerminalHandle,
    run: args.snapshot.runId ?? undefined
  })
  // Why clear it here and not wait for the next mailbox batch: the answer settles the
  // question row immediately, and a stale pending question would put the node straight
  // back to NEEDS INPUT on the very next refresh.
  args.registry.setPendingQuestion(entry.unit, null)
}

async function answerThroughTerminal(
  args: LocalRunAnswerArgs,
  entry: LocalRunNodeRuntimeLike
): Promise<void> {
  const handle = entry.unit.terminalHandle
  if (!handle) {
    throw new Error(`${entry.node.id} has no live terminal to answer.`)
  }
  await args.runtime.sendTerminalAgentPrompt(handle, args.body)
  // Why the id and not a flag: the id is pinned to the turn the agent stopped in, so
  // this suppresses only the question that was just answered. If the agent stops
  // again it starts a new turn and asks again.
  entry.answeredTerminalQuestionId = args.messageId
}

function preview(body: string): string {
  const trimmed = body.trim()
  return trimmed.length > EVENT_PREVIEW ? `${trimmed.slice(0, EVENT_PREVIEW)}…` : trimmed
}
