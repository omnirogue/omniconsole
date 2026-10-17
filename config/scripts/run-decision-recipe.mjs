import { QUEUE_TRIAGE_RECIPES } from './decision-queue-recipes-v1.mjs'
import { queueTriageEnabled } from './decision-queue-configuration.mjs'
import { randomUUID } from 'node:crypto'
import { recipeQuestionHash, getDecisionRecipe } from './decision-recipe-registry.mjs'
import { runDecisionRecordCommand, decisionRecordFailure } from './decision-record-cli.mjs'
import { appendFileSync, readFileSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { buildRecipeRequest, DECISION_RECIPES, recipeDisposition } from './decision-recipes.mjs'
import { summarizeRecipeLedger, validateRecipeOutcome } from './decision-recipe-outcomes.mjs'
import { loadProductionPrimitives } from './decision-production-primitives.mjs'

export async function evaluateRecipe({
  recipeId,
  recipeVersion = 1,
  state,
  provider,
  timeoutMs = 5000,
  preserveRequestId = false,
  environment = process.env
}) {
  if (Object.hasOwn(QUEUE_TRIAGE_RECIPES, recipeId) && !queueTriageEnabled(environment)) {
    throw new Error('queue_triage_disabled')
  }
  const request = buildRecipeRequest(recipeId, state, recipeVersion)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) {
    throw new Error('invalid_timeout')
  }
  const started = performance.now()
  const controller = new AbortController()
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error('timeout'))
    }, timeoutMs)
  })
  try {
    const result = await Promise.race([
      provider.evaluate(request, { signal: controller.signal }),
      timeout
    ])
    if (result.provider !== 'typesafe' || result.model !== request.model) {
      throw new Error('invalid_response')
    }
    const disposition = recipeDisposition(recipeId, result.answers, recipeVersion)
    if (disposition === 'unavailable') {
      throw new Error('invalid_response')
    }
    return {
      status: 'success',
      disposition,
      model: result.model,
      elapsedMs: performance.now() - started,
      answers: result.answers,
      usage: result.usage,
      ...(preserveRequestId && result.requestId ? { requestId: result.requestId } : {}),
      actions: [],
      authority: 'advisory-only'
    }
  } catch {
    return {
      status: 'unavailable',
      disposition: 'review',
      elapsedMs: performance.now() - started,
      answers: {},
      actions: [],
      authority: 'advisory-only'
    }
  } finally {
    clearTimeout(timer)
  }
}

export function recipeMeasurement(
  recipeId,
  result,
  observationId = randomUUID(),
  recipeVersion = 1
) {
  return {
    schemaVersion: 1,
    observationId,
    recordedAt: new Date().toISOString(),
    recipeId,
    recipeVersion: getDecisionRecipe(recipeId, recipeVersion).version,
    questionHash: recipeQuestionHash(getDecisionRecipe(recipeId, recipeVersion)),
    ...result,
    baselineElapsedMs: null,
    independentLabels: null,
    realizedWorkflowSavingsMs: null
  }
}

async function main() {
  if (
    await runDecisionRecordCommand(process.argv.slice(2), { evaluateRecipe, recipeMeasurement })
  ) {
    return
  }
  const [command, recipeId, inputFile, ledgerFile] = process.argv.slice(2)
  if (command === 'summary' || command === 'outcome') {
    const ledger = command === 'summary' ? recipeId : inputFile
    if (!ledger || statSync(ledger).size > 16_777_216) {
      throw new Error('ledger_too_large')
    }
    const records = readFileSync(ledger, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    if (command === 'summary') {
      process.stdout.write(`${JSON.stringify(summarizeRecipeLedger(records), null, 2)}\n`)
    } else {
      if (statSync(recipeId).size > 16_384) {
        throw new Error('outcome_too_large')
      }
      const outcome = JSON.parse(readFileSync(recipeId, 'utf8'))
      const observations = records.filter(
        (row) => row.kind === undefined && row.observationId === outcome.observationId
      )
      if (
        observations.length !== 1 ||
        records.some((row) => row.kind === 'outcome' && row.observationId === outcome.observationId)
      ) {
        throw new Error('ambiguous_outcome')
      }
      const row = validateRecipeOutcome(outcome, observations[0])
      appendFileSync(ledger, `${JSON.stringify(row)}\n`, { mode: 0o600 })
      process.stdout.write(`${JSON.stringify(row)}\n`)
    }
    return
  }
  if (command === 'list') {
    process.stdout.write(
      `${JSON.stringify(
        Object.entries(DECISION_RECIPES).map(([id, recipe]) => ({ id, ...recipe })),
        null,
        2
      )}\n`
    )
    return
  }
  if (command !== 'decide' || !recipeId || !inputFile || !ledgerFile) {
    throw new Error('usage')
  }
  if (process.env.JEV_DECISIONS_DISABLED === '1') {
    throw new Error('disabled')
  }
  if (statSync(inputFile).size > 16_384) {
    throw new Error('input_too_large')
  }
  const state = JSON.parse(readFileSync(inputFile, 'utf8'))
  buildRecipeRequest(recipeId, state)
  const { TypeSafeDecisionProvider } = await loadProductionPrimitives()
  const provider = new TypeSafeDecisionProvider({
    resolveApiKey: async () => process.env.TYPESAFE_API_KEY
  })
  const result = await evaluateRecipe({ recipeId, state, provider })
  const record = recipeMeasurement(recipeId, result)
  // Ledger contains closed answers only, never prompts, customer IDs, credentials or raw errors.
  appendFileSync(ledgerFile, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`)
  if (result.status !== 'success') {
    process.exitCode = 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const previewFailure = decisionRecordFailure(process.argv[2], error)
    if (previewFailure) {
      process.stderr.write(`${JSON.stringify(previewFailure.body)}\n`)
      process.exitCode = previewFailure.exitCode
      return
    }
    process.stderr.write(
      'JEV unavailable. Usage: jev-decide list | decide <recipe> <state.json> <ledger.jsonl>. Check input, credentials, kill switch and ledger permissions.\n'
    )
    process.exitCode = 2
  })
}
