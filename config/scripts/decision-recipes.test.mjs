import assert from 'node:assert/strict'
import { test } from 'vitest'
import { buildRecipeRequest, DECISION_RECIPES, recipeDisposition } from './decision-recipes.mjs'
import { RECIPE_EVALUATION_CASES } from './decision-recipe-corpus.mjs'
import { evaluateRecipe, recipeMeasurement } from './run-decision-recipe.mjs'
import { summarizeRecipeLedger, validateRecipeOutcome } from './decision-recipe-outcomes.mjs'

test('all recipes use all three primitives; labels and unexpected fields never enter requests', () => {
  assert.equal(Object.keys(DECISION_RECIPES).length, 6)
  for (const item of RECIPE_EVALUATION_CASES) {
    assert.deepEqual(
      new Set(Object.values(item.questions).map((q) => q.type)),
      new Set(['choice', 'score', 'noul'])
    )
    const request = buildRecipeRequest(item.task, item.state)
    assert.equal(request.expected, undefined)
    assert.throws(() => buildRecipeRequest(item.task, { ...item.state, expected: item.expected }))
  }
  assert.throws(() => buildRecipeRequest('__proto__', {}))
  assert.throws(() => buildRecipeRequest('support_triage', { message: 'x'.repeat(6001) }))
})

const answers = {
  route: { type: 'choice', choice: 'billing', confidence: 1 },
  priority: { type: 'score', score: 1, confidence: 1 },
  sensitive: { type: 'noul', noul: 1 }
}
test('high confidence never authorizes a sensitive customer action; malformed is unavailable', () => {
  assert.equal(recipeDisposition('support_triage', answers), 'review')
  assert.equal(
    recipeDisposition('support_triage', {
      ...answers,
      sensitive: { type: 'noul', noul: Number.NaN }
    }),
    'unavailable'
  )
})
test('provider outage, model mismatch and timeout fail closed without actions', async () => {
  for (const evaluate of [
    async () => {
      throw new Error('secret')
    },
    async () => ({ model: 'other', answers }),
    () => new Promise(() => {})
  ]) {
    const result = await evaluateRecipe({
      recipeId: 'support_triage',
      state: { message: 'refund' },
      provider: { evaluate },
      timeoutMs: 5
    })
    assert.equal(result.status, 'unavailable')
    assert.deepEqual(result.actions, [])
    assert.equal(JSON.stringify(result).includes('secret'), false)
  }
})
test('independent outcomes preserve unknown baselines and count failures; reject duplicate labels', () => {
  const observed = recipeMeasurement('support_triage', {
    status: 'unavailable',
    disposition: 'review',
    elapsedMs: 100,
    answers: {},
    actions: [],
    authority: 'advisory-only'
  })
  const input = {
    observationId: observed.observationId,
    labels: { route: 'billing', priority: 1, sensitive: 1 },
    baselineElapsedMs: null,
    baselineCorrect: true,
    workflowElapsedMs: null,
    baselineWorkflowElapsedMs: null,
    source: 'human'
  }
  const outcome = validateRecipeOutcome(input, observed)
  const summary = summarizeRecipeLedger([observed, outcome])[0]
  assert.equal(summary.correct, 0)
  assert.equal(summary.pairedAccuracyDelta, -1)
  assert.equal(summary.pairedMeanLatencySavedMs, null)
  assert.equal(summary.meanWorkflowSavedMs, null)
  assert.throws(() => summarizeRecipeLedger([observed, outcome, outcome]))
  assert.throws(() => validateRecipeOutcome({ ...input, baselineElapsedMs: -1 }, observed))
})
