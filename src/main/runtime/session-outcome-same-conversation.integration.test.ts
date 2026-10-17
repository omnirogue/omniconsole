/**
 * WP-4b, driven through the real host tick: a step routed `same-session` continues the ORIGINAL
 * conversation instead of briefing a new agent.
 *
 * Nothing here asserts on the route's internals. Each test drives the same fixture the other
 * outcome integration tests use — real RPC dispatch, real persistence, real concurrency — and
 * substitutes only the two boundaries a conversation has: the bytes that go into its pane, and
 * the reading of the turn that came back.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { conversationSourceRowKey } from '../../shared/conversation-source'
import { SESSION_VERDICT_MARKER } from '../../shared/session-chain-verdict'
import type { PromptQueue } from '../../shared/prompt-queue-types'
import type { SessionChain, SessionChainAgentStep } from '../../shared/session-chain-types'
import { sessionOutcomeStepActionId } from '../../shared/session-outcome-identity'
import type { SessionOutcomeAttempt } from '../../shared/session-outcome-types'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'
import { SessionOutcomeService } from './session-outcome-service'
import {
  SAME_CONVERSATION_GONE,
  SAME_CONVERSATION_UNCONFIRMED
} from './session-outcome-conversation-turn'
import { fixtureOperationId } from '../../shared/session-host-wire-fixtures'
import { registerSessionHostConversation } from '../session-host/session-host-ownership-registry'
import { setRuntimeSessionHostProcessForTests } from '../session-host/session-host-runtime'
import {
  continueRequest,
  FakeSessionHostExecutor,
  remote,
  testHostProcess,
  testHostRoot,
  withoutOrigin
} from '../session-host/session-host-test-fixture'

type Fixture = ReturnType<typeof outcomeRuntimeFixture>
const fixtures: Fixture[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0).toReversed()) {
    await fixture.dispose()
  }
})

const SOURCE = { worktreeId: 'folder:outcome', paneKey: 'source' }
const SOURCE_ROW = conversationSourceRowKey(SOURCE)

/** The original conversation, as its pane reads from outside: one turn at a time. */
type Conversation = {
  state: 'done' | 'working'
  stateStartedAt: number
  lastAssistantMessage: string
}

type Harness = Fixture & {
  conversation: Conversation
  /** Every delivery into the ORIGINAL conversation, in order, with its idempotency key. */
  delivered: { text: string; operationId?: string }[]
  /** The agent picks the delivered turn up, works, and answers. */
  answer: (text: string) => void
  paneLost: () => void
  queue: (entries: PromptQueue['entries']) => void
}

