import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SESSION_VERDICT_MARKER } from '../../shared/session-chain-verdict'
import { verdictInvariantProblems } from '../../shared/session-chain-verdict-receipts'
import type {
  SessionChain,
  SessionChainAgentStep,
  SessionChainVerdictReceipt
} from '../../shared/session-chain-types'
import type { SessionOutcomeCondition } from '../../shared/session-outcome-types'
import { SESSION_RECOVERY_MAX_AUTO_RETRIES } from '../../shared/session-attempt-recovery'
import { sessionOutcomeProgress } from '../../shared/session-outcome-state'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'

/**
 * The verdict loop, end to end through the real host: a judge, critique or verify seat finishes,
 * the completed-attempt arm spends its envelope, and what the plan says happens next happens.
 *
 * The fake worker here does what a real seat does with its brief: it reads back the seat id, the
 * `Launch attempt:` line and the pinned candidate version the host put in front of it, and ends its
 * report with exactly one envelope naming all three. That is the whole point of the wiring — a seat
 * that was never told those three could not name them, and the host would refuse its verdict.
 */
type Fixture = ReturnType<typeof outcomeRuntimeFixture>
const fixtures: Fixture[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0).toReversed()) {
    await fixture.dispose()
  }
})

const step = (
  id: string,
  extra: Partial<SessionChainAgentStep> & Record<string, unknown> = {}
): SessionChainAgentStep =>
  ({
    id,
    outcomeId: 'ship',
    agent: 'codex',
    prompt: `STEP:${id}`,
    status: 'queued',
    ...extra
  }) as SessionChainAgentStep

const LINE_STATUS: Record<string, string> = { pass: 'pass', insufficient_evidence: 'unknown' }

/** A verify gate answers its one Done When line itself; every other kind sends what it is given. */
function envelope(spec: string, payload: Record<string, unknown>): string {
  const attemptId = /Launch attempt: (\S+?)\./.exec(spec)![1]!
  const candidateVersion = /candidate version: ([0-9a-f]+)\./.exec(spec)![1]!
  const checks =
    payload.kind === 'verify' && !('checks' in payload)
      ? [
          {
            id: 'done_report',
            status: LINE_STATUS[String(payload.status)] ?? 'fail',
            evidence: 'opened export.csv'
          }
        ]
      : undefined
  return `I read what I was given.\n${SESSION_VERDICT_MARKER} ${JSON.stringify({
    ...payload,
    ...(checks ? { checks } : {}),
    attemptId,
    candidateVersion
  })}`
}

/** A seat that never launched has no spec to answer; a missing id is the test's own bug. */
const seatOf = (spec: string): string => /STEP:(\w+)/.exec(spec)![1]!

function commit(
  f: Fixture,
  steps: SessionChainAgentStep[],
  conditions: SessionOutcomeCondition[]
): Promise<unknown> {
  return f.service.commit(
    {
      id: 'chain',
      workspacePath: f.workspace,
      worktreeId: 'folder:outcome',
      hostId: 'local',
      sourcePaneKey: 'source',
      sourceRowKey: 'row',
      auto: true,
      steps,
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
          title: 'The export balances',
          finish: 'complete',
          dependsOn: [],
          stepIds: steps.map((entry) => entry.id),
          actions: [],
          conditions
        }
      ]
    }
  )
}

async function runToEnd(f: Fixture): Promise<void> {
  for (let index = 0; index < 24; index++) {
    await f.settle()
  }
}

const chainOf = (f: Fixture): SessionChain => f.service.get('chain')
const stepOf = (f: Fixture, id: string): SessionChainAgentStep =>
  chainOf(f).steps.find((entry) => entry.id === id) as SessionChainAgentStep
const receipts = (f: Fixture, id: string): SessionChainVerdictReceipt[] =>
  (chainOf(f).verdicts ?? []).filter((entry) => entry.stepId === id && !entry.skipped)
const launchedIds = (f: Fixture): string[] => f.launched.map(seatOf)
const briefFor = (f: Fixture, id: string): string =>
  f.launched.find((spec) => spec.includes(`STEP:${id}`))!
const outcomeOf = (f: Fixture) => chainOf(f).outcomeSet!.outcomes[0]!
const completed = (f: Fixture): string[] => chainOf(f).outcomeSet!.completedSteps ?? []

