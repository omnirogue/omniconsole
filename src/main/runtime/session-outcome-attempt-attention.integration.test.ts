import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  commitOneStagePlan,
  finiteRecoveryWorkers,
  idleHook,
  liveAttempt,
  recoveryFixture,
  runningAttempt,
  type RecoveryFixture
} from './session-outcome-attempt-recovery-test-fixture'
import { advanceSessionOutcomes } from './session-outcome-tick'

// "Needs you" is a request a person alone can meet — here, a live agent's own question — and it
// closes by itself when it is met. Everything else in this file is the other half of that rule:
// work that is already proven, runs that are finished, and chains that are somebody else's are
// never touched by recovery.

const fixtures: RecoveryFixture[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0).toReversed()) {
    await fixture.dispose()
  }
})

function fixture(
  behaviours: Parameters<typeof recoveryFixture>[0],
  restoreFrom?: string
): RecoveryFixture {
  const f = recoveryFixture(behaviours, restoreFrom)
  fixtures.push(f)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  return f
}

const attention = (f: RecoveryFixture, chainId = 'chain') =>
  f.service.get(chainId).outcomeSet!.attention ?? []

const PROMPTS = {
  clarification: {
    state: 'waiting' as const,
    interactivePrompt: JSON.stringify({
      questions: [{ question: 'Which database should I use?' }]
    }),
    text: 'Which database should I use?'
  },
  permission: {
    state: 'blocked' as const,
    interactivePrompt: JSON.stringify({ approval: { tool: 'Bash', summary: 'rm -rf build' } }),
    text: 'Bash rm -rf build'
  }
}

function askingHook(kind: keyof typeof PROMPTS) {
  return {
    ...idleHook(),
    state: PROMPTS[kind].state,
    interactivePrompt: PROMPTS[kind].interactivePrompt
  }
}

describe('an agent asking its person something', () => {
  it.each(['clarification', 'permission'] as const)(
    'is a %s request with the pane to answer in, closes when answered, and the run continues once',
    async (kind) => {
      const f = fixture(['hold'])
      await commitOneStagePlan(f)
      const worker = await runningAttempt(f)
      const hook = vi.mocked(f.runtime.getFreshAgentHookStatusForHandle)
      const workerPane = f.db.getDispatchContextById(worker.dispatchId)!.assignee_pane_key

      hook.mockReturnValue(askingHook(kind))
      await f.settle()

      // Alive and asking: never a stopped attempt, and the prompt is not an error.
      expect(liveAttempt(f)).toMatchObject({
        id: worker.id,
        state: 'running',
        awaiting: { kind, prompt: PROMPTS[kind].text, paneKey: workerPane }
      })
      expect(liveAttempt(f).error).toBeUndefined()
      expect(liveAttempt(f).failure).toBeUndefined()
      expect(attention(f)).toHaveLength(1)
      const request = attention(f)[0]!
      expect(request).toMatchObject({
        kind,
        state: 'open',
        recipient: { type: 'owner' },
        source: { type: 'agent-prompt' },
        scope: { outcomeId: 'work', stepId: 'work', attemptId: worker.id },
        action: { kind: 'open-conversation', paneKey: workerPane }
      })
      expect(request.ask).toContain(PROMPTS[kind].text)
      expect(request.why.length).toBeGreaterThan(0)
      expect(f.service.get('chain').outcomeSet!.outcomes[0]!.block).toMatchObject({
        class: 'attention',
        code: 'agent-prompt',
        attentionIds: [request.id]
      })
      expect(f.progress()).toMatchObject({ phase: 'needs-you', attention: [{ id: request.id }] })

      // Re-observed on later passes: the same request, opened once.
      f.advance(30_000)
      await f.settle()
      expect(attention(f)).toHaveLength(1)
      expect(attention(f)[0]).toMatchObject({ id: request.id, openedAt: request.openedAt })

      // The person answers in the agent's pane; the hook leaves the asking state.
      hook.mockReturnValue({ ...idleHook(), state: 'working' })
      f.advance(5_000)
      await f.settle()
      expect(attention(f)[0]).toMatchObject({ id: request.id, state: 'resolved' })
      expect(liveAttempt(f).awaiting).toBeUndefined()
      expect(f.progress().phase).toBe('active')

      hook.mockReturnValue(idleHook())
      await f.release()
      await f.settleUntil(() => f.progress().lifecycle === 'complete')
      // The same worker finished the work: nothing was relaunched, nothing was asked twice.
      expect(f.handles).toHaveLength(1)
      expect(f.attempts().map((attempt) => attempt.state)).toEqual(['completed'])
      expect(attention(f).filter((entry) => entry.state === 'open')).toEqual([])
    }
  )

  it('is still one request after the host restarts', async () => {
    const f = fixture(['silent'])
    await commitOneStagePlan(f)
    const worker = await runningAttempt(f)
    vi.mocked(f.runtime.getFreshAgentHookStatusForHandle).mockReturnValue(
      askingHook('clarification')
    )
    await f.settle()
    const before = attention(f)
    expect(before).toHaveLength(1)
    await f.service.suspend()
    f.closeDatabase()

    const reopened = fixture([], f.workspace)
    vi.mocked(reopened.runtime.getFreshAgentHookStatusForHandle).mockReturnValue(
      askingHook('clarification')
    )
    reopened.advance(60_000)
    for (let pass = 0; pass < 3; pass++) {
      await reopened.settle()
    }

    expect(attention(reopened)).toHaveLength(1)
    expect(attention(reopened)[0]).toMatchObject({
      id: before[0]!.id,
      state: 'open',
      openedAt: before[0]!.openedAt
    })
    expect(liveAttempt(reopened)).toMatchObject({ id: worker.id, state: 'running' })
    expect(reopened.handles).toHaveLength(0)
    expect(reopened.progress().phase).toBe('needs-you')
  })
})