function harness(): Harness {
  const fixture = outcomeRuntimeFixture((spec, workspace) => {
    const id = /STEP:(\w+)/.exec(spec)![1]!
    if (id === 'verify') {
      writeFileSync(join(workspace, 'verified.txt'), 'the outcome holds')
    }
    return { body: `REPORT_FROM_${id}` }
  })
  fixtures.push(fixture)
  const conversation: Conversation = {
    state: 'done',
    stateStartedAt: 1_000,
    lastAssistantMessage: 'I finished the first pass.'
  }
  let paneLost = false
  const delivered: Harness['delivered'] = []
  const queues: Record<string, PromptQueue> = {}
  const resolvePane = vi.mocked(fixture.runtime.resolveTerminalPane).getMockImplementation()
  vi.spyOn(fixture.runtime, 'resolveTerminalPane').mockImplementation((paneKey, worktreeId) => {
    if (paneKey === SOURCE.paneKey && paneLost) {
      throw new Error('terminal_not_found')
    }
    return resolvePane!(paneKey, worktreeId)
  })
  const hook = vi.mocked(fixture.runtime.getFreshAgentHookStatusForHandle).getMockImplementation()
  vi.spyOn(fixture.runtime, 'getFreshAgentHookStatusForHandle').mockImplementation((handle) =>
    handle === 'source'
      ? ({
          state: conversation.state,
          stateStartedAt: conversation.stateStartedAt,
          lastAssistantMessage: conversation.lastAssistantMessage,
          interactivePrompt: null,
          updatedAt: conversation.stateStartedAt
        } as ReturnType<typeof fixture.runtime.getFreshAgentHookStatusForHandle>)
      : hook!(handle)
  )
  // The journal read every settlement uses; it answers for a finished turn and nothing else.
  vi.spyOn(fixture.runtime, 'readSessionOutcomeSourceContext').mockImplementation(async () =>
    conversation.state === 'done'
      ? {
          paneKey: SOURCE.paneKey,
          handle: 'source',
          processIncarnation: 'test:source:1',
          agent: 'claude',
          model: 'opus-4',
          summary: conversation.lastAssistantMessage,
          files: []
        }
      : null
  )
  const send = vi.mocked(fixture.runtime.sendTerminalAgentPrompt).getMockImplementation()
  vi.spyOn(fixture.runtime, 'sendTerminalAgentPrompt').mockImplementation(
    async (handle, text, options) => {
      if (handle !== 'source') {
        return send!(handle, text, options)
      }
      delivered.push({
        text,
        ...(options?.clientMessageId ? { operationId: options.clientMessageId } : {})
      })
      conversation.state = 'working'
      conversation.stateStartedAt += 1
      return { handle, accepted: true, bytesWritten: text.length }
    }
  )
  vi.spyOn(fixture.runtime, 'listPromptQueues').mockImplementation(() => queues)
  vi.spyOn(fixture.runtime, 'readPromptQueue').mockImplementation(
    (rowKey) => queues[rowKey] ?? null
  )
  return {
    ...fixture,
    conversation,
    delivered,
    answer: (text) => {
      conversation.state = 'done'
      conversation.stateStartedAt += 1
      conversation.lastAssistantMessage = text
    },
    paneLost: () => {
      paneLost = true
    },
    queue: (entries) => {
      queues[SOURCE_ROW] = { source: { ...SOURCE, kind: 'pty' }, entries }
    }
  }
}

/** Sal's acceptance E′: Improve continues the conversation, reviewers run in parallel, verify, me. */
function steps(): SessionChainAgentStep[] {
  const reviewer = (id: string): SessionChainAgentStep =>
    ({
      id,
      outcomeId: 'ship',
      agent: 'codex',
      prompt: `STEP:${id}`,
      status: 'queued',
      group: 'council',
      readsFrom: ['improve'],
      route: 'new-session'
    }) as SessionChainAgentStep
  return [
    {
      id: 'improve',
      outcomeId: 'ship',
      agent: 'claude',
      prompt: 'STEP:improve',
      status: 'queued',
      route: 'same-session'
    } as SessionChainAgentStep,
    reviewer('r1'),
    reviewer('r2'),
    reviewer('r3'),
    {
      id: 'verify',
      outcomeId: 'ship',
      agent: 'codex',
      prompt: 'STEP:verify',
      status: 'queued',
      readsFrom: ['r1', 'r2', 'r3'],
      route: 'new-session'
    } as SessionChainAgentStep
  ]
}

async function commit(f: Harness, plan = steps()): Promise<void> {
  await f.service.commit(
    {
      id: 'chain',
      workspacePath: f.workspace,
      worktreeId: 'folder:outcome',
      hostId: 'local',
      sourcePaneKey: SOURCE.paneKey,
      sourceRowKey: SOURCE_ROW,
      auto: true,
      end: 'me',
      steps: plan,
      currentIndex: 0,
      state: 'waiting',
      createdAt: 1,
      updatedAt: 1
    },
    {
      expectedRevision: 0,
      source: 'user',
      outcomes: [
        {
          id: 'ship',
          title: 'Ship the checkout fix',
          finish: 'complete',
          dependsOn: [],
          stepIds: plan.map((step) => step.id),
          actions: [],
          conditions: [{ id: 'verified', kind: 'file', target: join(f.workspace, 'verified.txt') }]
        }
      ]
    }
  )
  f.service.dispose()
}

const attemptOf = (f: Harness, stepId: string): SessionOutcomeAttempt | undefined =>
  f.service
    .get('chain')
    .outcomeSet!.attempts.findLast(
      (attempt) => attempt.actionId === sessionOutcomeStepActionId(stepId)
    )

const launchedIds = (f: Harness): string[] => f.launched.map((spec) => /STEP:(\w+)/.exec(spec)![1]!)

const completed = (f: Harness): string[] => f.service.get('chain').outcomeSet!.completedSteps ?? []