const SCORES: Record<string, number> = { a1: 10, a2: 90, a3: 50, d1: 20, d2: 80 }

/** Council: N answers → N critiques that read the others → one judge over the answers. */
function council(): Fixture {
  const f = outcomeRuntimeFixture((spec, workspace) => {
    const id = seatOf(spec)
    if (id === 'a1') {
      writeFileSync(join(workspace, 'answer.txt'), 'the first answer')
    }
    if (id === 'winner') {
      writeFileSync(join(workspace, 'winner.md'), 'the chosen answer')
    }
    if (id.startsWith('c')) {
      return {
        body: envelope(spec, {
          kind: 'critique',
          status: 'findings',
          stepId: id,
          blockingFindings: [`${id}: the tax column is unproven`]
        })
      }
    }
    if (id === 'judge') {
      return {
        body: envelope(spec, {
          kind: 'judge',
          status: 'pass',
          stepId: id,
          winnerId: 'a2',
          scores: ['a1', 'a2', 'a3'].map((candidate) => ({
            candidateId: candidate,
            score: SCORES[candidate]!,
            rationale: `${candidate} judged`
          })),
          blockingFindings: []
        })
      }
    }
    return { body: `REPORT_FROM_${id}` }
  })
  fixtures.push(f)
  return f
}

const councilSteps = (): SessionChainAgentStep[] => [
  ...['a1', 'a2', 'a3'].map((id, at) =>
    step(id, { group: 'answers', seat: { index: at + 1, total: 3 }, planNodeId: 'answer' })
  ),
  ...['c1', 'c2', 'c3'].map((id, at) =>
    step(id, {
      group: 'critiques',
      seat: { index: at + 1, total: 3 },
      planNodeId: 'critique',
      readsFrom: ['a1', 'a2', 'a3'],
      verdict: { kind: 'critique', over: ['a1', 'a2', 'a3'], consumed: 'record' }
    })
  ),
  step('judge', {
    agent: 'claude',
    planNodeId: 'judge',
    readsFrom: ['a1', 'a2', 'a3', 'c1', 'c2', 'c3'],
    verdict: { kind: 'judge', over: ['a1', 'a2', 'a3'], consumed: 'select-winner' }
  }),
  step('winner', { planNodeId: 'winner', readsWinnerOf: 'judge' })
]

describe('acceptance C: a council of three', () => {
  it('records one critique receipt per critic and one judge receipt, and completes no verdict seat without one', async () => {
    const f = council()
    await commit(f, councilSteps(), [
      { id: 'answer_file', kind: 'file', target: join(f.workspace, 'answer.txt') },
      { id: 'winner_file', kind: 'file', target: join(f.workspace, 'winner.md') }
    ])
    await runToEnd(f)

    for (const critic of ['c1', 'c2', 'c3']) {
      expect(receipts(f, critic)).toHaveLength(1)
      expect(receipts(f, critic)[0]!.verdict).toMatchObject({
        kind: 'critique',
        status: 'findings'
      })
      expect(completed(f)).toContain(critic)
    }
    expect(receipts(f, 'judge')).toHaveLength(1)
    expect(receipts(f, 'judge')[0]!.verdict).toMatchObject({
      winnerId: 'a2',
      ranking: ['a2', 'a3', 'a1']
    })
    // The invariant the tick asserts, asserted over the finished chain: every verdict seat that
    // reached `completedSteps` decided something.
    expect(verdictInvariantProblems(chainOf(f))).toEqual([])
    expect(outcomeOf(f).status).not.toBe('blocked')
    expect(sessionOutcomeProgress(chainOf(f).outcomeSet!).lifecycle).toBe('complete')
  })

  it('gives each critic the other answers and the winner reader only the answer that won', async () => {
    const f = council()
    await commit(f, councilSteps(), [
      { id: 'answer_file', kind: 'file', target: join(f.workspace, 'answer.txt') },
      { id: 'winner_file', kind: 'file', target: join(f.workspace, 'winner.md') }
    ])
    await runToEnd(f)

    expect(briefFor(f, 'c2')).toContain('=== a1 ===')
    expect(briefFor(f, 'c2')).toContain('REPORT_FROM_a3')
    expect(stepOf(f, 'winner').readsFrom).toEqual(['a2'])
    const brief = briefFor(f, 'winner')
    expect(brief).toContain('=== a2 ===')
    expect(brief).toContain('REPORT_FROM_a2')
    expect(brief).not.toContain('=== a1 ===')
  })
})

