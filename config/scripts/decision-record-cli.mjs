import {
  recordCommands,
  requireDecisionRecordFlag,
  inferenceDisabled,
  evaluateDecisionRecord,
  validateDecisionPacket,
  validateDecisionRecordLedger,
  validateIndependentOutcome
} from './decision-record-contract.mjs'
import { decisionRecipeRegistry } from './decision-recipe-registry.mjs'
import { decisionRecordCalibration } from './decision-record-calibration.mjs'
import {
  readBoundedJson,
  readDecisionLedger,
  withDecisionLedger
} from './decision-record-ledger.mjs'
import { loadProductionPrimitives } from './decision-production-primitives.mjs'

const rejected = new Set([
  'usage',
  'decision_records_disabled',
  'invalid_decision_packet',
  'invalid_decision_context',
  'unsupported_recipe_version',
  'invalid_state',
  'invalid_recipe_input',
  'unexpected_state_field',
  'invalid_state_field',
  'input_too_large',
  'invalid_outcome',
  'invalid_timing',
  'invalid_baseline',
  'invalid_labels',
  'invalid_label',
  'invalid_outcome_provenance',
  'orphan_record',
  'legacy_ledger_read_only'
])
export function decisionRecordFailure(command, error) {
  if (!recordCommands.includes(command)) {
    return null
  }
  const code = rejected.has(error?.message)
    ? error.message
    : error?.message === 'invalid_input'
      ? 'invalid_input'
      : error?.code === 'EEXIST'
        ? 'ledger_locked'
        : error?.message === 'ledger_invalid'
          ? 'ledger_invalid'
          : 'operation_unconfirmed'
  const knownRejected = rejected.has(code) || code === 'invalid_input'
  return {
    exitCode: knownRejected ? 3 : 4,
    body: {
      status: knownRejected ? 'rejected' : 'unconfirmed',
      code,
      recorded: knownRejected ? false : null,
      authority: 'advisory-only'
    }
  }
}

export function decisionRecordFetch(environment, fetchImpl = fetch) {
  return (url, init) => {
    if (inferenceDisabled(environment)) {
      throw new Error('disabled')
    }
    const headers = new Headers(init.headers)
    headers.set('User-Agent', 'OmniConsole-JEV-Decision-Records/1')
    return fetchImpl(url, { ...init, headers })
  }
}

async function readValidatedLedger(path, validateResult, allowMissing = false) {
  try {
    const rows = await readDecisionLedger(path, allowMissing)
    validateDecisionRecordLedger(rows, validateResult)
    return rows
  } catch {
    throw new Error('ledger_invalid')
  }
}
function validateWritableLedger(records, validateResult) {
  const ledger = validateDecisionRecordLedger(records, validateResult)
  if (ledger.observations.some((row) => !row.decisionRecord)) {
    throw new Error('legacy_ledger_read_only')
  }
  return ledger
}

async function decide(input, path, dependencies, environment, primitives) {
  validateDecisionPacket(input)
  validateWritableLedger(
    await readValidatedLedger(path, primitives.validateDecisionResult, true),
    primitives.validateDecisionResult
  )
  const provider = new primitives.TypeSafeDecisionProvider({
    resolveApiKey: async () => environment.TYPESAFE_API_KEY,
    fetch: decisionRecordFetch(environment)
  })
  // Inference is outside the lock; the ledger is re-read and validated before append.
  const row = await evaluateDecisionRecord(
    input,
    {
      evaluate: (recipeId, state, recipeVersion) =>
        dependencies.evaluateRecipe({
          recipeId,
          recipeVersion,
          state,
          provider,
          preserveRequestId: true
        }),
      measure: dependencies.recipeMeasurement
    },
    environment
  )
  return withDecisionLedger(path, (records) => {
    validateWritableLedger(records, primitives.validateDecisionResult)
    validateDecisionRecordLedger([...records, row], primitives.validateDecisionResult)
    return row
  })
}

export async function runDecisionRecordCommand(args, dependencies, environment = process.env) {
  const [command, inputPath, ledgerPath] = args
  if (!recordCommands.includes(command)) {
    return false
  }
  requireDecisionRecordFlag(environment)
  let output
  if (command === 'registry') {
    if (args.length !== 1) {
      throw new Error('usage')
    }
    output = decisionRecipeRegistry()
  } else {
    if (args.length !== (command === 'calibration' ? 2 : 3)) {
      throw new Error('usage')
    }
    const primitives = await loadProductionPrimitives()
    if (command === 'calibration') {
      output = decisionRecordCalibration(
        await readValidatedLedger(inputPath, primitives.validateDecisionResult),
        primitives.validateDecisionResult
      )
    } else {
      let input
      try {
        input = await readBoundedJson(inputPath)
      } catch {
        throw new Error('invalid_input')
      }
      if (command === 'decide-record') {
        output = await decide(input, ledgerPath, dependencies, environment, primitives)
      } else {
        await readValidatedLedger(ledgerPath, primitives.validateDecisionResult)
        output = await withDecisionLedger(ledgerPath, (records) => {
          const ledger = validateWritableLedger(records, primitives.validateDecisionResult)
          const observation = ledger.byId.get(input.outcome?.observationId)
          if (!observation) {
            throw new Error('orphan_record')
          }
          const row = validateIndependentOutcome(input, observation)
          validateDecisionRecordLedger([...records, row], primitives.validateDecisionResult)
          return row
        })
      }
    }
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  if (output.status === 'unavailable') {
    process.exitCode = 2
  }
  return true
}
