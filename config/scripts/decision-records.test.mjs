import assert from 'node:assert/strict'
import { test } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateDecisionResult } from '../../src/shared/structured-decisions'
import {
  getDecisionRecipe,
  decisionRecipeRegistry,
  recipeQuestionHash,
  DECISION_RECORD_GATES
} from './decision-recipe-registry.mjs'
import { evaluateRecipe, recipeMeasurement } from './run-decision-recipe.mjs'
import { buildRecipeRequest } from './decision-recipes.mjs'
import {
  evaluateDecisionRecord,
  validateDecisionPacket,
  validateDecisionRecordLedger,
  validateIndependentOutcome,
  recordDigest
} from './decision-record-contract.mjs'
import { decisionRecordCalibration } from './decision-record-calibration.mjs'
import { summarizeRecipeLedger } from './decision-recipe-outcomes.mjs'
import { decisionRecordFailure, decisionRecordFetch } from './decision-record-cli.mjs'
import {
  reliabilityBands,
  rankedProbabilityScore,
  wilsonInterval
} from './decision-calibration-statistics.mjs'
import { readDecisionLedger, withDecisionLedger } from './decision-record-ledger.mjs'

const enabled = { JEV_DECISION_RECORDS_ENABLED: '1' }
const digest = 'a'.repeat(64)
const scopeId = randomUUID()
const packet = () => ({
  recipeId: 'support_triage',
  recipeVersion: 1,
  state: { message: 'A private message never persisted' },
  context: {
    surface: 'manual_review',
    scopeId,
    subjectId: randomUUID(),
    sourceRevision: digest,
    checks: DECISION_RECORD_GATES.map((id) => ({ id, status: 'pass', evidenceDigest: digest }))
  }
})
function success() {
  const recipe = getDecisionRecipe('support_triage', 1)
  return {
    status: 'success',
    disposition: 'advisory',
    model: 'jev-1.13.0',
    elapsedMs: 4,
    usage: { inputTokens: 23, outputTokens: 0 },
    actions: [],
    authority: 'advisory-only',
    answers: {
      route: {
        type: 'choice',
        choice: 'how_to',
        probabilities: { billing: 0, technical: 0, how_to: 1, human: 0 },
        confidence: 1
      },
      priority: {
        type: 'score',
        score: 0,
        probabilities: { 0: 1, 1: 0, 2: 0, 3: 0 },
        legend: Object.fromEntries(
          recipe.questions.priority.criteria.map((label, i) => [i, label])
        ),
        confidence: 1
      },
      sensitive: { type: 'noul', noul: 0.05 }
    }
  }
}
const dependencies = { evaluate: async () => success(), measure: recipeMeasurement }
const observed = (input = packet()) => evaluateDecisionRecord(input, dependencies, enabled)
function independent(row, method = 'human_attested') {
  return {
    outcome: {
      observationId: row.observationId,
      labels: { route: 'how_to', priority: 0, sensitive: 1 },
      baselineElapsedMs: 1,
      baselineCorrect: true,
      workflowElapsedMs: 150,
      baselineWorkflowElapsedMs: 100,
      source: {
        human_attested: 'human',
        verified_record: 'verified_outcome',
        model_reference: 'model_reference'
      }[method]
    },
    provenance: { method, evidenceDigest: digest, inputDigest: row.decisionRecord.inputDigest }
  }
}