/** Best-of-N: two drafts, a judge from another family, a polish seat per draft, one reader. */
function bestOfN(): Fixture {
  const f = outcomeRuntimeFixture((spec, workspace) => {
    const id = seatOf(spec)
    if (id === 'd1') {
      writeFileSync(join(workspace, 'draft.txt'), 'the first draft')
    }
    if (id === 'judge') {
      return {
        body: envelope(spec, {
          kind: 'judge',
          status: 'pass',
          stepId: id,
          winnerId: 'd2',
          scores: ['d1', 'd2'].map((candidate) => ({
            candidateId: candidate,
            score: SCORES[candidate]!
          })),
          blockingFindings: []
        })
      }
    }
    return { body: `REPORT_FROM_${id}` }
  })
  fixtures.push(f)
  return f
}

const bestOfNSteps = (): SessionChainAgentStep[] => [
  ...['d1', 'd2'].map((id, at) =>
    step(id, { group: 'draft', seat: { index: at + 1, total: 2 }, planNodeId: 'draft' })
  ),
  step('judge', {
    agent: 'claude',
    planNodeId: 'judge',
    readsFrom: ['d1', 'd2'],
    verdict: { kind: 'judge', over: ['d1', 'd2'], consumed: 'select-winner' }
  }),
  ...['p1', 'p2'].map((id, at) =>
    step(id, {
      planNodeId: 'polish',
      seat: { index: at + 1, total: 2 },
      enabledBy: { verdict: 'judge', seatsOf: 'draft' }
    })
  ),
  step('summary', { planNodeId: 'summary', readsWinnerOf: 'judge' })
]

describe('acceptance D: best of N', () => {
  it('ranks the candidates, skips the loser seats and hands the survivor the winning report', async () => {
    const f = bestOfN()
    await commit(f, bestOfNSteps(), [
      { id: 'draft_file', kind: 'file', target: join(f.workspace, 'draft.txt') }
    ])
    await runToEnd(f)

    expect(receipts(f, 'judge')[0]!.verdict).toMatchObject({
      ranking: ['d2', 'd1'],
      winnerId: 'd2'
    })
    // Seat 2 won, so seat 1's polish never runs — and is completed WITH a status, not left queued.
    expect(stepOf(f, 'p1').status).toBe('skipped')
    expect(completed(f)).toContain('p1')
    expect(launchedIds(f)).not.toContain('p1')
    expect(launchedIds(f)).toContain('p2')
    expect(briefFor(f, 'summary')).toContain('REPORT_FROM_d2')
    expect(briefFor(f, 'summary')).not.toContain('REPORT_FROM_d1')
    // The judge is not one of the candidates' family: the plan authored it on another agent.
    expect(stepOf(f, 'judge').agent).not.toBe(stepOf(f, 'd1').agent)
    expect(verdictInvariantProblems(chainOf(f))).toEqual([])
  })

  it('spends the judge verdict exactly once however many ticks read it', async () => {
    const f = bestOfN()
    await commit(f, bestOfNSteps(), [
      { id: 'draft_file', kind: 'file', target: join(f.workspace, 'draft.txt') }
    ])
    await runToEnd(f)
    await runToEnd(f)

    expect(chainOf(f).verdicts!.filter((entry) => entry.stepId === 'judge')).toHaveLength(1)
  })
})

/** A verify gate over one done-when entry, with a repair to route to. */
function gated(verdict: (spec: string, id: string) => string): Fixture {
  const f = outcomeRuntimeFixture((spec, workspace) => {
    const id = seatOf(spec)
    if (id === 'work') {
      writeFileSync(join(workspace, 'export.csv'), 'tax,total\n1,2\n')
    }
    return { body: id === 'verify' ? verdict(spec, id) : `REPORT_FROM_${id}` }
  })
  fixtures.push(f)
  return f
}

const gateSteps = (): SessionChainAgentStep[] => [
  step('work', { planNodeId: 'work' }),
  step('verify', {
    agent: 'claude',
    planNodeId: 'verify',
    readsFrom: ['work'],
    verdict: { kind: 'verify', over: ['done_report'], consumed: 'gate' },
    onFail: 'repair'
  }),
  step('publish', { planNodeId: 'publish' }),
  step('repair', { planNodeId: 'repair' })
]