describe('a step routed same-session continues the original conversation', () => {
  it('delivers the step brief into the conversation and starts no worker', async () => {
    const f = harness()
    await commit(f)

    await f.service.tick()

    expect(f.delivered).toHaveLength(1)
    expect(f.delivered[0]!.text).toContain('STEP:improve')
    expect(f.delivered[0]!.operationId).toMatch(/^\d{13}-[0-9a-f]{32}$/)
    // No Run, no Task, no Dispatch: nothing reached the worker launcher.
    expect(launchedIds(f)).toEqual([])
    const attempt = attemptOf(f, 'improve')!
    expect(attempt.state).toBe('running')
    expect(attempt.launchDisposition).toBe('started')
    expect(attempt.taskId).toBeUndefined()
    expect(attempt.conversationTurn).toMatchObject({
      paneKey: 'source',
      worktreeId: 'folder:outcome',
      kind: 'pty'
    })
  })

  it('settles on the turn that answered, and writes it as the step report', async () => {
    const f = harness()
    await commit(f)
    await f.service.tick()

    // Still working: the same attempt, no settlement, no second delivery.
    await f.service.tick()
    expect(attemptOf(f, 'improve')!.state).toBe('running')
    expect(f.delivered).toHaveLength(1)

    f.answer('IMPROVED: the checkout retries on a declined card.')
    await f.settle()
    // The seats that read it start on the tick after its report lands.
    await f.settle()

    const attempt = attemptOf(f, 'improve')!
    expect(attempt.state).toBe('completed')
    expect(completed(f)).toContain('improve')
    expect(attempt.conversationTurn!.reportPath).toContain(
      join('.omni', 'runs', 'chain', 'improve')
    )
    // The report is what its readers read: the reviewers' briefs carry the continued turn's words.
    const brief = f.launched.find((spec) => spec.includes('STEP:r1'))!
    expect(brief).toContain('=== improve ===')
    expect(brief).toContain('IMPROVED: the checkout retries on a declined card.')
  })

  it('runs the reviewers in parallel after it, then the verifier (acceptance E′)', async () => {
    const f = harness()
    await commit(f)
    await f.service.tick()
    f.answer('IMPROVED: ready for review.')

    const rounds: string[][] = []
    for (let index = 0; index < 12; index++) {
      const before = f.launched.length
      await f.settle()
      rounds.push(launchedIds(f).slice(before))
    }

    expect(rounds.find((round) => round.length > 1)).toEqual(['r1', 'r2', 'r3'])
    expect(launchedIds(f)).toEqual(['r1', 'r2', 'r3', 'verify'])
    expect(completed(f)).toEqual(['improve', 'r1', 'r2', 'r3', 'verify'])
    expect(f.service.get('chain').outcomeSet!.outcomes[0]!.status).toBe('satisfied')
    // One conversation, one turn: the continued step was delivered exactly once.
    expect(f.delivered).toHaveLength(1)
  })

  it('counts the waiting continued step as one running seat and clamps nothing else', async () => {
    const f = harness()
    await commit(f)
    // Something else is mid-delivery on this conversation, so the turn cannot go out yet.
    f.queue([
      {
        id: 'q1',
        text: 'and check the logs',
        createdAt: 1,
        state: 'sending',
        operationId: 'prompt-queue:1',
        deliveryEpoch: f.service.epoch
      }
    ])

    await f.service.tick()

    expect(f.delivered).toEqual([])
    expect(attemptOf(f, 'improve')!.state).toBe('launching')
    // Honest capacity: it holds exactly one of the chain's seats while it waits, and no error is
    // written on it, because an attempt carrying an error blocks its outcome.
    expect(
      f.service
        .get('chain')
        .outcomeSet!.attempts.filter((entry) =>
          ['prepared', 'launching', 'running'].includes(entry.state)
        )
    ).toHaveLength(1)
    expect(attemptOf(f, 'improve')!.error).toBeUndefined()
    // And the chain is NOT clamped to one agent because a step continues a conversation.
    expect(f.service.get('chain').outcomeSet!.outcomes[0]!.status).not.toBe('blocked')
    expect(f.runtime.getOutcomeChainMaxConcurrentAgents()).toBeGreaterThan(1)
  })
})