test('archive owns its pin, policy and gates; callers cannot change history or execute the trace stub', () => {
  const registry = decisionRecipeRegistry()
  assert.equal(registry.length, 7)
  assert.equal(registry.at(-1).executable, false)
  assert.equal(getDecisionRecipe('__proto__'), undefined)
  assert.equal(getDecisionRecipe('support_triage', 2), undefined)
  assert.throws(() => buildRecipeRequest('trace_review', {}))
  assert.throws(() => validateDecisionPacket({ ...packet(), recipeVersion: 2 }))
  const recipe = getDecisionRecipe('support_triage', 1)
  const hash = recipeQuestionHash(recipe)
  recipe.questions.route.instructions = 'mutated'
  recipe.model = 'new-model'
  recipe.admissionGates.push('new-gate')
  assert.equal(recipeQuestionHash(getDecisionRecipe('support_triage', 1)), hash)
  assert.equal(buildRecipeRequest('support_triage', packet().state, 1).model, 'jev-1.13.0')
  assert.equal(getDecisionRecipe('support_triage', 1).admissionGates.length, 3)
  assert.equal(getDecisionRecipe('support_triage', 1).policyId, 'support_triage@1')
})

test('flag, kill and attested checks prevent inference; unsupported surfaces never gain provenance', async () => {
  let calls = 0
  const deps = {
    ...dependencies,
    evaluate: async () => {
      calls++
      return success()
    }
  }
  await assert.rejects(evaluateDecisionRecord(packet(), deps, {}))
  for (const status of ['fail', 'unknown']) {
    const input = packet()
    input.context.checks[0].status = status
    const row = await evaluateDecisionRecord(input, deps, enabled)
    assert.equal(row.status, 'unavailable')
    assert.equal(row.decisionRecord.reason, 'attested_gate')
    assert.equal(row.decisionRecord.actualModel, null)
    assert.deepEqual(row.answers, {})
  }
  for (const kill of ['JEV_DECISIONS_DISABLED', 'OMNI_STRUCTURED_DECISIONS_KILL']) {
    const row = await evaluateDecisionRecord(packet(), deps, { ...enabled, [kill]: 'true' })
    assert.equal(row.decisionRecord.reason, 'disabled')
  }
  for (const surface of ['routine_pre_run', 'dependency_review', 'human_review', 'trace_review']) {
    const input = packet()
    input.context.surface = surface
    assert.throws(() => validateDecisionPacket(input))
  }
  assert.equal(calls, 0)
})

test('version is threaded through inference and measurement, and records omit raw state', async () => {
  const input = packet()
  let version
  const row = await evaluateDecisionRecord(
    input,
    {
      ...dependencies,
      evaluate: async (_id, _state, receivedVersion) => {
        version = receivedVersion
        return success()
      }
    },
    enabled
  )
  assert.equal(version, 1)
  assert.equal(JSON.stringify(row).includes(input.state.message), false)
  assert.deepEqual(row.actions, [])
  assert.equal(
    row.decisionRecord.inputDigest,
    recordDigest({
      recipeId: input.recipeId,
      state: buildRecipeRequest(input.recipeId, input.state, 1).state
    })
  )
  await assert.rejects(
    evaluateDecisionRecord(
      input,
      {
        ...dependencies,
        measure: () => ({ recipeVersion: 2 })
      },
      enabled
    ),
    /recipe_version_mismatch/
  )
})