const gateConditions = (f: Fixture): SessionOutcomeCondition[] => [
  { id: 'export_file', kind: 'file', target: join(f.workspace, 'export.csv') },
  {
    id: 'done_report',
    kind: 'report',
    target: 'verify',
    label: 'the export keeps the tax column'
  }
]

describe('a verify gate decides its done-when entries', () => {
  it('mints one report receipt per entry it passed, raises k/n and closes the repair it did not need', async () => {
    const f = gated((spec, id) =>
      envelope(spec, { kind: 'verify', status: 'pass', stepId: id, blockingFindings: [] })
    )
    await commit(f, gateSteps(), gateConditions(f))
    await runToEnd(f)

    const evidence = outcomeOf(f).evidence
    expect(evidence.map((entry) => entry.conditionId).toSorted()).toEqual([
      'done_report',
      'export_file'
    ])
    expect(evidence.find((entry) => entry.conditionId === 'done_report')!.receipt).toMatch(
      /^report:[^:]+:[a-f0-9]{64}$/
    )
    expect(stepOf(f, 'repair').status).toBe('skipped')
    expect(launchedIds(f)).toContain('publish')
    expect(outcomeOf(f).status).toBe('satisfied')
  })

  it('routes a failed gate to the repair it names and mints nothing', async () => {
    const f = gated((spec, id) =>
      envelope(spec, {
        kind: 'verify',
        status: 'fail',
        stepId: id,
        blockingFindings: ['the tax column is missing']
      })
    )
    await commit(f, gateSteps(), gateConditions(f))
    await runToEnd(f)

    expect(receipts(f, 'verify')[0]!.verdict).toMatchObject({ status: 'fail' })
    expect(outcomeOf(f).evidence.map((entry) => entry.conditionId)).not.toContain('done_report')
    // The run continues AT the repair: what stood between the gate and it is closed.
    expect(stepOf(f, 'publish').status).toBe('skipped')
    expect(launchedIds(f)).toContain('repair')
    expect(launchedIds(f)).not.toContain('publish')
  })

  it('fails the seat and blocks the outcome on a report carrying a second verdict line', async () => {
    const f = gated((spec, id) => {
      const one = envelope(spec, {
        kind: 'verify',
        status: 'pass',
        stepId: id,
        blockingFindings: []
      })
      return `${one}\n${one.split('\n').at(-1)}`
    })
    await commit(f, gateSteps(), gateConditions(f))
    await runToEnd(f)
    await runToEnd(f)

    // The seat is asked again first, within the ladder's bound, and only then is it a failure —
    // an operational one: a verdict nobody can read is never a question for a person.
    expect(launchedIds(f).filter((id) => id === 'verify')).toHaveLength(
      1 + SESSION_RECOVERY_MAX_AUTO_RETRIES
    )
    expect(stepOf(f, 'verify').status).toBe('failed')
    expect(outcomeOf(f)).toMatchObject({
      status: 'blocked',
      block: { class: 'failed', code: 'verdict-unreadable' }
    })
    expect(outcomeOf(f).blockedReason).toContain('more than one verdict line')
    expect(sessionOutcomeProgress(chainOf(f).outcomeSet!)).toMatchObject({
      phase: 'failed',
      lifecycle: 'waiting',
      attention: []
    })
    expect(chainOf(f).verdicts ?? []).toHaveLength(0)
    expect(completed(f)).not.toContain('verify')
    expect(launchedIds(f)).not.toContain('publish')
    expect(outcomeOf(f).evidence.map((entry) => entry.conditionId)).not.toContain('done_report')
  })

  it('asks a gate that returned no verdict again, and completes on the verdict the re-ask returns', async () => {
    let asked = 0
    const f = gated((spec, id) =>
      ++asked === 1
        ? 'The export looks right to me.'
        : envelope(spec, { kind: 'verify', status: 'pass', stepId: id, blockingFindings: [] })
    )
    await commit(f, gateSteps(), gateConditions(f))
    await runToEnd(f)

    expect(launchedIds(f).filter((id) => id === 'verify')).toHaveLength(2)
    expect(receipts(f, 'verify')).toHaveLength(1)
    expect(outcomeOf(f).status).toBe('satisfied')
    expect(chainOf(f).outcomeSet!.attention ?? []).toEqual([])
    expect(sessionOutcomeProgress(chainOf(f).outcomeSet!).lifecycle).toBe('complete')
  })

  it('asks the owner to decide when a gate fails and the plan names no repair for it', async () => {
    const f = gated((spec, id) =>
      envelope(spec, {
        kind: 'verify',
        status: 'fail',
        stepId: id,
        blockingFindings: ['the tax column is missing']
      })
    )
    // The gate is the last stage and routes its failure nowhere.
    const [work, verify] = gateSteps()
    await commit(
      f,
      [work!, { ...verify!, onFail: undefined } as SessionChainAgentStep],
      gateConditions(f)
    )
    await runToEnd(f)

    expect(launchedIds(f)).toEqual(['work', 'verify'])
    expect(receipts(f, 'verify')[0]!.verdict).toMatchObject({ status: 'fail' })
    const progress = sessionOutcomeProgress(chainOf(f).outcomeSet!)
    // Needs-you IS the open owner request below, never the blocked reason beside it.
    expect(progress).toMatchObject({ phase: 'needs-you', lifecycle: 'needs-you' })
    expect(progress.attention).toMatchObject([
      {
        kind: 'decision',
        state: 'open',
        recipient: { type: 'owner' },
        action: { kind: 'open-up-next' },
        source: { type: 'verification-gate', ref: 'the tax column is missing' },
        scope: { outcomeId: 'ship', stepId: 'verify' }
      }
    ])
    expect(outcomeOf(f).block).toMatchObject({
      class: 'attention',
      code: 'verification-gate',
      attentionIds: [progress.attention[0]!.id]
    })
    // Every later pass re-derives the same requirement: one request, and nothing is relaunched.
    await runToEnd(f)
    expect(chainOf(f).outcomeSet!.attention).toHaveLength(1)
    expect(launchedIds(f)).toEqual(['work', 'verify'])
  })
})