describe('the conversation is the handle, so its absence is a refusal', () => {
  it('blocks with plain words when the pane is gone, and never starts a new session', async () => {
    const f = harness()
    await commit(f)
    f.paneLost()

    await f.service.tick()
    // The tick after the refusal is where the plan reads it: the outcome blocks with the same
    // words, exactly as it does for a worker whose launch could not start.
    await f.service.tick()

    const attempt = attemptOf(f, 'improve')!
    expect(attempt.state).toBe('blocked')
    expect(attempt.error).toBe(SAME_CONVERSATION_GONE)
    expect(attempt.launchDisposition).toBe('not-started')
    expect(f.delivered).toEqual([])
    expect(launchedIds(f)).toEqual([])
    expect(f.service.get('chain').outcomeSet!.outcomes[0]!.blockedReason).toBe(
      SAME_CONVERSATION_GONE
    )
    // Nothing after it runs: a blocked outcome does not advance.
    expect(completed(f)).toEqual([])
  })

  it('blocks when the conversation ends between the delivery and the answer', async () => {
    const f = harness()
    await commit(f)
    await f.service.tick()
    expect(f.delivered).toHaveLength(1)

    f.paneLost()
    await f.service.tick()

    expect(attemptOf(f, 'improve')!.state).toBe('blocked')
    expect(completed(f)).not.toContain('improve')
  })
})

describe('one conversation, one sender', () => {
  it('never delivers while a queued prompt of the person is being sent', async () => {
    const f = harness()
    await commit(f)
    f.queue([
      {
        id: 'q1',
        text: 'and check the logs',
        createdAt: 1,
        state: 'sending',
        operationId: 'prompt-queue:1',
        deliveryEpoch: f.service.epoch
      }
    ])

    await f.service.tick()
    expect(f.delivered).toEqual([])
    expect(attemptOf(f, 'improve')!.state).toBe('launching')

    f.queue([
      { id: 'q1', text: 'and check the logs', createdAt: 1, state: 'delivered', deliveredAt: 2 }
    ])
    await f.service.tick()
    expect(f.delivered).toHaveLength(1)
  })

  it('holds the person queue while the plan owns the turn', async () => {
    const f = harness()
    await commit(f)
    f.queue([{ id: 'q1', text: 'and check the logs', createdAt: 1, state: 'queued' }])

    await f.service.tick()

    // The drain runs at the head of every tick; a live plan on this conversation is a reason
    // to wait, so the person's text is still queued and only the plan's turn went out.
    expect(f.delivered).toHaveLength(1)
    expect(f.delivered[0]!.operationId).toMatch(/^\d{13}-[0-9a-f]{32}$/)
  })
})

describe('an adopted conversation shares one turn with every other computer', () => {
  it('waits, sending nothing, while another computer holds the turn, then continues once', async () => {
    const f = harness()
    const root = testHostRoot()
    const process = testHostProcess({
      root: root.root,
      incarnation: 'runtime-chain',
      executor: new FakeSessionHostExecutor()
    })
    setRuntimeSessionHostProcessForTests(process)
    try {
      const host = await process.service()
      const registered = await registerSessionHostConversation(host.store, {
        provider: { agent: 'claude', sessionId: 'source-session' },
        binding: { ...SOURCE, kind: 'pty' },
        workspace: { kind: 'folder', path: f.workspace },
        processIncarnation: 'test:source:1',
        adopted: true
      })
      if (registered.status !== 'ok') {
        throw new Error(registered.refusal.message)
      }
      const { conversationId } = registered.registration
      const laptop = remote('paired:laptop')
      await host.reserve(withoutOrigin(continueRequest(1, conversationId)), laptop)
      await commit(f)

      await f.service.tick()
      expect(f.delivered).toEqual([])
      const waiting = attemptOf(f, 'improve')!
      expect(waiting.state).not.toBe('blocked')
      expect(waiting.launchDisposition).not.toBe('unverifiable')

      await host.release(
        { operationId: fixtureOperationId(2), conversationId, reservation: fixtureOperationId(1) },
        laptop
      )
      await f.service.tick()
      expect(f.delivered).toHaveLength(1)
      expect(f.delivered[0]!.text).toContain('STEP:improve')
    } finally {
      setRuntimeSessionHostProcessForTests(null)
      root.dispose()
    }
  })
})

