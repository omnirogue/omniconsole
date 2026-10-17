import { expect, it } from 'vitest'
import { planReportChain } from './__fixtures__/work-plan/plan-report-chain'
import { sessionOutcomeConditionKey } from './session-outcome-types'
import { taskOutcomeCounts, taskOutcomeRows } from './task-outcome-rows'

const CARD = 'btk_launch01'
function pursuit(id: string, satisfied: boolean) {
  const chain = planReportChain()
  chain.id = id
  const set = chain.outcomeSet!
  const outcome = set.outcomes[0]!
  outcome.evidence[0]!.conditionKey = sessionOutcomeConditionKey(outcome.conditions[0]!)
  if (satisfied) {
    set.completedSteps = outcome.stepIds
    outcome.evidence = outcome.conditions.map((condition, i) => ({
      ...outcome.evidence[0]!,
      id: `proof-${i}`,
      conditionId: condition.id,
      conditionKey: sessionOutcomeConditionKey(condition),
      kind: condition.kind,
      target: condition.target
    }))
  }
  const last = chain.steps.at(-1)!
  if (last.kind !== 'handoff') {
    last.role = 'reviewer'
  }
  return chain
}

it('lists taskRef and continuation outcomes under one card with live k/n and counts', () => {
  const first = pursuit('first', false)
  first.outcomeSet!.outcomes[0]!.taskRef = { taskId: CARD, attachedAt: 1 }
  const second = pursuit('second', true)
  second.outcomeSet!.continuation.taskId = CARD
  const before = JSON.stringify([first, second])
  const rows = taskOutcomeRows([first, second], CARD)
  expect(
    rows.map(({ satisfied, total, status, lastStageGlyph }) => ({
      satisfied,
      total,
      status,
      lastStageGlyph
    }))
  ).toEqual([
    { satisfied: 1, total: 2, status: 'running', lastStageGlyph: '✓' },
    { satisfied: 2, total: 2, status: 'satisfied', lastStageGlyph: '✓' }
  ])
  expect(taskOutcomeCounts([first, second], CARD)).toEqual({ satisfied: 1, total: 2 })
  expect(JSON.stringify([first, second])).toBe(before)
})

it('omits ordinary chats and unrelated cards', () => {
  const chat = pursuit('chat', false)
  delete chat.outcomeSet
  expect(taskOutcomeRows([chat, pursuit('standalone', false)], CARD)).toEqual([])
  expect(taskOutcomeCounts([chat], CARD)).toEqual({ satisfied: 0, total: 0 })
})

it('does not count stale or mismatched receipts, or duplicate a dual-bound outcome', () => {
  const chain = pursuit('stale', true)
  const set = chain.outcomeSet!
  set.continuation.taskId = CARD
  const outcome = set.outcomes[0]!
  outcome.taskRef = { taskId: CARD, attachedAt: 1 }
  outcome.status = 'satisfied'
  outcome.evidence[0]!.outcomeRevision = 0
  outcome.evidence[1]!.conditionKey = 'wrong'
  const rows = taskOutcomeRows([chain], CARD)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ satisfied: 0, total: 2, status: 'pending' })
})
