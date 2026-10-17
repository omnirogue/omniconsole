/**
 * A second ＋ Agent while the first stage is RUNNING — through the real durable commit.
 *
 * The RPC tests stub `SessionOutcomeService.commit`, so the rule that refused this lives below
 * them: `reviseSessionOutcomeSet` decides whether the submitted definition is still the same
 * Outcome by comparing it with the stored copy AS JSON, and the stored copy came back through the
 * schema — which rebuilds every object in its own key order. A freshly lowered condition
 * (`{id, label, kind, target}`) and its stored twin (`{id, kind, label, target}`) are the same
 * condition spelled in a different order, so every second commit read as a CHANGED Outcome: the
 * revision bumped, human-review receipts were discarded, and with a seat in flight the commit was
 * refused outright — the live-simulation banner "That change to Up next could not be made on this
 * host." (LS-2). This runs the whole pipeline, so the comparison is really exercised.
 */

import { afterEach, expect, it, vi } from 'vitest'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'
import { upNextChainBlocks } from './up-next-blocks'
import {
  upNextCommitPlan,
  upNextPlanOf,
  upNextPlanWithStage,
  type UpNextPlanContext
} from './up-next-plan-edit'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeAttempt } from '../../shared/session-outcome-types'
import { UP_NEXT_REFUSAL_KEYS, type UpNextAgentBlock } from '../../shared/up-next-types'

const fixtures: ReturnType<typeof outcomeRuntimeFixture>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.dispose()
  }
})

const rowKey = JSON.stringify(['local', 'folder:outcome', 'source'])

/** One composed Agent block: a solo stage with its own instruction, nothing advanced. */
function block(name: string, over: Partial<UpNextAgentBlock> = {}): UpNextAgentBlock {
  return {
    id: `draft:${name}`,
    kind: 'agent',
    state: 'draft',
    number: '',
    locked: false,
    template: 'improve',
    shape: 'solo',
    n: 1,
    instruction: `Do ${name}.`,
    output: 'result',
    intent: 'handoff',
    advanced: {},
    promptCount: 0,
    ...over
  }
}

/** The stages as the panel shows them, by the person's own first line. */
const stages = (chain: SessionChain): [string, string][] =>
  upNextChainBlocks(chain, 1000)
    .filter((entry): entry is UpNextAgentBlock => entry.kind === 'agent')
    .map((entry) => [entry.instruction.split('\n')[0]!, entry.state])

async function pursuit() {
  const f = outcomeRuntimeFixture(() => ({ body: 'Worked' }))
  fixtures.push(f)
  f.service.dispose()
  vi.spyOn(f.service, 'start').mockImplementation(() => {})
  vi.spyOn(f.runtime, 'conversationAgent').mockReturnValue('claude')
  const skeleton: SessionChain = {
    id: 'chain',
    workspacePath: f.workspace,
    worktreeId: 'folder:outcome',
    hostId: 'local',
    placement: 'local',
    sourcePaneKey: 'source',
    sourceRowKey: rowKey,
    auto: true,
    steps: [],
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1
  } as SessionChain
  const live = (): SessionChain | null =>
    f.runtime.listSessionChains().find((entry) => entry.id === 'chain') ?? null
  const queue = async (stage: UpNextAgentBlock): Promise<void> => {
    const existing = live()
    const ctx: UpNextPlanContext = {
      runtime: f.runtime,
      agent: 'claude',
      chain: existing ?? skeleton,
      existing,
      composing: [stage]
    }
    const plan = upNextPlanWithStage(
      ctx,
      upNextPlanOf(ctx, 'Ship it', { verified: stage.template === 'verify' }),
      stage
    )
    await upNextCommitPlan(ctx, plan, 'Queued from Up next.', existing ? { mode: 'append' } : {})
  }
  await queue(block('a'))
  // The tick launched that seat: its attempt is running and the step is marked launched.
  const first = live()!
  const stepId = first.steps[0]!.id
  const attempt: SessionOutcomeAttempt = {
    id: 'att-1',
    outcomeId: first.outcomeSet!.outcomes[0]!.id,
    actionId: `step_${stepId}`,
    actionKey: 'k',
    outcomeRevision: first.outcomeSet!.outcomes[0]!.revision,
    state: 'running',
    startedAt: 1_000,
    updatedAt: 2_000
  }
  f.runtime.replaceSessionChainOutcomesAndFlush(
    {
      ...first,
      steps: first.steps.map((step) =>
        step.id === stepId && step.kind !== 'handoff'
          ? { ...step, status: 'launched', launchedAt: 1_000 }
          : step
      ),
      outcomeSet: { ...first.outcomeSet!, attempts: [attempt] }
    },
    first.outcomeSet!.revision
  )
  return { f, live, queue, stepId }
}

it('queues a second stage behind a running one, leaving the Outcome and its receipts alone', async () => {
  const { live, queue, stepId } = await pursuit()
  const before = live()!.outcomeSet!.outcomes[0]!

  await queue(block('b'))

  const after = live()!
  expect(stages(after)).toEqual([
    ['Do a.', 'running'],
    ['Do b.', 'queued']
  ])
  // The running seat is untouched, and its attempt still stands.
  expect(after.steps.find((step) => step.id === stepId)).toMatchObject({ status: 'launched' })
  expect(after.outcomeSet!.attempts.map((entry) => entry.state)).toEqual(['running'])
  // Adding work is not a change of Outcome: same revision, same status, so every receipt the
  // pursuit has earned still counts and nothing is re-proved.
  const outcome = after.outcomeSet!.outcomes[0]!
  expect(outcome.revision).toBe(before.revision)
  expect(outcome.status).toBe(before.status)
  expect(outcome.conditions).toEqual(before.conditions)
  expect(after.planVersion ?? 1).toBe(1)
})

it('states the real rule when a commit IS refused, rather than a key nobody can read', async () => {
  const { live, queue } = await pursuit()

  // A Verify stage states a NEW Done When, so this commit changes the Outcome itself while a seat
  // is in flight — which the reviser refuses (`session-outcome-revise.ts`, the identity guard).
  // The engine hands that rule to the caller IN WORDS; the panel's own translator only knows the
  // refusal keys, so an unknown message is what becomes "could not be made on this host" there
  // (renderer `up-next-refusal.ts`, a renderer follow-up).
  const refused = await queue(block('verify', { template: 'verify' })).then(
    () => 'queued',
    (error: unknown) => (error instanceof Error ? error.message : String(error))
  )
  expect(refused).toContain('in-flight or unverifiable action')
  expect(Object.values(UP_NEXT_REFUSAL_KEYS) as string[]).not.toContain(refused)
  // Nothing was half-written: the pursuit is the one stage it was.
  expect(stages(live()!)).toEqual([['Do a.', 'running']])
})