describe('completion evidence wins', () => {
  it('settles an action whose proof is on disk although its worker timed out before reporting', async () => {
    const f = fixture(['silent', 'succeed'])
    await f.service.commit(
      {
        id: 'chain',
        workspacePath: f.workspace,
        worktreeId: 'folder:outcome',
        hostId: 'local',
        sourcePaneKey: 'source',
        sourceRowKey: 'row',
        auto: true,
        steps: [],
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
            id: 'result',
            title: 'Result',
            finish: 'complete',
            dependsOn: [],
            conditions: [{ id: 'file', kind: 'file', target: join(f.workspace, 'result.txt') }],
            actions: [
              {
                id: 'produce',
                instruction: 'Produce result.txt',
                agent: 'codex',
                conditionIds: ['file'],
                authority: 'existing-user-authority'
              }
            ]
          }
        ]
      }
    )
    f.service.dispose()
    const worker = await runningAttempt(f)

    // The worker wrote its result, then went quiet a moment before reporting it.
    f.write('result.txt', 'Produced just before the timeout')
    f.db.failReadyWorkerDispatch({
      dispatchId: worker.dispatchId,
      stage: 'input_accepted_stalled',
      reason: 'No activity was observed for 180s.'
    })
    await f.settleUntil(() => f.progress().lifecycle === 'complete')

    expect(f.attempts()).toHaveLength(1)
    expect(f.attempts()[0]).toMatchObject({ id: worker.id, state: 'completed' })
    expect(f.attempts()[0]!.error).toBeUndefined()
    // Nothing was run a second time, and nobody was asked anything.
    expect(f.handles).toHaveLength(1)
    expect(f.runtime.closeTerminal).not.toHaveBeenCalledWith(f.handles[0])
    expect(attention(f)).toEqual([])
  })
})

describe('what recovery never touches', () => {
  it('leaves a cancelled chain exactly as it was', async () => {
    const f = fixture(['silent', 'succeed'])
    await commitOneStagePlan(f)
    const worker = await runningAttempt(f)
    f.db.failDispatch(worker.dispatchId, 'Agent process exited with code 1', {
      workerProcessExited: true,
      terminationReason: 'exited'
    })
    await f.settle()
    expect(f.progress().phase).toBe('recovering')

    const chain = f.service.get('chain')
    f.persistence.replaceSessionChainOutcomesAndFlush(
      { ...chain, state: 'cancelled' },
      chain.outcomeSet!.revision
    )
    const cancelled = f.service.get('chain')
    f.advance(60_000)
    for (let pass = 0; pass < 3; pass++) {
      await f.settle()
    }
    // Asked directly as well: the pass itself refuses a cancelled run, whoever calls it.
    await advanceSessionOutcomes(f.service, f.service.get('chain'), f.now())
    await f.service.launches.settled()

    expect(f.handles).toHaveLength(1)
    expect(f.service.get('chain')).toEqual(cancelled)
  })

  it('recovers one chain without touching an unrelated live one', async () => {
    const f = fixture(['silent', 'hold', 'succeed'])
    finiteRecoveryWorkers(f)
    await commitOneStagePlan(f, { chainId: 'chain', stepId: 'work' })
    const dying = await runningAttempt(f, 'chain')
    await commitOneStagePlan(f, {
      chainId: 'other',
      stepId: 'other',
      sourcePaneKey: 'other-source'
    })
    const bystander = await runningAttempt(f, 'other')
    const bystanderHandle = f.handles[1]!

    f.db.failReadyWorkerDispatch({
      dispatchId: dying.dispatchId,
      stage: 'input_accepted_stalled',
      reason: 'No activity was observed for 180s.'
    })
    await f.settle()
    f.advance(15_000)
    await f.settleUntil(() => f.progress('chain').lifecycle === 'complete')

    // The dying chain's quiet worker was stopped and replaced; the bystander was not.
    expect(f.runtime.closeTerminal).toHaveBeenCalledWith(f.handles[0])
    expect(f.db.getWorkerTerminalResourceByOwner(dying.dispatchId)).toMatchObject({
      ownership_state: 'released',
      release_state: 'released',
      archive_status: 'captured'
    })
    expect(f.runtime.closeTerminal).not.toHaveBeenCalledWith(bystanderHandle)
    expect(f.attempts('other')).toHaveLength(1)
    expect(f.attempts('other')[0]).toMatchObject({ id: bystander.id, state: 'running' })
    expect(f.attempts('other')[0]!.failure).toBeUndefined()
    expect(attention(f, 'other')).toEqual([])

    await f.release()
    await f.settleUntil(() => f.progress('other').lifecycle === 'complete')
    expect(f.attempts('other').map((attempt) => attempt.state)).toEqual(['completed'])
    expect(f.handles).toHaveLength(3)
  })
})

