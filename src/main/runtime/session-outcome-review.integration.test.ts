import { bindNativeOutcomeSource } from './session-outcome-native-test-fixture'
import { sessionChainStepOutputDir } from '../../shared/session-chain-types'
import { runProcess } from '../../shared/child-process/run-process'
import { verifySessionOutcomeCondition } from './session-outcome-evidence'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'
import type { SessionChainAgentStep } from '../../shared/session-chain-types'
import { sessionOutcomeProgress } from '../../shared/session-outcome-state'
import { SESSION_RECOVERY_MAX_AUTO_RETRIES } from '../../shared/session-attempt-recovery'

const fixtures: ReturnType<typeof outcomeRuntimeFixture>[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.dispose()
  }
})
const verdict = (pass: boolean) =>
  `OMNI_REVIEW_RESULT:${JSON.stringify({ status: pass ? 'pass' : 'findings', blockingFindings: pass ? [] : ['Fix the candidate'], notes: 'Reviewed exact candidate' })}`
const review = (id: string, round: number): SessionChainAgentStep => ({
  id,
  outcomeId: 'outcome',
  agent: 'codex',
  prompt: `STEP:${id}`,
  status: 'queued',
  group: `review_round_${round}`,
  review: { groupId: 'review', reviewerId: id, round, maxRounds: 2, candidateVersion: 'unbound' }
})
const steps = (): SessionChainAgentStep[] => [
  review('r1a', 1),
  review('r1b', 1),
  {
    id: 'repair',
    outcomeId: 'outcome',
    agent: 'codex',
    prompt: 'STEP:repair',
    status: 'queued',
    reviewRepair: {
      groupId: 'review',
      afterRound: 1,
      candidateVersion: 'unbound',
      consumptionKey: 'repair-once'
    }
  },
  review('r2a', 2),
  review('r2b', 2)
]
async function run(
  change: boolean,
  firstRoundPass = false,
  git?: { reviewerMutation?: boolean; artifactMutation?: boolean; missingManifest?: boolean },
  native = false
) {
  const deliverable = git
    ? join('.omni', 'runs', 'chain', 'writer', 'manifest.md')
    : 'deliverable.txt'
  const f = outcomeRuntimeFixture((spec, workspace) => {
    const step = /STEP:(\w+)/.exec(spec)![1]!
    if (git) {
      const reportDir = sessionChainStepOutputDir(workspace, 'review-run', step)
      mkdirSync(reportDir, { recursive: true })
      writeFileSync(join(reportDir, 'report.md'), `Report from ${step}`)
    }
    if (step === 'repair') {
      if (change) {
        writeFileSync(join(workspace, git ? 'source.ts' : 'deliverable.txt'), 'revised')
      }
      return { body: 'Repaired' }
    }
    if (git?.artifactMutation && step === 'r1a') {
      writeFileSync(join(workspace, deliverable), 'unauthorized artifact edit')
    }
    if (git?.reviewerMutation && step === 'r1a') {
      writeFileSync(join(workspace, 'source.ts'), 'unauthorized reviewer edit')
    }
    return { body: verdict(firstRoundPass || step.startsWith('r2') || step === 'r1b') }
  })
  fixtures.push(f)
  mkdirSync(dirname(join(f.workspace, deliverable)), { recursive: true })
  if (!git?.missingManifest) {
    f.write(deliverable, 'original')
  }
  if (git) {
    f.write('source.ts', 'original source')
    for (const args of [['init'], ['add', 'source.ts']]) {
      const result = await runProcess({ program: 'git', args: ['-C', f.workspace, ...args] })
      expect(result.code, result.stderr).toBe(0)
    }
    // This fixture stores profile/SQLite state inside the workspace; production stores it outside.
    f.write(
      '.git/info/exclude',
      '.omni/state.json\n.omni/orchestration.sqlite\n.omni/orchestration.sqlite-shm\n.omni/orchestration.sqlite-wal\n'
    )
    expect(
      (await runProcess({ program: 'git', args: ['-C', f.workspace, 'check-ignore', deliverable] }))
        .code
    ).toBe(1)
  }
  const source = native ? await bindNativeOutcomeSource(f) : undefined
  const configured = steps().map((step) =>
    native
      ? { ...step, model: step.id.endsWith('b') ? 'gpt-6-astra' : 'gpt-5.6-sol', effort: 'high' }
      : step
  )
  await f.service.commit(
    {
      id: 'chain',
      workspacePath: f.workspace,
      worktreeId: 'folder:outcome',
      hostId: 'local',
      sourcePaneKey: 'source',
      sourceRowKey: 'row',
      auto: true,
      steps: configured,
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
          id: 'outcome',
          title: 'Reviewed deliverable',
          finish: 'complete',
          dependsOn: [],
          stepIds: configured.map((step) => step.id),
          actions: [],
          conditions: [{ id: 'file', kind: 'file', target: join(f.workspace, deliverable) }]
        }
      ]
    }
  )
  f.service.dispose()
  await source?.settleSource()
  for (let index = 0; index < 20; index++) {
    await f.service.tick()
    await f.settle()
  }
  return f
}