test('calibration preserves baseline losses, disposition error, missingness and repeated subjects', async () => {
  const input = packet()
  const row = await observed(input)
  const repeated = await observed(input)
  const outcome = validateIndependentOutcome(independent(row), row)
  const failedInput = packet()
  failedInput.context.checks[0].status = 'unknown'
  const failed = await observed(failedInput)
  const failedOutcome = validateIndependentOutcome(independent(failed), failed)
  const legacy = await observed()
  delete legacy.decisionRecord
  const report = decisionRecordCalibration(
    [row, outcome, repeated, failed, failedOutcome, legacy],
    validateDecisionResult
  )
  assert.equal(report.cohorts.length, 2)
  const cohort = report.cohorts.find((value) => value.hasDecisionRecord)
  assert.equal(cohort.attempted, 3)
  assert.equal(cohort.distinctSubjects, 2)
  assert.equal(cohort.repeatedSubjectInputs, 1)
  assert.equal(cohort.unavailableReasons.attested_gate, 1)
  assert.equal(cohort.attestedIndependentLabels, 2)
  assert.equal(cohort.latencyAllAttemptsMedianMs, 4)
  const human = cohort.outcomes[0]
  assert.equal(human.comparison.pairedAccuracyDelta, -1)
  assert.equal(human.comparison.pairedQualityCount, 2)
  assert.equal(human.comparison.pairedMeanLatencySavedMs, -3)
  assert.equal(human.comparison.slowerLatencyCount, 1)
  assert.equal(human.comparison.meanWorkflowSavedMs, -50)
  assert.equal(human.comparison.slowerWorkflowCount, 2)
  assert.equal(human.disposition.conditionalAdvisoryErrorRate, 1)
  const noul = human.questions.find((q) => q.type === 'noul')
  assert.equal(noul.unavailable, 1)
  assert.equal(noul.scored, 1)
  assert.ok(Math.abs(noul.brier - 0.9025) < 1e-9)
  assert.equal(noul.bands[0].observedLabelRate, 1)
  assert.equal(noul.bands[0].count, 1)
  assert.equal(noul.rawPairs.length, 1)
  assert.equal(report.deploymentVerdict, 'inconclusive')
  const summary = summarizeRecipeLedger([row, outcome]).find((r) => r.recipeId === row.recipeId)
  assert.equal(summary.pairedAccuracyDelta, -1)
})

test('partial and model-reference labels stay honest and bind to the observation digest', async () => {
  const row = await observed()
  const input = independent(row)
  input.outcome.labels.sensitive = null
  const outcome = validateIndependentOutcome(input, row)
  const modelRow = await observed()
  const modelOutcome = validateIndependentOutcome(
    independent(modelRow, 'model_reference'),
    modelRow
  )
  const cohort = decisionRecordCalibration(
    [row, outcome, modelRow, modelOutcome],
    validateDecisionResult
  ).cohorts[0]
  assert.equal(cohort.modelReferenceLabels, 1)
  assert.equal(cohort.attestedIndependentLabels, 1)
  assert.equal(cohort.pairedQualityCount, 0)
  assert.equal(cohort.outcomes[0].questions.find((q) => q.type === 'noul').scored, 0)
  assert.equal(cohort.outcomes[2].comparison.pairedQualityCount, 1)
  assert.equal(summarizeRecipeLedger([modelRow, modelOutcome])[0].labelled, 0)
  input.provenance.inputDigest = 'b'.repeat(64)
  assert.throws(() => validateIndependentOutcome(input, row))
  input.provenance.inputDigest = row.decisionRecord.inputDigest
  input.outcome.labels.priority = 0.5
  assert.throws(() => validateIndependentOutcome(input, row))
})

test('bands include boundaries exactly once, intervals show uncertainty, and Score uses its distribution', () => {
  const bands = reliabilityBands([0, 0.1, 0.2, 0.8, 0.9, 1].map((p) => [p, 1]))
  assert.deepEqual(
    bands.map((band) => band.count),
    [1, 1, 2, 1, 1]
  )
  assert.equal(wilsonInterval(0, 0), null)
  assert.ok(wilsonInterval(1, 1).lower < 0.3)
  assert.equal(rankedProbabilityScore({ probabilities: { 0: 1, 1: 0, 2: 0 } }, 0), 0)
  assert.equal(rankedProbabilityScore({ probabilities: { 0: 1, 1: 0, 2: 0 } }, 2), 1)
})

test('invalid distributions, model/hash/disposition drift and duplicate labels cannot calibrate', async () => {
  const row = await observed()
  for (const mutate of [
    (r) => {
      r.questionHash = digest
    },
    (r) => {
      r.model = 'jev-latest'
    },
    (r) => {
      r.answers.route.probabilities.how_to = 0.2
    },
    (r) => {
      r.disposition = 'approve'
    },
    (r) => {
      r.decisionRecord.context.checks[0].status = 'fail'
    },
    (r) => {
      r.decisionRecord.policyVersion = 2
    }
  ]) {
    const bad = structuredClone(row)
    mutate(bad)
    assert.throws(() => decisionRecordCalibration([bad], validateDecisionResult))
  }
  const outcome = validateIndependentOutcome(independent(row), row)
  assert.throws(() => validateDecisionRecordLedger([outcome], validateDecisionResult))
  assert.throws(() => validateDecisionRecordLedger([row, outcome, outcome], validateDecisionResult))
  const input = packet()
  input.context.checks.push(input.context.checks[0])
  assert.throws(() => validateDecisionPacket(input))
  assert.throws(() => validateDecisionPacket({ ...packet(), labels: {} }))
})

