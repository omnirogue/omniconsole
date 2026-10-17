/**
 * Removing ONE queued stage retires that stage — and nothing else.
 *
 * The whole pipeline, as production runs it: three ＋ Agent commits through the real lowering,
 * then a removal through `upNextRecommitWithout`, the real durable commit
 * (`commitSessionOutcomeSet` → supersede → `markSupersededPlanSteps`) and the real projection the
 * person reads. Before the fix the plan that dropped the middle stage retired every unfinished
 * step of the old version, so the stage BESIDE the removed one left Up next without ever running.
 */

import { afterEach, expect, it, vi } from 'vitest'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'
import { upNextChainBlocks } from './up-next-blocks'
import { upNextRecommitWithout } from './up-next-plan-move'
import {
  upNextCommitPlan,
  upNextPlanOf,
  upNextPlanWithStage,
  type UpNextPlanContext
} from './up-next-plan-edit'
import type { SessionChain } from '../../shared/session-chain-types'
import type { UpNextAgentBlock } from '../../shared/up-next-types'

const fixtures: ReturnType<typeof outcomeRuntimeFixture>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.dispose()
  }
})

const conversationId = {
  kind: 'pty' as const,
  worktreeId: 'folder:outcome',
  paneKey: 'source'
}
const rowKey = JSON.stringify(['local', 'folder:outcome', 'source'])

/** One composed Agent block: a solo stage with its own instruction, nothing advanced. */
function block(name: string): UpNextAgentBlock {
  return {
    id: `draft:${name}`,
    kind: 'agent',
    state: 'draft',
    number: '',
    locked: false,
    template: 'implement',
    shape: 'solo',
    n: 1,
    instruction: `Do ${name}.`,
    output: 'result',
    intent: 'handoff',
    advanced: {},
    promptCount: 0
  }
}

async function threeQueuedStages() {
  const f = outcomeRuntimeFixture(() => ({ body: 'Worked' }))
  fixtures.push(f)
  f.service.dispose()
  vi.spyOn(f.service, 'start').mockImplementation(() => {})
  vi.spyOn(f.runtime, 'conversationAgent').mockReturnValue('codex')
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
  for (const name of ['a', 'b', 'c']) {
    const existing = live()
    const ctx: UpNextPlanContext = {
      runtime: f.runtime,
      agent: 'codex',
      chain: existing ?? skeleton,
      existing
    }
    const plan = upNextPlanWithStage(ctx, upNextPlanOf(ctx, 'Ship it'), block(name))
    await upNextCommitPlan(ctx, plan, 'Queued from Up next.', existing ? { mode: 'append' } : {})
  }
  return { f, committed: live()! }
}

/** The stages, as the panel shows them. The instruction's first line is the person's own words;
 * the executor's output-dir sentence rides behind it and is not what this test is about. */
const agentBlocks = (chain: SessionChain) =>
  upNextChainBlocks(chain, 1000)
    .filter((entry): entry is UpNextAgentBlock => entry.kind === 'agent')
    .map((entry) => ({ ...entry, instruction: entry.instruction.split('\n')[0]! }))

it('keeps the stages beside a removed one queued, with their own identities', async () => {
  const { f, committed } = await threeQueuedStages()
  const before = agentBlocks(committed)
  expect(before.map((entry) => [entry.instruction, entry.state])).toEqual([
    ['Do a.', 'queued'],
    ['Do b.', 'queued'],
    ['Do c.', 'queued']
  ])
  const firstStepId = before[0]!.stepId
  await upNextRecommitWithout({ runtime: f.runtime, conversationId, rowKey }, before[1]!)
  const after = f.runtime.listSessionChains().find((entry) => entry.id === 'chain')!
  const shown = agentBlocks(after)
  expect(shown.map((entry) => [entry.instruction, entry.state])).toEqual([
    ['Do a.', 'queued'],
    ['Do c.', 'queued']
  ])
  // The unchanged stage stays the very step it was: nothing is re-minted, so nothing runs twice.
  expect(shown[0]!.stepId).toBe(firstStepId)
  expect(after.steps.find((step) => step.id === firstStepId)).toMatchObject({ status: 'queued' })
  expect(after.outcomeSet!.completedSteps).not.toContain(firstStepId)
  // The removed stage is retired, and every step id in the chain is still its own.
  expect(after.outcomeSet!.completedSteps).toContain(before[1]!.stepId)
  expect(new Set(after.steps.map((step) => step.id)).size).toBe(after.steps.length)
})