describe('actual host review rounds and durable repair ownership', () => {
  it('runs all reviewers on one content version, repairs once, then reviews only revised bytes', async () => {
    const f = await run(true)
    const chain = f.service.get('chain'),
      group = chain.reviewLoop!.groups[0]!
    expect(f.launched.map((spec) => /STEP:(\w+)/.exec(spec)![1])).toEqual([
      'r1a',
      'r1b',
      'repair',
      'r2a',
      'r2b'
    ])
    expect(group.status).toBe('passed')
    expect(group.rounds).toHaveLength(2)
    expect(group.rounds[0]!.receipts.map((receipt) => receipt.candidateVersion)).toEqual([
      group.rounds[0]!.candidateVersion,
      group.rounds[0]!.candidateVersion
    ])
    expect(group.rounds[1]!.candidateVersion).not.toBe(group.rounds[0]!.candidateVersion)
    expect(group.consumedRepairKeys).toEqual(['repair-once'])
    expect(sessionOutcomeProgress(chain.outcomeSet!).lifecycle).toBe('complete')
    await f.service.tick()
    expect(f.launched).toHaveLength(5)
  })
  it('stops early after all reviewers pass, without launching the selected repair twice', async () => {
    const f = await run(false, true)
    expect(f.launched).toHaveLength(2)
    expect(sessionOutcomeProgress(f.service.get('chain').outcomeSet!).lifecycle).toBe('complete')
  })
  it('refuses a second review round when the repair leaves the result unchanged', async () => {
    const f = await run(false)
    expect(f.launched).toHaveLength(3)
    const progress = sessionOutcomeProgress(f.service.get('chain').outcomeSet!)
    // A repairer that changed nothing is an honest failure of the run; nobody is asked anything.
    expect(progress).toMatchObject({ phase: 'failed', lifecycle: 'waiting', attention: [] })
    expect(f.service.get('chain').outcomeSet!.outcomes[0]!.block).toMatchObject({
      class: 'failed',
      code: 'review-repair-unchanged'
    })
    expect(progress.reasons.join(' ')).toContain('did not revise')
  })
})

