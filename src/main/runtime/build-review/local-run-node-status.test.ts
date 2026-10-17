import { describe, expect, it } from 'vitest'
import type { LocalRunNode } from '../../../shared/local-run-graph'
import { deriveLocalRunNodeState } from '../../../shared/local-run-node-state'
import type { LocalRunNodeSnapshot } from '../../../shared/local-run-types'
import type { WorkerUnitQuestion } from './build-review-worker-registry'
import {
  localRunNodeQuestion,
  type LocalRunHookStatus,
  type LocalRunNodeRuntimeLike
} from './local-run-node-status'
import { createLocalRunWorkerUnit } from './local-run-state'

const NODE: LocalRunNode = {
  id: 'plan',
  actor: { agent: 'codex' },
  presetId: 'plan',
  objective: 'plan three cuts',
  deps: []
}

const MAILBOX_QUESTION: WorkerUnitQuestion = {
  messageId: 'msg_1',
  role: 'plan',
  question: 'Cut b or cut c?',
  options: ['b', 'c'],
  askedAt: '2026-09-10T00:00:00.000Z'
}

function hook(overrides: Partial<LocalRunHookStatus> = {}): LocalRunHookStatus {
  return {
    state: 'waiting',
    lastAssistantMessage: 'Should I use the wide shot or the close-up?',
    stateStartedAt: 1_757_000_000_000,
    ...overrides
  }
}

/** One node as the runner holds it: a live worker on dispatch ctx_1, terminal term_w. */
function entry(
  overrides: {
    status?: LocalRunNodeRuntimeLike['unit']['status']
    dispatchId?: string | null
    terminalHandle?: string | null
    answeredTerminalQuestionId?: string | null
  } = {}
): LocalRunNodeRuntimeLike {
  const unit = createLocalRunWorkerUnit(NODE)
  unit.status = overrides.status ?? 'running'
  unit.dispatchId = overrides.dispatchId === undefined ? 'ctx_1' : overrides.dispatchId
  unit.terminalHandle = overrides.terminalHandle === undefined ? 'term_w' : overrides.terminalHandle
  return {
    node: NODE,
    snapshot: { id: NODE.id, question: null } as unknown as LocalRunNodeSnapshot,
    unit,
    answeredTerminalQuestionId: overrides.answeredTerminalQuestionId ?? null
  }
}

/** The state a node ends up in, from exactly the rows the refresh reads. */
function stateFor(args: {
  mailboxQuestion?: WorkerUnitQuestion | null
  hook?: LocalRunHookStatus | null
  taskStatus?: Parameters<typeof deriveLocalRunNodeState>[0]['taskStatus']
  dispatchStatus?: Parameters<typeof deriveLocalRunNodeState>[0]['dispatchStatus']
  node?: LocalRunNodeRuntimeLike
}) {
  const taskStatus = args.taskStatus ?? 'ready'
  const question = localRunNodeQuestion({
    entry: args.node ?? entry(),
    mailboxQuestion: args.mailboxQuestion ?? null,
    hook: args.hook ?? null,
    taskSettled: taskStatus === 'completed' || taskStatus === 'failed'
  })
  return {
    question,
    state: deriveLocalRunNodeState({
      taskStatus,
      dispatchStatus: args.dispatchStatus === undefined ? 'dispatched' : args.dispatchStatus,
      pendingGate: false,
      openQuestion: Boolean(question),
      presetId: NODE.presetId
    })
  }
}

describe('localRunNodeQuestion', () => {
  it('surfaces a mailbox ask with the message id a reply is delivered to', () => {
    const { question, state } = stateFor({ mailboxQuestion: MAILBOX_QUESTION })

    expect(question).toEqual({
      messageId: 'msg_1',
      source: 'mailbox',
      question: 'Cut b or cut c?',
      options: ['b', 'c'],
      askedAt: '2026-09-10T00:00:00.000Z'
    })
    expect(state).toBe('needs-input')
  })

  it('surfaces a worker that only stopped in its terminal, with its last assistant text', () => {
    const { question, state } = stateFor({ hook: hook() })

    expect(question).toMatchObject({
      source: 'terminal',
      question: 'Should I use the wide shot or the close-up?',
      options: []
    })
    // Pinned to the turn, so a reply cannot land on a later one.
    expect(question?.messageId).toBe('terminal:ctx_1:1757000000000')
    expect(state).toBe('needs-input')
  })

  it('treats a blocked hook the same as a waiting one', () => {
    expect(stateFor({ hook: hook({ state: 'blocked' }) }).state).toBe('needs-input')
  })

  it('names the node when the hook carried no assistant text', () => {
    const { question } = stateFor({ hook: hook({ lastAssistantMessage: null }) })

    expect(question?.question).toBe('plan stopped in its terminal and is waiting for an answer.')
  })

  it('prefers the mailbox ask when the worker did both', () => {
    const { question } = stateFor({ mailboxQuestion: MAILBOX_QUESTION, hook: hook() })

    expect(question?.source).toBe('mailbox')
  })

  it('asks nothing while the agent is working or done', () => {
    expect(stateFor({ hook: hook({ state: 'working' }) }).question).toBeNull()
    expect(stateFor({ hook: hook({ state: 'done' }) }).question).toBeNull()
    expect(stateFor({ hook: hook({ state: 'working' }) }).state).toBe('running')
  })

  it('does not re-ask the question the person already answered', () => {
    const answered = entry({ answeredTerminalQuestionId: 'terminal:ctx_1:1757000000000' })

    const { question, state } = stateFor({ hook: hook(), node: answered })

    expect(question).toBeNull()
    // Back to RUNNING: the answer was delivered and the worker owns the turn again.
    expect(state).toBe('running')
  })

  it('asks again when the agent stops a second time, on a new turn', () => {
    const answered = entry({ answeredTerminalQuestionId: 'terminal:ctx_1:1757000000000' })

    const { question } = stateFor({
      hook: hook({ stateStartedAt: 1_757_000_099_000 }),
      node: answered
    })

    expect(question?.messageId).toBe('terminal:ctx_1:1757000099000')
  })

  it('asks nothing for a worker that is no longer live or has no terminal', () => {
    expect(stateFor({ hook: hook(), node: entry({ status: 'succeeded' }) }).question).toBeNull()
    expect(stateFor({ hook: hook(), node: entry({ terminalHandle: null }) }).question).toBeNull()
  })

  it('never offers a question on a settled node, whatever the hook still says', () => {
    // The Task row settles a beat before the worker_done batch is folded, and a reply
    // to a settled Dispatch is refused: a reply box nobody can use is worse than none.
    expect(stateFor({ hook: hook(), taskStatus: 'completed' })).toEqual({
      question: null,
      state: 'completed'
    })
    expect(stateFor({ mailboxQuestion: MAILBOX_QUESTION, taskStatus: 'failed' })).toEqual({
      question: null,
      state: 'failed'
    })
  })

  it('is QUEUED with no dispatch and no question', () => {
    expect(stateFor({ dispatchStatus: null }).state).toBe('queued')
  })
})
