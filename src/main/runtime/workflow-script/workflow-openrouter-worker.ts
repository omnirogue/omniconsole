import type { JsonSchema } from '../../../shared/json-schema-validate'
import { workflowStrictSchema } from './workflow-strict-schema'
import { createOpenRouterWorkspace } from './workflow-openrouter-workspace'

export type OpenRouterRequest = {
  model: string
  attemptId: string
  prompt: string
  schema?: JsonSchema
  mode: 'frozen' | 'workspace-read'
  root?: string
  maxTokens: number
  timeoutMs: number
}

export function openRouterRequestBody(
  request: OpenRouterRequest,
  messages: unknown[],
  schema?: JsonSchema
) {
  return {
    model: request.model,
    messages,
    max_tokens: request.maxTokens,
    provider: { require_parameters: true },
    usage: { include: true },
    ...(schema
      ? {
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'result', schema, strict: true }
          }
        }
      : {})
  }
}

/** No arbitrary suffix stripping: a different model must not inherit the requested identity. */
export function openRouterModelMatches(requested: string, returned: string): boolean {
  return requested === returned
}

/** Expose only worker-controlled causes; provider bodies and runtime errors stay opaque. */
export function openRouterWorkerFailureMessage(error: unknown): string {
  const fallback = 'OpenRouter request failed or returned unverifiable output.'
  try {
    if (!(error instanceof Error) || typeof error.message !== 'string') {
      return fallback
    }
    const message = error.message
    const fixedMessages = [
      'Workspace reader unavailable',
      'OpenRouter deadline reached',
      'OpenRouter returned an unverified model or error',
      'OpenRouter did not finish the turn',
      'OpenRouter requested too many tools',
      'OpenRouter returned no final answer',
      'OpenRouter tool round limit reached'
    ]
    if (fixedMessages.includes(message)) {
      return message
    }
    const status = /^OpenRouter request failed \(HTTP ([0-9]{3})\)$/.exec(message)?.[1]
    if (status && Number(status) >= 100 && Number(status) <= 599) {
      return `OpenRouter request failed (HTTP ${Number(status)})`
    }
    return fallback
  } catch {
    return fallback
  }
}

type WorkerDependencies = {
  fetch: typeof fetch
  key: string
  endpoint: string
  emit: (value: unknown) => void
  strictSchema: typeof workflowStrictSchema
  body: typeof openRouterRequestBody
  matches: typeof openRouterModelMatches
  workspace?: ReturnType<typeof createOpenRouterWorkspace>
}

/** All dependencies are explicit because this function is also serialized into the child. */
export async function runOpenRouterWorker(
  request: OpenRouterRequest,
  deps: WorkerDependencies
): Promise<void> {
  const deadline = Date.now() + request.timeoutMs
  const messages: unknown[] = [{ role: 'user', content: request.prompt }]
  const usage = { input_tokens: 0, output_tokens: 0, cost: 0 }
  const tools = ['list_directory', 'read_file', 'search'].map((name) => ({
    type: 'function',
    function: {
      name,
      description:
        name === 'search'
          ? 'Search files for a literal substring, within the workspace.'
          : `${name} within the workspace. Paths must be relative.`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          ...(name === 'search' ? { pattern: { type: 'string' } } : {}),
          ...(name === 'read_file'
            ? { start_line: { type: 'integer' }, end_line: { type: 'integer' } }
            : {})
        },
        required: name === 'search' ? ['pattern'] : ['path'],
        additionalProperties: false
      }
    }
  }))
  deps.emit({ type: 'init', session_id: request.attemptId })
  let final = request.mode !== 'workspace-read'
  if (!final && !deps.workspace) {
    throw new Error('Workspace reader unavailable')
  }
  for (let round = 0; round <= 40; round++) {
    if (round === 40) {
      final = true
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new Error('OpenRouter deadline reached')
    }
    const body = deps.body(
      request,
      messages,
      final && request.schema ? deps.strictSchema(request.schema, true) : undefined
    )
    const response = await deps.fetch(deps.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${deps.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, ...(!final ? { tools, tool_choice: 'auto' } : {}) }),
      signal: AbortSignal.timeout(remaining)
    })
    if (!response.ok) {
      throw new Error(`OpenRouter request failed (HTTP ${response.status})`)
    }
    const data = (await response.json()) as {
      model?: string
      id?: string
      provider?: string
      error?: unknown
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }
      choices?: {
        finish_reason?: string
        message?: {
          content?: string
          tool_calls?: { id: string; function: { name: string; arguments: string } }[]
        }
      }[]
    }
    if (data.error || !data.model || !deps.matches(request.model, data.model)) {
      throw new Error('OpenRouter returned an unverified model or error')
    }
    const count = (value: unknown) =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
    usage.input_tokens += count(data.usage?.prompt_tokens)
    usage.output_tokens += count(data.usage?.completion_tokens)
    usage.cost += count(data.usage?.cost)
    const choice = data.choices?.[0]
    const message = choice?.message
    if (!message || !['stop', 'tool_calls'].includes(choice?.finish_reason ?? '')) {
      throw new Error('OpenRouter did not finish the turn')
    }
    if (!final) {
      messages.push({ ...message, role: 'assistant' })
      if (message.tool_calls?.length) {
        if (message.tool_calls.length > 20) {
          throw new Error('OpenRouter requested too many tools')
        }
        for (const tool of message.tool_calls) {
          let content: string
          try {
            content = await deps.workspace!(tool.function.name, JSON.parse(tool.function.arguments))
          } catch {
            content = 'Tool refused: use a readable relative workspace path and valid arguments.'
          }
          deps.emit({ type: 'tool', name: tool.function.name })
          messages.push({ role: 'tool', tool_call_id: tool.id, content })
        }
      } else {
        final = true
        messages.push({
          role: 'user',
          content:
            'Now return the final answer using the requested output format. No more tools are available.'
        })
      }
      continue
    }
    if (
      message.tool_calls?.length ||
      typeof message.content !== 'string' ||
      !message.content.trim() ||
      !data.id
    ) {
      throw new Error('OpenRouter returned no final answer')
    }
    deps.emit({
      type: 'result',
      model: data.model,
      requested_model: request.model,
      provider: data.provider,
      id: data.id,
      usage,
      text: message.content
    })
    return
  }
  throw new Error('OpenRouter tool round limit reached')
}

export const OPENROUTER_WORKER_SCRIPT = `
const fs = require('node:fs/promises');
const path = require('node:path');
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
(async () => {
  let input = '';
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 8 * 1024 * 1024) throw new Error('Input too large'); }
  const request = JSON.parse(input);
  const base = process.env.NODE_ENV === 'test' && process.env.OPENROUTER_BASE_URL;
  if (base && !/^http:\\/\\/(127\\.0\\.0\\.1|localhost):\\d+$/.test(base)) throw new Error('Invalid test endpoint');
  await (${runOpenRouterWorker.toString()})(request, {
    fetch, key: process.env.OPENROUTER_API_KEY,
    endpoint: base ? base + '/api/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions', emit,
    strictSchema: ${workflowStrictSchema.toString()}, body: ${openRouterRequestBody.toString()}, matches: ${openRouterModelMatches.toString()},
    workspace: request.mode === 'workspace-read' && request.root ? (${createOpenRouterWorkspace.toString()})(fs, path, request.root, Date.now() + request.timeoutMs, require('node:fs').constants) : undefined
  });
})().catch(error => { emit({ type: 'error', message: (${openRouterWorkerFailureMessage.toString()})(error) }); process.exitCode = 1; });
`