describe('a restart reconciles the delivery instead of repeating it', () => {
  it('never delivers a second time for an attempt this host already sent', async () => {
    const f = harness()
    await commit(f)
    await f.service.tick()
    await f.service.suspend()

    const restarted = new SessionOutcomeService(f.runtime)
    await restarted.tick()
    await restarted.launches.settled()

    expect(f.delivered).toHaveLength(1)
    f.answer('IMPROVED after the restart.')
    await restarted.tick()
    await restarted.launches.settled()
    expect(
      restarted
        .get('chain')
        .outcomeSet!.attempts.findLast(
          (attempt) => attempt.actionId === sessionOutcomeStepActionId('improve')
        )!.state
    ).toBe('completed')
    expect(f.delivered).toHaveLength(1)
    await restarted.suspend()
  })

  it('records a send it cannot account for, and re-sends nothing', async () => {
    const f = harness()
    await commit(f)
    await f.service.tick()
    // The state a host that died between the receipt and the bytes leaves behind.
    const held = f.service.get('chain')
    f.persistence.replaceSessionChainOutcomesAndFlush(
      {
        ...held,
        outcomeSet: {
          ...held.outcomeSet!,
          attempts: held.outcomeSet!.attempts.map((attempt) =>
            attempt.actionId === sessionOutcomeStepActionId('improve')
              ? {
                  ...attempt,
                  state: 'launching' as const,
                  conversationTurn: {
                    ...attempt.conversationTurn!,
                    epoch: 'a-process-that-is-gone',
                    deliveredAt: undefined
                  }
                }
              : attempt
          )
        }
      } as SessionChain,
      held.outcomeSet!.revision
    )
    await f.service.suspend()

    const restarted = new SessionOutcomeService(f.runtime)
    await restarted.tick()
    await restarted.launches.settled()

    const attempt = restarted
      .get('chain')
      .outcomeSet!.attempts.findLast(
        (entry) => entry.actionId === sessionOutcomeStepActionId('improve')
      )!
    expect(attempt.state).toBe('blocked')
    expect(attempt.error).toBe(SAME_CONVERSATION_UNCONFIRMED)
    expect(f.delivered).toHaveLength(1)
    await restarted.suspend()
  })
})

describe('a continued seat is a seat: it carries the verdict contract too', () => {
  it('is briefed with the marker suffix and its verdict receipt is spent', async () => {
    const f = harness()
    await commit(f, [
      {
        id: 'verify',
        outcomeId: 'ship',
        agent: 'codex',
        prompt: 'STEP:verify',
        status: 'queued',
        planNodeId: 'verify',
        route: 'new-session'
      } as SessionChainAgentStep,
      {
        id: 'improve',
        outcomeId: 'ship',
        agent: 'claude',
        prompt: 'STEP:improve',
        status: 'queued',
        route: 'same-session',
        planNodeId: 'improve',
        readsFrom: ['verify'],
        verdict: { kind: 'verify', over: ['verify'], consumed: 'record' }
      } as SessionChainAgentStep
    ])
    // The seat before it is an ordinary worker; the continued seat judges what it produced.
    for (let index = 0; index < 4 && f.delivered.length === 0; index++) {
      await f.settle()
    }

    // WP-3's suffix reached the conversation, naming the seat, its attempt and the pinned version.
    const brief = f.delivered[0]!.text
    expect(brief).toContain(SESSION_VERDICT_MARKER)
    const attemptId = /Launch attempt: (\S+?)\./.exec(brief)![1]!
    const candidateVersion = /candidate version: ([0-9a-f]+)\./.exec(brief)![1]!
    f.answer(
      `I checked what it produced.\n${SESSION_VERDICT_MARKER} ${JSON.stringify({
        kind: 'verify',
        status: 'pass',
        stepId: 'improve',
        blockingFindings: [],
        attemptId,
        candidateVersion
      })}`
    )
    await f.settle()
    await f.settle()

    const receipts = (f.service.get('chain').verdicts ?? []).filter(
      (receipt) => receipt.stepId === 'improve' && !receipt.skipped
    )
    expect(receipts).toHaveLength(1)
    expect(receipts[0]!.verdict).toMatchObject({ kind: 'verify', status: 'pass' })
    expect(completed(f)).toContain('improve')
  })
})
