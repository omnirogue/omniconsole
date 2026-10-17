import type { AgentType } from '../../shared/agent-status-types'
import { agentArgOptionTokens } from '../../shared/agent-session-option-agent-args'

type ActorSelection = { model?: string; effort?: string }

export type SessionOutcomeSourceActorInput = {
  agent: AgentType
  launchArgs?: readonly string[]
  observedModel?: string
  options?: Readonly<Record<string, string>>
  transcriptRecords?: readonly unknown[]
}

export type SessionOutcomeSourceActor = { agent: AgentType; model: string; effort?: string }

function selectionValue(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const normalized = value.trim()
  return normalized &&
    normalized.length <= 256 &&
    !/[\s\p{Cc}]/u.test(normalized) &&
    !normalized.startsWith('-') &&
    !normalized.startsWith('<')
    ? normalized
    : undefined
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function configValue(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return selectionValue(JSON.parse(trimmed))
    } catch {
      return undefined
    }
  }
  return selectionValue(
    trimmed.startsWith("'") && trimmed.endsWith("'") ? trimmed.slice(1, -1) : trimmed
  )
}

function flagValue(token: string, aliases: readonly string[]): string | undefined {
  for (const alias of aliases) {
    if (token.startsWith(`${alias}=`)) {
      return token.slice(alias.length + 1)
    }
    if (!alias.startsWith('--') && token.startsWith(alias) && token.length > alias.length) {
      return token.slice(alias.length)
    }
  }
  return undefined
}

function launchSelection(agent: AgentType, args: readonly string[]): ActorSelection {
  const tokens = agentArgOptionTokens(args)
  const result: ActorSelection = {}
  const modelFlags = agent === 'codex' || agent === 'grok' ? ['-m', '--model'] : ['--model']
  const effortFlags = ['--effort', '--reasoning-effort']
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    const field = modelFlags.includes(token)
      ? 'model'
      : effortFlags.includes(token)
        ? 'effort'
        : undefined
    if (field) {
      const next = tokens[index + 1]
      if (next && !next.startsWith('-')) {
        result[field] = selectionValue(next)
        index += 1
      }
      continue
    }
    const model = flagValue(token, modelFlags)
    const effort = flagValue(token, effortFlags)
    if (model !== undefined || effort !== undefined) {
      if (model !== undefined) {
        result.model = selectionValue(model)
      }
      if (effort !== undefined) {
        result.effort = selectionValue(effort)
      }
      continue
    }
    if (agent !== 'codex') {
      continue
    }
    let config = flagValue(token, ['-c', '--config'])
    if (token === '-c' || token === '--config') {
      config = tokens[index + 1]
      if (config && !config.startsWith('-')) {
        index += 1
      }
    }
    const assignment = config?.match(/^\s*(model|model_reasoning_effort)\s*=\s*(.*)$/)
    if (assignment) {
      result[assignment[1] === 'model' ? 'model' : 'effort'] = configValue(assignment[2])
    }
  }
  return result
}

function transcriptSelection(
  agent: AgentType,
  records: readonly unknown[]
): ActorSelection | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = object(records[index])
    const metadata =
      agent === 'codex' && record?.type === 'turn_context'
        ? object(record.payload)
        : agent === 'claude' && record?.type === 'assistant'
          ? object(record.message)
          : undefined
    const model = selectionValue(metadata?.model)
    if (!model) {
      continue
    }
    const effort = selectionValue(
      metadata?.effort ?? metadata?.reasoning_effort ?? metadata?.model_reasoning_effort
    )
    return { model, ...(effort ? { effort } : {}) }
  }
  return undefined
}

function preferSelection(preferred: ActorSelection, fallback: ActorSelection): ActorSelection {
  const model = preferred.model ?? fallback.model
  const effort =
    preferred.effort ??
    (!fallback.model || !preferred.model || fallback.model === preferred.model
      ? fallback.effort
      : undefined)
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
}

/** The caller must bind these records to the source session before resolving its actor. */
export function resolveSessionOutcomeSourceActor(
  input: SessionOutcomeSourceActorInput
): SessionOutcomeSourceActor | null {
  const launch = launchSelection(input.agent, input.launchArgs ?? [])
  const options: ActorSelection = {
    model: selectionValue(input.options?.model),
    effort: selectionValue(
      input.options?.effort ??
        input.options?.reasoning_effort ??
        input.options?.model_reasoning_effort
    )
  }
  const explicit = preferSelection(options, launch)
  const observed = preferSelection({ model: selectionValue(input.observedModel) }, explicit)
  const selection = preferSelection(
    transcriptSelection(input.agent, input.transcriptRecords ?? []) ?? {},
    observed
  )
  return selection.model
    ? {
        agent: input.agent,
        model: selection.model,
        ...(selection.effort ? { effort: selection.effort } : {})
      }
    : null
}