describe('a gate that fails in the middle of a plan, with no repair to route to', () => {
  const failing = (): Fixture =>
    gated((spec, id) =>
      envelope(spec, {
        kind: 'verify',
        status: 'fail',
        stepId: id,
        blockingFindings: ['the tax column is missing']
      })
    )
  /** work → verify (routes its failure nowhere) → publish. */
  const midPlan = (): SessionChainAgentStep[] => {
    const [work, verify, publish] = gateSteps()
    return [work!, { ...verify!, onFail: undefined } as SessionChainAgentStep, publish!]
  }

  it('stops the run there with ONE decision request, and launches nothing past the gate', async () => {
    const f = failing()
    await commit(f, midPlan(), gateConditions(f))
    await runToEnd(f)

    expect(launchedIds(f)).toEqual(['work', 'verify'])
    expect(completed(f)).toEqual(['work', 'verify'])
    const stopped = chainOf(f).outcomeSet!
    expect(stopped.attention).toHaveLength(1)
    const request = stopped.attention![0]!
    expect(request).toMatchObject({
      kind: 'decision',
      state: 'open',
      recipient: { type: 'owner' },
      action: { kind: 'open-up-next' },
      source: { type: 'verification-gate', ref: 'the tax column is missing' },
      scope: { outcomeId: 'ship', stepId: 'verify' }
    })
    expect(outcomeOf(f)).toMatchObject({
      status: 'blocked',
      block: { class: 'attention', code: 'verification-gate', attentionIds: [request.id] }
    })
    expect(sessionOutcomeProgress(stopped)).toMatchObject({
      phase: 'needs-you',
      lifecycle: 'needs-you'
    })
    // The seat behind the gate is held for the decision, which is what a restart reads back.
    expect(stepOf(f, 'publish').wait).toMatchObject({ reason: 'human_decision', ref: 'verify' })
    const since = outcomeOf(f).block!.since

    // Durable: every later pass re-derives the same stop. The request is the same object — never
    // resolved and opened again, so never announced a second time — and nothing new starts.
    await runToEnd(f)
    expect(chainOf(f).outcomeSet!.attention).toEqual([request])
    expect(outcomeOf(f).block).toMatchObject({ code: 'verification-gate', since })
    expect(launchedIds(f)).toEqual(['work', 'verify'])
  })

  /** Stop the run at the gate, then commit the owner's answer: the plan and title they chose. */
  async function answered(
    answer: (live: SessionChain) => { steps: SessionChain['steps']; title: string }
  ): Promise<{ f: Fixture; asked: string }> {
    const f = failing()
    await commit(f, midPlan(), gateConditions(f))
    await runToEnd(f)
    expect(launchedIds(f)).toEqual(['work', 'verify'])

    const live = chainOf(f)
    const asked = live.outcomeSet!.attention![0]!.id
    const { steps, title } = answer(live)
    await f.service.commit(
      { ...live, steps },
      {
        expectedRevision: live.outcomeSet!.revision,
        source: 'user',
        outcomes: [
          {
            id: 'ship',
            title,
            finish: 'complete',
            dependsOn: [],
            stepIds: steps.map((entry) => entry.id),
            actions: [],
            conditions: gateConditions(f)
          }
        ]
      }
    )
    await runToEnd(f)
    return { f, asked }
  }

  /**
   * The failure was asked about once, when it stopped the run. The gate never passed, so its entry
   * is still unproven at the finish — an honest failure, never the same question a second time.
   */
  function expectAskedOnce(f: Fixture, asked: string, settled: 'resolved' | 'withdrawn'): void {
    const set = chainOf(f).outcomeSet!
    expect(set.attention).toMatchObject([{ id: asked, state: settled }])
    expect(outcomeOf(f)).toMatchObject({
      status: 'blocked',
      block: { class: 'failed', code: 'verification-gate' }
    })
    expect(sessionOutcomeProgress(set)).toMatchObject({ phase: 'failed', attention: [] })
  }

  it('continues once the owner adds a stage: their plan is the answer', async () => {
    const { f, asked } = await answered((live) => ({
      steps: [...live.steps, step('fix', { planNodeId: 'fix' })],
      title: 'The export balances'
    }))

    expect(launchedIds(f)).toEqual(['work', 'verify', 'publish', 'fix'])
    expect(completed(f)).toEqual(['work', 'verify', 'publish', 'fix'])
    // The marks of the decided stop are gone; the gate keeps its own, so it is not asked again
    // as a mid-plan stop.
    expect(stepOf(f, 'publish').wait).toBeUndefined()
    expect(stepOf(f, 'verify').wait).toMatchObject({ reason: 'human_decision', ref: 'verify' })
    expectAskedOnce(f, asked, 'resolved')
  })

  it('continues once the owner redefines the outcome, as Done does, and asks nothing more', async () => {
    const { f, asked } = await answered((live) => ({
      steps: live.steps,
      title: 'The export balances, as it stands'
    }))

    expect(launchedIds(f)).toEqual(['work', 'verify', 'publish'])
    expect(completed(f)).toEqual(['work', 'verify', 'publish'])
    expect(outcomeOf(f).revision).toBe(2)
    // The question was about the outcome as it was: it is withdrawn, not answered again.
    expectAskedOnce(f, asked, 'withdrawn')
  })
})

