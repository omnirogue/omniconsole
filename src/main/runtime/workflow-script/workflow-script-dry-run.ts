import type { JsonSchema } from '../../../shared/json-schema-validate'
import type {
  WorkflowScriptDryRunInput,
  WorkflowScriptRunSnapshot
} from '../../../shared/workflow-script-types'
import { runWorkflowScript, type WorkflowScriptExecutor } from './workflow-script-runtime'

const DRY_RUN_TIMEOUT_MS = 8_000
const DRY_RUN_TOKENS_PER_AGENT = 9_000

/**
 * A deterministic stand-in for an answer with the requested shape. `n` sets how many
 * elements array-valued fields carry, which is what makes data-driven fan-out (one
 * verifier per finding, loop-until-dry) respond to the world the script is shown.
 */
export function syntheticAnswer(
  schema: JsonSchema | null,
  n: number,
  seed = 0,
  depth = 0
): unknown {
  if (!schema || typeof schema !== 'object' || depth > 6) {
    return `synthetic-${seed}`
  }
  if (Array.isArray(schema.enum) && schema.enum.length) {
    return schema.enum[seed % schema.enum.length]
  }
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type
  switch (type) {
    case 'array': {
      const count = Math.max(schema.minItems ?? 0, Math.min(n, schema.maxItems ?? n))
      return Array.from({ length: count }, (_, index) =>
        syntheticAnswer(schema.items ?? { type: 'string' }, n, seed + index + 1, depth + 1)
      )
    }
    case 'object': {
      const out: Record<string, unknown> = {}
      let offset = 0
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        offset += 1
        out[key] = syntheticAnswer(child, n, seed + offset, depth + 1)
      }
      return out
    }
    case 'integer':
    case 'number':
      return Math.max(
        schema.minimum ?? -Infinity,
        Math.min(schema.maximum ?? Infinity, (seed % 7) + 1)
      )
    case 'boolean':
      // Why alternate: a verify or judge stage that gates on a boolean must survive both branches.
      return seed % 3 !== 0
    case 'null':
      return null
    case undefined:
      return `synthetic-value-${seed}`
    default:
      return `synthetic-${type}-${seed}`
  }
}

export function syntheticExecutor(richness: number): WorkflowScriptExecutor {
  return async (call) => ({
    value: call.schema
      ? syntheticAnswer(call.schema, richness, call.index)
      : `result of agent #${call.index}`,
    tokens: DRY_RUN_TOKENS_PER_AGENT + Math.ceil(call.prompt.length / 4)
  })
}

/**
 * Executes the script — not merely parses it — against a synthetic world, so the shape
 * it would run (phases, fan-out, models, labels) is known before any agent starts. No
 * agent runs, nothing is journaled, and the clock is the host's for duration only.
 */
export function dryRunWorkflowScript(
  input: WorkflowScriptDryRunInput
): Promise<WorkflowScriptRunSnapshot> {
  return runWorkflowScript({
    source: input.source,
    args: input.args,
    budgetTotal: input.budgetTotal ?? null,
    execute: syntheticExecutor(Math.max(0, Math.floor(input.richness ?? 3))),
    maxConcurrent: 64,
    maxAgents: 400,
    timeoutMs: DRY_RUN_TIMEOUT_MS
  })
}