describe('a lost execution host', () => {
  it('is a wait with a named wake, and the work is picked back up when the host returns', async () => {
    const f = fixture(['hold'])
    await commitOneStagePlan(f)
    const worker = await runningAttempt(f)
    const scope = vi.mocked(f.runtime.getSessionOutcomeExecutionScope)
    const outcome = () => f.service.get('chain').outcomeSet!.outcomes[0]!

    scope.mockRejectedValue(new Error('The execution host is unreachable.'))
    await f.settle()
    expect(outcome()).toMatchObject({
      status: 'blocked',
      blockedReason: 'The execution host is unreachable.',
      block: { class: 'waiting', code: 'execution-host-unverifiable', wake: 'execution host' }
    })
    expect(f.service.get('chain').outcomeSet!.continuation.state).toBe('unverifiable')
    // Lost contact proves nothing about the work, and asks nothing of the person.
    expect(f.progress()).toMatchObject({ phase: 'waiting', attention: [] })
    const since = outcome().block!.since

    f.advance(60_000)
    await f.settle()
    expect(outcome().block!.since).toBe(since)

    scope.mockResolvedValue({ path: f.workspace, connectionId: null } as never)
    await f.settle()
    expect(outcome().status).toBe('running')
    expect(outcome().block).toBeUndefined()
    expect(f.service.get('chain').outcomeSet!.continuation.state).toBe('owned')

    await f.release()
    await f.settleUntil(() => f.progress().lifecycle === 'complete')
    expect(f.handles).toHaveLength(1)
    expect(f.attempts()).toMatchObject([{ id: worker.id, state: 'completed' }])
    expect(attention(f)).toEqual([])
  })
})

describe('one effective dispatch', () => {
  it.each(['tick first', 'resume first'] as const)(
    'starts exactly one replacement when a tick and a Resume race (%s)',
    async (order) => {
      const f = fixture(['silent', 'succeed'])
      finiteRecoveryWorkers(f)
      await commitOneStagePlan(f)
      const first = await runningAttempt(f)
      f.db.failReadyWorkerDispatch({
        dispatchId: first.dispatchId,
        stage: 'input_accepted_stalled',
        reason: 'No activity was observed for 180s.'
      })
      await f.settle()
      f.advance(15_000)

      // Whoever gets the chain's lane first is parked inside it, mid-recovery, on the old worker's
      // stop — so the other one provably arrives while the replacement is still being decided.
      let confirmStop: (close: { ptyKilled: boolean }) => void = () => {}
      const stopping = new Promise<{ ptyKilled: boolean }>((resolve) => {
        confirmStop = resolve
      })
      const close = vi.mocked(f.runtime.closeTerminal)
      close.mockImplementationOnce(() => stopping as never)
      const revision = f.service.get('chain').outcomeSet!.revision
      const resume = (): Promise<unknown> => f.service.resume('chain', revision)
      const tick = (): Promise<unknown> => f.service.tick()

      const leader = order === 'tick first' ? tick() : resume()
      for (let turn = 0; turn < 2_000 && !close.mock.calls.length; turn++) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      expect(close).toHaveBeenCalledWith(f.handles[0])
      const follower = order === 'tick first' ? resume() : tick()
      confirmStop({ ptyKilled: true })
      await Promise.all([leader, follower])
      await f.settleUntil(() => f.progress().lifecycle === 'complete')

      expect(f.handles).toHaveLength(2)
      expect(f.db.getWorkerTerminalResourceByOwner(first.dispatchId)).toMatchObject({
        ownership_state: 'released',
        release_state: 'released',
        archive_status: 'captured'
      })
      expect(f.attempts().map((attempt) => attempt.state)).toEqual(['retryable', 'completed'])
      expect(new Set(f.attempts().map((attempt) => attempt.dispatchId)).size).toBe(2)
    }
  )
})