describe('the runtime invariant on the tick', () => {
  it('blocks an outcome whose verdict seat is complete with no receipt', async () => {
    const f = gated((spec, id) =>
      envelope(spec, { kind: 'verify', status: 'pass', stepId: id, blockingFindings: [] })
    )
    await commit(f, gateSteps(), gateConditions(f))
    const held = chainOf(f)
    // A chain reloaded with a verdict seat inside `completedSteps` and nothing in `chain.verdicts`:
    // the shape a crash between "marked complete" and "receipt persisted" would leave behind.
    f.persistence.replaceSessionChainOutcomesAndFlush(
      {
        ...held,
        outcomeSet: { ...held.outcomeSet!, completedSteps: ['work', 'verify'] }
      } as SessionChain,
      held.outcomeSet!.revision
    )

    await f.service.tick()

    expect(outcomeOf(f)).toMatchObject({
      status: 'blocked',
      blockedReason: 'Verdict without receipt: verify completed without deciding anything.',
      // The receipt may still land, so the host keeps looking; it never asks a person for one.
      block: { class: 'recovering', code: 'verdict-receipt-missing' }
    })
    expect(sessionOutcomeProgress(chainOf(f).outcomeSet!)).toMatchObject({
      phase: 'recovering',
      attention: []
    })
    expect(launchedIds(f)).not.toContain('publish')
  })
})
