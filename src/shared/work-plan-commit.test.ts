import { expect, it, vi } from 'vitest'
import { commitWorkPlan, type WorkPlanCommitRequest } from './work-plan-commit'
import { compileWorkPlanExecution } from './work-plan-compile'
import { workPlanFromChain } from './work-plan-read'
import { workPlanNotation } from './work-plan-notation'
import { samWorkPlan } from './__fixtures__/work-plan/wp2/sal-work-plan'
import { goldenChain } from './__fixtures__/work-plan/wp2/compiled-chain'
import {
  workPlanFixtureContext,
  WORK_PLAN_FIXTURE_ACTORS
} from './__fixtures__/work-plan/work-plan-context'
import type { WorkPlan } from './work-plan-types'

it('uses the same commit door on Chat, Terminal and CLI; taskRef does not create a continuation', async () => {
  for (const surface of ['chat', 'terminal', 'cli']) {
    const chain = goldenChain()
    delete chain.outcomeSet
    chain.steps = []
    chain.sourcePaneKey = surface
    const commit = vi.fn(async (request: WorkPlanCommitRequest) => request.chain)
    const plan = samWorkPlan()
    plan.outcome.taskRef = 'btk_9fA2'
    expect(
      await commitWorkPlan(plan, {
        ...workPlanFixtureContext(),
        chain,
        commitSessionOutcomes: commit
      })
    ).toEqual({ chainId: chain.id })
    expect(commit).toHaveBeenCalledOnce()
    const request = commit.mock.calls[0]![0]
    expect(request.taskRef).toEqual({ taskId: 'btk_9fA2', attachedAt: expect.any(Number) })
    expect(request.chain.outcomeSet).toBeUndefined()
    expect(request.chain.parallelOutcomeIds).toBeUndefined()
    expect(request.outcomes).toHaveLength(1)
    expect(request.outcomes[0]).not.toHaveProperty('taskRef')
  }
})

it('attach-later keeps steps and expected revision and versions the plan without re-emitting seats', async () => {
  const chain = goldenChain()
  const plan = workPlanFromChain(chain)
  plan.outcome.taskRef = 'btk_9fA2'
  const commit = vi.fn(async (request: WorkPlanCommitRequest) => request.chain)
  expect(
    await commitWorkPlan(plan, {
      ...workPlanFixtureContext({ existingChain: chain }),
      chain,
      commitSessionOutcomes: commit
    })
  ).toEqual({ chainId: chain.id })
  const request = commit.mock.calls[0]![0]
  expect(request.chain.steps).toEqual(chain.steps)
  expect(request.expectedRevision).toBe(chain.outcomeSet!.revision)
  expect(request.supersede).toEqual({ reason: expect.any(String) })
  expect(request.outcomes[0]).toEqual(
    expect.objectContaining({ conditions: chain.outcomeSet!.outcomes[0]!.conditions })
  )
})

it('supersede lowers only new nodes, retains history and increments the plan version', async () => {
  const chain = goldenChain()
  const plan: WorkPlan = {
    outcome: samWorkPlan().outcome,
    nodes: [
      {
        kind: 'worker',
        id: 'new-research',
        role: 'research',
        actor: WORK_PLAN_FIXTURE_ACTORS.grok,
        instruction: ''
      },
      {
        kind: 'worker',
        id: 'new-verify',
        role: 'verify',
        actor: WORK_PLAN_FIXTURE_ACTORS.codex,
        instruction: '',
        readsFrom: ['new-research'],
        verdict: {
          kind: 'verify',
          over: samWorkPlan().outcome.doneWhen.map((d) => d.id),
          consumed: 'gate'
        }
      },
      { kind: 'finish', id: 'finish', how: 'my-review' }
    ]
  }
  const ctx = workPlanFixtureContext({ existingChain: chain })
  const compiled = compileWorkPlanExecution(plan, ctx)
  expect(compiled.problems).toEqual([])
  expect(compiled.steps).toHaveLength(2)
  expect(compiled.steps.every((s) => s.planVersion === 2)).toBe(true)
  const commit = vi.fn(async (request: WorkPlanCommitRequest) => request.chain)
  const before = structuredClone(chain)
  expect(
    await commitWorkPlan(plan, {
      ...ctx,
      chain,
      supersedeReason: 'Missing evidence',
      commitSessionOutcomes: commit
    })
  ).toEqual({ chainId: chain.id })
  const request = commit.mock.calls[0]![0]
  expect(request.supersede).toEqual({ reason: 'Missing evidence' })
  expect(request.chain.steps.slice(0, 10)).toEqual(before.steps)
  expect(request.chain.steps).toHaveLength(12)
  expect(request.outcomes[0]!.stepIds).toHaveLength(12)
  expect(request.outcomes[0]!.conditions).toEqual(chain.outcomeSet!.outcomes[0]!.conditions)
  expect(workPlanNotation(request.chain)).toBe('v1 ✗ superseded · v2 Research → ✓ → 👤')
  expect(chain).toEqual(before)
})

