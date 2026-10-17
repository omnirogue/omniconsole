import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'
import type { SessionChainAgentStep } from '../../shared/session-chain-types'
import { sessionOutcomeProgress } from '../../shared/session-outcome-state'
import {
  sessionOutcomeRecovery,
  SESSION_OUTCOME_RECOVERY
} from '../../shared/session-outcome-recovery-reason'
import { sessionOutcomeStepActionId } from '../../shared/session-outcome-identity'

type Fixture = ReturnType<typeof outcomeRuntimeFixture>
const fixtures: Fixture[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0).toReversed()) {
    await fixture.dispose()
  }
})

/** One seat of a pair dies on its first run; everything else works. */
function fixture(): Fixture {
  let killed = false
  const f = outcomeRuntimeFixture((spec, workspace) => {
    const id = /STEP:(\w+)/.exec(spec)![1]!
    if (id === 'a1' && !killed) {
      killed = true
      return { body: 'The agent process exited.', outcome: 'failed' as const }
    }
    if (id === 'ship') {
      writeFileSync(join(workspace, 'shipped.txt'), 'shipped')
    }
    return { body: `REPORT_FROM_${id}` }
  })
  fixtures.push(f)
  return f
}

const steps = (): SessionChainAgentStep[] =>
  [
    {
      id: 'a1',
      outcomeId: 'ship',
      agent: 'codex',
      prompt: 'STEP:a1',
      status: 'queued',
      group: 'build'
    },
    {
      id: 'a2',
      outcomeId: 'ship',
      agent: 'codex',
      prompt: 'STEP:a2',
      status: 'queued',
      group: 'build'
    },
    { id: 'ship', outcomeId: 'ship', agent: 'codex', prompt: 'STEP:ship', status: 'queued' }
  ] as SessionChainAgentStep[]

async function commit(f: Fixture): Promise<void> {
  const authored = steps()
  await f.service.commit(
    {
      id: 'chain',
      workspacePath: f.workspace,
      worktreeId: 'folder:outcome',
      hostId: 'local',
      sourcePaneKey: 'source',
      sourceRowKey: 'row',
      auto: true,
      steps: authored,
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
          title: 'Ship it',
          finish: 'complete',
          dependsOn: [],
          stepIds: authored.map((step) => step.id),
          actions: [],
          conditions: [{ id: 'file', kind: 'file', target: join(f.workspace, 'shipped.txt') }]
        }
      ]
    }
  )
  f.service.dispose()
}

const attemptsFor = (f: Fixture, stepId: string) =>
  f.service
    .get('chain')
    .outcomeSet!.attempts.filter(
      (attempt) => attempt.actionId === sessionOutcomeStepActionId(stepId)
    )

const launchedIds = (f: Fixture): string[] => f.launched.map((spec) => /STEP:(\w+)/.exec(spec)![1]!)

// Acceptance G, and the isolation the dead seat must not break.
it('blocks on the dead seat with a reason, keeps its siblings, and retries exactly it', async () => {
  const f = fixture()
  await commit(f)

  for (let index = 0; index < 4; index++) {
    await f.settle()
  }

  const dead = attemptsFor(f, 'a1').at(-1)!
  expect(dead.state).toBe('blocked')
  expect(dead.error).toBeTruthy()
  expect(dead.launchDisposition).toBe('started')
  expect(sessionOutcomeRecovery(dead)).toEqual(SESSION_OUTCOME_RECOVERY['worker-dead'])
  expect(SESSION_OUTCOME_RECOVERY['worker-dead'].label).toBe('Retry — worker confirmed dead')

  // The sibling finished its own work, and the barrier still holds the seat after the group.
  expect(attemptsFor(f, 'a2').at(-1)!.state).toBe('completed')
  expect(launchedIds(f)).toEqual(['a1', 'a2'])
  const blocked = f.service.get('chain')
  expect(blocked.outcomeSet!.outcomes[0]!.status).toBe('blocked')
  // A dead worker is the host's to recover within bounds — a diagnostic reason, a `recovering`
  // block, and never a request for the person. (The Resume below is them not waiting for it.)
  expect(dead.failure).toMatchObject({ code: 'agent-turn-failed' })
  expect(dead.updatedAt).toBe(dead.failure!.at)
  expect(blocked.outcomeSet!.outcomes[0]!.block).toMatchObject({
    class: 'recovering',
    code: 'agent-turn-failed',
    until: dead.failure!.at + 15_000
  })
  expect(blocked.outcomeSet!.attention ?? []).toEqual([])
  expect(sessionOutcomeProgress(blocked.outcomeSet!)).toMatchObject({
    phase: 'recovering',
    lifecycle: 'waiting',
    attention: []
  })
  expect((blocked.steps.find((step) => step.id === 'a1') as SessionChainAgentStep).status).toBe(
    'failed'
  )

  await f.service.resume('chain', blocked.outcomeSet!.revision)
  expect(attemptsFor(f, 'a1').at(-1)!.state).toBe('retryable')

  await f.service.tick()
  // Exactly one replacement, for the dead seat only.
  expect(attemptsFor(f, 'a1')).toHaveLength(2)
  expect(attemptsFor(f, 'a2')).toHaveLength(1)
  expect(launchedIds(f)).toEqual(['a1', 'a2', 'a1'])

  for (let index = 0; index < 8; index++) {
    await f.settle()
  }
  expect(launchedIds(f)).toEqual(['a1', 'a2', 'a1', 'ship'])
  expect(sessionOutcomeProgress(f.service.get('chain').outcomeSet!).lifecycle).toBe('complete')
})

it('never auto-retries a launch it cannot prove stopped', async () => {
  const f = fixture()
  await commit(f)
  await f.settle()
  const running = f.service.get('chain')
  const attempt = running.outcomeSet!.attempts[0]!
  // Lost contact, not a receipt: the host may not start a second worker for this seat.
  f.persistence.replaceSessionChainOutcomesAndFlush(
    {
      ...running,
      outcomeSet: {
        ...running.outcomeSet!,
        attempts: running.outcomeSet!.attempts.map((entry) =>
          entry.id === attempt.id
            ? {
                ...entry,
                state: 'unverifiable' as const,
                launchDisposition: 'unverifiable' as const,
                error: 'Execution is unverifiable; the action will not be repeated.'
              }
            : entry
        )
      }
    },
    running.outcomeSet!.revision
  )

  const before = f.service.get('chain').outcomeSet!
  await f.service.resume('chain', before.revision)

  const after = f.service
    .get('chain')
    .outcomeSet!.attempts.find((entry) => entry.id === attempt.id)!
  expect(after.state).toBe('unverifiable')
  // Not even the person's Resume starts a second worker beside one nobody can prove stopped.
  expect(attemptsFor(f, 'a1')).toHaveLength(1)
  expect(sessionOutcomeRecovery(after)).toEqual(SESSION_OUTCOME_RECOVERY.unverifiable)
  expect(SESSION_OUTCOME_RECOVERY.unverifiable.label).toBe('Reconcile — cannot prove it stopped')
})
