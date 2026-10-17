import { createHash } from 'node:crypto'
import {
  describeJsonSchemaProblems,
  unusableAgentSchemaReason,
  validateJsonSchema,
  type JsonSchema
} from '../../../shared/json-schema-validate'
import type {
  WorkflowScriptAgentCall,
  WorkflowScriptAgentRecord,
  WorkflowScriptEvent
} from '../../../shared/workflow-script-types'
import type { WorkflowScriptJournal } from './workflow-script-journal'
import { WorkflowScriptError } from './workflow-script-sandbox'
import type { WorkflowScriptSlots } from './workflow-script-slots'

const PROMPT_PREVIEW_CHARS = 120
/** How often an answer that fails its schema is asked for again before the call gives up. */
const SCHEMA_ATTEMPTS = 3

export type WorkflowScriptAgentAnswer = { value: unknown; tokens?: number }

/**
 * Runs one `agent()` call for real. `problems` names why the previous attempt's answer
 * failed its schema, so the agent can be asked again with the defects in hand. `null`
 * means the agent died and the script sees `null` for that call.
 */
export type WorkflowScriptExecutor = (
  call: WorkflowScriptAgentCall,
  context: { attempt: number; problems: string | null; signal: AbortSignal }
) => Promise<WorkflowScriptAgentAnswer | null>

export type WorkflowScriptAgentCallContext = {
  guard: () => void
  abort: (reason: string) => void
  agents: WorkflowScriptAgentRecord[]
  phases: readonly string[]
  occurrences: Map<string, number>
  currentPhase: () => string | null
  budget: { total: number | null; spent: () => number }
  maxAgents: number
  journal: WorkflowScriptJournal | undefined
  execute: WorkflowScriptExecutor
  tokensPerAgent: number
  slots: WorkflowScriptSlots
  signal: AbortSignal
  clock: () => number
  record: (agent: WorkflowScriptAgentRecord, patch: Partial<WorkflowScriptAgentRecord>) => void
  emit: (event: WorkflowScriptEvent) => void
  charge: (tokens: number) => void
  cachedHit: () => void
}

function optionText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** The call's content, hashed: an unchanged call on a re-run meets its journaled answer. */
export function workflowScriptCallDigest(
  call: Omit<WorkflowScriptAgentCall, 'index' | 'key'>
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        call.prompt,
        call.schema,
        call.model,
        call.effort,
        call.isolation,
        call.agentType
      ])
    )
    .digest('hex')
}

export async function runWorkflowScriptAgentCall(
  prompt: unknown,
  opts: Record<string, unknown>,
  ctx: WorkflowScriptAgentCallContext
): Promise<unknown> {
  ctx.guard()
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new WorkflowScriptError('agent() called with an empty prompt')
  }
  if (ctx.budget.total != null && ctx.budget.spent() >= ctx.budget.total) {
    throw new WorkflowScriptError('token budget exhausted')
  }
  if (ctx.agents.length >= ctx.maxAgents) {
    ctx.abort(`runaway fan-out: more than ${ctx.maxAgents} agents`)
    throw ctx.signal.reason
  }
  const schemaReason = opts.schema === undefined ? null : unusableAgentSchemaReason(opts.schema)
  if (schemaReason) {
    throw new WorkflowScriptError(`agent() schema is unusable: ${schemaReason}`)
  }
  const schema = (opts.schema as JsonSchema | undefined) ?? null
  const phaseTitle = optionText(opts.phase) ?? ctx.currentPhase()
  const base = {
    prompt,
    label: optionText(opts.label) ?? `agent ${ctx.agents.length + 1}`,
    phaseTitle,
    schema,
    model: optionText(opts.model),
    effort: optionText(opts.effort),
    isolation: opts.isolation === 'worktree' ? ('worktree' as const) : null,
    agentType: optionText(opts.agentType)
  }
  const digest = workflowScriptCallDigest(base)
  const occurrence = (ctx.occurrences.get(digest) ?? 0) + 1
  ctx.occurrences.set(digest, occurrence)
  const call: WorkflowScriptAgentCall = {
    ...base,
    index: ctx.agents.length + 1,
    key: `v1:${digest}:${occurrence}`
  }
  const phaseIndex = phaseTitle === null ? -1 : ctx.phases.indexOf(phaseTitle)
  const entry: WorkflowScriptAgentRecord = {
    index: call.index,
    key: call.key,
    label: call.label,
    phaseTitle,
    phaseIndex: phaseIndex === -1 ? null : phaseIndex + 1,
    model: call.model,
    effort: call.effort,
    isolation: call.isolation,
    schema: schema !== null,
    state: 'queued',
    cached: false,
    attempt: 0,
    promptPreview: prompt.trim().slice(0, PROMPT_PREVIEW_CHARS),
    tokens: 0,
    startedAt: null,
    endedAt: null,
    error: null
  }
  ctx.agents.push(entry)
  ctx.emit({ type: 'agent', agent: { ...entry } })
  const journaled = await ctx.journal?.get(call.key)
  if (journaled) {
    ctx.cachedHit()
    ctx.record(entry, { state: 'done', cached: true, startedAt: ctx.clock(), endedAt: ctx.clock() })
    return journaled.value
  }
  return ctx.slots.run(async () => {
    ctx.guard()
    ctx.record(entry, { state: 'running', startedAt: ctx.clock(), attempt: 1 })
    let problems: string | null = null
    for (let attempt = 1; attempt <= (schema ? SCHEMA_ATTEMPTS : 1); attempt += 1) {
      if (attempt > 1) {
        ctx.record(entry, { attempt })
      }
      let answer: WorkflowScriptAgentAnswer | null
      try {
        answer = await ctx.execute(call, { attempt, problems, signal: ctx.signal })
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        ctx.record(entry, { state: 'failed', endedAt: ctx.clock(), error: message })
        return null
      }
      const tokens = answer?.tokens ?? ctx.tokensPerAgent
      ctx.charge(tokens)
      entry.tokens += tokens
      if (answer === null) {
        ctx.record(entry, { state: 'failed', endedAt: ctx.clock(), error: 'agent did not answer' })
        return null
      }
      const defects = schema ? validateJsonSchema(schema, answer.value) : []
      if (defects.length === 0) {
        await ctx.journal?.put(call.key, answer.value)
        ctx.record(entry, { state: 'done', endedAt: ctx.clock() })
        return answer.value
      }
      problems = describeJsonSchemaProblems(defects)
    }
    ctx.record(entry, {
      state: 'failed',
      endedAt: ctx.clock(),
      error: `answer never matched its schema: ${problems}`
    })
    return null
  })
}