describe('a reviewer that returns no verdict', () => {
  const oneRound = (): SessionChainAgentStep[] =>
    [review('r1a', 1), review('r1b', 1)].map((step) => ({
      ...step,
      review: { ...step.review!, maxRounds: 1 }
    }))

  /** `answer` scripts each reviewer per launch; the repairer always revises the deliverable. */
  async function reviewed(
    answer: (step: string, launch: number) => string,
    seats: SessionChainAgentStep[] = oneRound()
  ) {
    const launches = new Map<string, number>()
    const f = outcomeRuntimeFixture((spec, workspace) => {
      const step = /STEP:(\w+)/.exec(spec)![1]!
      launches.set(step, (launches.get(step) ?? 0) + 1)
      if (step === 'repair') {
        writeFileSync(join(workspace, 'deliverable.txt'), 'revised')
        return { body: 'Repaired' }
      }
      return { body: answer(step, launches.get(step)!) }
    })
    fixtures.push(f)
    f.write('deliverable.txt', 'original')
    await f.service.commit(
      {
        id: 'chain',
        workspacePath: f.workspace,
        worktreeId: 'folder:outcome',
        hostId: 'local',
        sourcePaneKey: 'source',
        sourceRowKey: 'row',
        auto: true,
        steps: seats,
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
            id: 'outcome',
            title: 'Reviewed deliverable',
            finish: 'complete',
            dependsOn: [],
            stepIds: seats.map((step) => step.id),
            actions: [],
            conditions: [{ id: 'file', kind: 'file', target: join(f.workspace, 'deliverable.txt') }]
          }
        ]
      }
    )
    f.service.dispose()
    for (let index = 0; index < 28; index++) {
      await f.service.tick()
      await f.settle()
    }
    return f
  }
  const launchesOf = (f: Awaited<ReturnType<typeof reviewed>>, id: string): number =>
    f.launched.filter((spec) => spec.includes(`STEP:${id}`)).length

  it('is asked again, and the valid verdict on the re-ask completes the run with no request', async () => {
    const f = await reviewed((step, launch) =>
      step === 'r1b' && launch === 1 ? 'Looks good to me.' : verdict(true)
    )
    const chain = f.service.get('chain')
    expect(launchesOf(f, 'r1a')).toBe(1)
    expect(launchesOf(f, 'r1b')).toBe(2)
    expect(chain.reviewLoop!.groups[0]!.status).toBe('passed')
    expect(chain.outcomeSet!.attention ?? []).toEqual([])
    expect(sessionOutcomeProgress(chain.outcomeSet!)).toMatchObject({
      phase: 'completed',
      lifecycle: 'complete',
      attention: []
    })
  })

  it('fails as reviewer-no-verdict once the bound is spent: never needs-you, and no more relaunches', async () => {
    const f = await reviewed((step) => (step === 'r1b' ? 'Looks good to me.' : verdict(true)))
    const chain = f.service.get('chain')
    expect(launchesOf(f, 'r1a')).toBe(1)
    expect(launchesOf(f, 'r1b')).toBe(1 + SESSION_RECOVERY_MAX_AUTO_RETRIES)
    expect(chain.reviewLoop!.groups[0]!.status).toBe('blocked')
    expect(chain.outcomeSet!.outcomes[0]).toMatchObject({
      status: 'blocked',
      blockedReason: 'A selected reviewer did not return a valid verdict.',
      block: { class: 'failed', code: 'reviewer-no-verdict' }
    })
    expect(chain.outcomeSet!.attention ?? []).toEqual([])
    expect(sessionOutcomeProgress(chain.outcomeSet!)).toMatchObject({
      phase: 'failed',
      lifecycle: 'waiting',
      attention: []
    })
    for (let index = 0; index < 4; index++) {
      await f.service.tick()
      await f.settle()
    }
    expect(launchesOf(f, 'r1b')).toBe(1 + SESSION_RECOVERY_MAX_AUTO_RETRIES)
  })

  it("is asked once more by a person's Resume, and the verdict it then returns completes the run", async () => {
    const silentLaunches = 1 + SESSION_RECOVERY_MAX_AUTO_RETRIES
    const f = await reviewed((step, launch) =>
      step === 'r1b' && launch <= silentLaunches ? 'Looks good to me.' : verdict(true)
    )
    expect(f.service.get('chain').outcomeSet!.outcomes[0]!.block).toMatchObject({
      class: 'failed',
      code: 'reviewer-no-verdict'
    })
    expect(launchesOf(f, 'r1b')).toBe(silentLaunches)

    await f.service.resume('chain', f.service.get('chain').outcomeSet!.revision)
    // Resume gave back only the silent seat, and its round reads as reviewing again.
    const resumed = f.service.get('chain')
    expect(resumed.reviewLoop!.groups[0]!.status).toBe('reviewing')
    expect(resumed.outcomeSet!.outcomes[0]!.status).not.toBe('blocked')
    for (let index = 0; index < 8; index++) {
      await f.service.tick()
      await f.settle()
    }

    const chain = f.service.get('chain')
    expect(launchesOf(f, 'r1a')).toBe(1)
    expect(launchesOf(f, 'r1b')).toBe(silentLaunches + 1)
    expect(chain.reviewLoop!.groups[0]!.status).toBe('passed')
    expect(chain.outcomeSet!.attention ?? []).toEqual([])
    expect(sessionOutcomeProgress(chain.outcomeSet!)).toMatchObject({
      phase: 'completed',
      lifecycle: 'complete',
      attention: []
    })
  })

  it('asks the owner to decide when findings outlive the authorized rounds: a rejection, not a missing verdict', async () => {
    const f = await reviewed((step) => verdict(step.endsWith('b')), steps())
    const chain = f.service.get('chain')
    // The valid rejection took the authorized repair once and relaunched no reviewer.
    expect(f.launched.map((spec) => /STEP:(\w+)/.exec(spec)![1])).toEqual([
      'r1a',
      'r1b',
      'repair',
      'r2a',
      'r2b'
    ])
    expect(chain.reviewLoop!.groups[0]).toMatchObject({ status: 'blocked', currentRound: 2 })
    const progress = sessionOutcomeProgress(chain.outcomeSet!)
    // Needs-you IS the open owner request below, never the blocked reason beside it.
    expect(progress).toMatchObject({ phase: 'needs-you', lifecycle: 'needs-you' })
    expect(progress.attention).toMatchObject([
      {
        kind: 'decision',
        state: 'open',
        recipient: { type: 'owner' },
        action: { kind: 'open-up-next' },
        source: { type: 'review-findings' }
      }
    ])
    expect(chain.outcomeSet!.outcomes[0]!.block).toMatchObject({
      class: 'attention',
      code: 'review-findings',
      attentionIds: [progress.attention[0]!.id]
    })
    // Re-observed on every later pass: the same request, asked once.
    for (let index = 0; index < 4; index++) {
      await f.service.tick()
      await f.settle()
    }
    expect(f.service.get('chain').outcomeSet!.attention).toHaveLength(1)
    expect(f.launched).toHaveLength(5)
  })
})

