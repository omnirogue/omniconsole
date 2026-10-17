import { expect, it } from 'vitest'
import { agentFixture } from '../up-next-fixture'
import { customStagePatch, stagePlan } from './custom-stage-adapter'

it('maps one uniform stage into the existing patch without modifying its input', () => {
  const block = agentFixture('stage')
  const plan = stagePlan(block, { agent: 'claude' })
  const node = plan.nodes[0]!
  if (node.kind !== 'worker') {
    throw new Error('Worker missing')
  }
  node.count = 3
  node.actor = { agent: 'claude', model: 'opus', effort: 'high' }
  node.seats = Array.from({ length: 3 }, () => ({ ...node.actor }))
  const before = structuredClone(block)
  expect(customStagePatch(plan, block, 'claude')).toEqual({
    patch: {
      kind: 'agent',
      shape: 'parallel',
      n: 3,
      template: 'improve',
      instruction: block.instruction,
      advanced: { model: 'opus', effort: 'high', endOnSuccess: false }
    }
  })
  expect(block).toEqual(before)
})

it('refuses multiple stages without truncating or changing the block', () => {
  const block = agentFixture('stage')
  const plan = stagePlan(block, { agent: 'claude' })
  plan.nodes.splice(1, 0, { ...plan.nodes[0]!, id: 'second' })
  const before = structuredClone(block)
  expect(customStagePatch(plan, block, 'claude')).toEqual({ reason: 'multiStage' })
  expect(block).toEqual(before)
})

it('refuses per-seat actor differences the patch cannot preserve', () => {
  const block = agentFixture('stage')
  const plan = stagePlan(block, { agent: 'claude' })
  const node = plan.nodes[0]!
  if (node.kind !== 'worker') {
    throw new Error('Worker missing')
  }
  node.count = 2
  node.seats = [{ agent: 'claude' }, { agent: 'codex' }]
  expect(customStagePatch(plan, block, 'claude')).toEqual({ reason: 'unsupported' })
})

it('maps a single uniform worker to an executable solo stage', () => {
  const block = agentFixture('stage')
  expect(customStagePatch(stagePlan(block, { agent: 'claude' }), block, 'claude')).toMatchObject({
    patch: { shape: 'solo', n: 1 }
  })
})