test('timeout stays unavailable; the opt-in transport sends UA, respects kill, and retains request identity', async () => {
  const row = await evaluateDecisionRecord(
    packet(),
    {
      measure: recipeMeasurement,
      evaluate: (recipeId, state, recipeVersion) =>
        evaluateRecipe({
          recipeId,
          recipeVersion,
          state,
          timeoutMs: 2,
          provider: { evaluate: () => new Promise(() => {}) }
        })
    },
    enabled
  )
  assert.equal(row.status, 'unavailable')
  assert.equal(row.decisionRecord.reason, 'provider_unavailable')
  assert.deepEqual(row.answers, {})
  let headers
  const transport = decisionRecordFetch(enabled, async (_url, init) => {
    headers = init.headers
    return 'ok'
  })
  assert.equal(await transport('https://example.invalid', { headers: {} }), 'ok')
  assert.equal(headers.get('User-Agent'), 'OmniConsole-JEV-Decision-Records/1')
  assert.throws(() =>
    decisionRecordFetch({ OMNI_STRUCTURED_DECISIONS_KILL: 'true' }, () => assert.fail())('x', {})
  )
  const result = await evaluateRecipe({
    recipeId: 'support_triage',
    state: packet().state,
    preserveRequestId: true,
    provider: {
      evaluate: async () => ({ ...success(), provider: 'typesafe', requestId: 'vendor-123' })
    }
  })
  assert.equal(result.requestId, 'vendor-123')
})

test('preview errors never echo input, and distinguish no append from uncertain persistence', () => {
  assert.equal(decisionRecordFailure('decide', new Error('anything')), null)
  const rejected = decisionRecordFailure('decide-record', new Error('invalid_input'))
  assert.equal(rejected.exitCode, 3)
  assert.equal(rejected.body.recorded, false)
  const privateError = decisionRecordFailure('calibration', new SyntaxError('secret customer text'))
  assert.equal(JSON.stringify(privateError).includes('secret'), false)
  assert.equal(privateError.exitCode, 4)
  assert.equal(
    decisionRecordFailure('decide-record', { code: 'EEXIST' }).body.code,
    'ledger_locked'
  )
})

test('ledger serializes writers, records lock ownership, rejects truncation and releases on failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'decision-record-'))
  const path = join(directory, 'ledger.jsonl')
  try {
    let release
    let started
    const entered = new Promise((resolve) => {
      started = resolve
    })
    const blocked = new Promise((resolve) => {
      release = resolve
    })
    const writer = withDecisionLedger(path, async () => {
      started()
      await blocked
      return { sample: 1 }
    })
    await entered
    try {
      const owner = JSON.parse(await readFile(`${path}.lock`, 'utf8'))
      assert.equal(owner.pid, process.pid)
      assert.ok(owner.host)
      await assert.rejects(
        withDecisionLedger(path, async () => ({ sample: 2 })),
        { code: 'EEXIST' }
      )
    } finally {
      release()
      await writer
    }
    assert.deepEqual(await readDecisionLedger(path), [{ sample: 1 }])
    await assert.rejects(
      withDecisionLedger(path, () => {
        throw new Error('stop')
      })
    )
    assert.equal(await readFile(path, 'utf8'), '{"sample":1}\n')
    await writeFile(path, '{"incomplete":true}')
    await assert.rejects(readDecisionLedger(path), /incomplete_ledger/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