it('verifies a persisted review report against its actual execution and current candidate', async () => {
  const f = await run(true)
  const chain = f.service.get('chain')
  await expect(
    verifySessionOutcomeCondition(
      { id: 'report', kind: 'report', target: 'r2a' },
      f.workspace,
      f.runtime,
      chain
    )
  ).resolves.toMatchObject({ verified: true })
  await expect(
    verifySessionOutcomeCondition(
      { id: 'report', kind: 'report', target: 'r1a' },
      f.workspace,
      f.runtime,
      chain
    )
  ).resolves.toMatchObject({ verified: false })
  f.write('deliverable.txt', 'later revision')
  await expect(
    verifySessionOutcomeCondition(
      { id: 'report', kind: 'report', target: 'r2a' },
      f.workspace,
      f.runtime,
      chain
    )
  ).resolves.toMatchObject({ verified: false })
})

it('detects a reviewer source mutation in Git even before the final manifest exists', async () => {
  const f = await run(false, true, { reviewerMutation: true, missingManifest: true })
  expect(f.launched).toHaveLength(2)
  expect(sessionOutcomeProgress(f.service.get('chain').outcomeSet!).reasons.join(' ')).toContain(
    'candidate changed during review'
  )
})

it('accepts a code-only Git repair with an unchanged final manifest and pins both reviewers to each revision', async () => {
  const f = await run(true, false, {})
  const group = f.service.get('chain').reviewLoop!.groups[0]
  expect(f.launched).toHaveLength(5)
  expect(group.status).toBe('passed')
  expect(group.rounds).toHaveLength(2)
  expect(group.rounds[1].candidateVersion).not.toBe(group.rounds[0].candidateVersion)
  for (const round of group.rounds) {
    expect(round.receipts.map((receipt) => receipt.candidateVersion)).toEqual([
      round.candidateVersion,
      round.candidateVersion
    ])
  }
  expect(group.consumedRepairKeys).toEqual(['repair-once'])
  expect(sessionOutcomeProgress(f.service.get('chain').outcomeSet!).lifecycle).toBe('complete')
})

it('refuses an unchanged Git repair without rerunning reviewers', async () => {
  const f = await run(false, false, {})
  expect(f.launched).toHaveLength(3)
  expect(sessionOutcomeProgress(f.service.get('chain').outcomeSet!).reasons.join(' ')).toContain(
    'did not revise'
  )
})

it('keeps Git reviewers on one candidate while their undeclared reports are written without a runs ignore', async () => {
  const f = await run(false, true, {})
  const chain = f.service.get('chain')
  expect(f.launched).toHaveLength(2)
  expect(chain.reviewLoop!.groups[0].status).toBe('passed')
  expect(sessionOutcomeProgress(chain.outcomeSet!).lifecycle).toBe('complete')
  const report = join(sessionChainStepOutputDir(f.workspace, 'review-run', 'r1a'), 'report.md')
  expect(
    (await runProcess({ program: 'git', args: ['-C', f.workspace, 'check-ignore', report] })).code
  ).toBe(1)
})

it('still blocks a reviewer mutation of the declared writer manifest inside runs', async () => {
  const f = await run(false, true, { artifactMutation: true })
  expect(f.launched).toHaveLength(2)
  expect(sessionOutcomeProgress(f.service.get('chain').outcomeSet!).reasons.join(' ')).toContain(
    'candidate changed during review'
  )
})

it('runs both exact reviewers and one bounded repair on the original native card projection', async () => {
  const f = await run(true, false, undefined, true)
  const chain = f.service.get('chain')
  const attempts = chain.outcomeSet!.attempts
  const native = chain.outcomeSet!.continuation.nativeSource!
  expect(f.launched).toHaveLength(5)
  expect(chain.reviewLoop!.groups[0].status).toBe('passed')
  expect(chain.reviewLoop!.groups[0].consumedRepairKeys).toEqual(['repair-once'])
  expect(new Set(attempts.map((attempt) => attempt.taskId))).toEqual(
    new Set([native.projectionTaskId])
  )
  expect(f.db.listTasks({ runId: native.runId })).toHaveLength(1)
  expect(
    attempts.map(
      (attempt) =>
        JSON.parse(f.db.getWorkerDispatch(attempt.dispatchId!)!.start_options).launch.requested
          .model
    )
  ).toEqual(['gpt-5.6-sol', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-sol', 'gpt-6-astra'])
  for (const round of chain.reviewLoop!.groups[0].rounds) {
    expect(round.receipts.map((receipt) => receipt.candidateVersion)).toEqual([
      round.candidateVersion,
      round.candidateVersion
    ])
  }
  expect(sessionOutcomeProgress(chain.outcomeSet!).lifecycle).toBe('complete')
})