it('refuses an invalid plan before calling the commit door', async () => {
  const commit = vi.fn()
  const plan = samWorkPlan()
  plan.outcome.doneWhen.push({
    id: 'cmd',
    text: 'Run check',
    evidence: 'command',
    command: { program: 'node', args: [] }
  })
  const result = await commitWorkPlan(plan, {
    ...workPlanFixtureContext({ commitSource: 'proposer' }),
    chain: goldenChain(),
    commitSessionOutcomes: commit
  })
  expect(result).toHaveProperty('problems')
  expect(commit).not.toHaveBeenCalled()
})

it('mints a new v2 seat when an existing node changes and leaves retirement to supersede', async () => {
  const chain = goldenChain()
  const plan = workPlanFromChain(chain)
  const node = plan.nodes.find((n) => n.id === 'improve')!
  if (node.kind === 'finish') {
    throw new Error('Expected worker')
  }
  node.instruction = 'Use the winning plan and improve accessibility.'
  const commit = vi.fn(async (request: WorkPlanCommitRequest) => request.chain)
  expect(
    await commitWorkPlan(plan, {
      ...workPlanFixtureContext({ existingChain: chain }),
      chain,
      commitSessionOutcomes: commit
    })
  ).toEqual({ chainId: chain.id })
  const request = commit.mock.calls[0]![0]
  expect(request.chain.planVersion).toBe(2)
  expect(request.chain.steps.slice(0, chain.steps.length)).toEqual(chain.steps)
  const added = request.chain.steps.slice(chain.steps.length)
  expect(added).toHaveLength(1)
  expect(added[0]).toMatchObject({ planNodeId: 'improve', planVersion: 2 })
  expect(chain.steps.some((s) => s.id === added[0]!.id)).toBe(false)
  expect(added[0]!.kind !== 'handoff' && added[0]!.prompt).toContain(`/${added[0]!.id}/manifest.md`)
  expect(request.supersede).toBeDefined()
})

it('a finish-only revision changes plan version but preserves outcome revision', async () => {
  const { reviseSessionOutcomeSet } = await import('./session-outcome-state.js')
  const chain = goldenChain()
  const plan = workPlanFromChain(chain)
  plan.nodes[plan.nodes.length - 1] = { kind: 'finish', id: 'finish', how: 'complete' }
  const commit = vi.fn(async (request: WorkPlanCommitRequest) => request.chain)
  await commitWorkPlan(plan, {
    ...workPlanFixtureContext({ existingChain: chain }),
    chain,
    commitSessionOutcomes: commit
  })
  const request = commit.mock.calls[0]![0]
  expect(request.chain.steps).toEqual(chain.steps)
  expect(request.chain.planVersion).toBe(2)
  expect(request.chain.end).toBe('done')
  const revised = reviseSessionOutcomeSet(
    chain.outcomeSet,
    request,
    { owner: 'execution-host', hostId: 'local', epoch: 'test', state: 'owned' },
    1
  )
  expect(revised.outcomes[0]!.revision).toBe(chain.outcomeSet!.outcomes[0]!.revision)
  expect(revised.outcomes[0]!.conditions).toEqual(chain.outcomeSet!.outcomes[0]!.conditions)
})
