import type { JsonSchema } from '../../../shared/json-schema-validate'
import { createOpenRouterWorkspace } from './workflow-openrouter-workspace'

export type OllamaRequest = {
  model: string
  attemptId: string
  prompt: string
  schema?: JsonSchema
  mode: 'frozen' | 'workspace-read'
  root?: string
  maxTokens: number
  timeoutMs: number
  /** The context the model runs this call with: room for the prompt, within what it can read. */
  contextTokens: number
  /** How many tokens of file content a workspace read may bring into the conversation. */
  toolTokens: number
}

/** Expose only worker-controlled causes; server bodies and runtime errors stay opaque. */
export function ollamaWorkerFailureMessage(error: unknown): string {
  const fallback = 'Ollama request failed or returned unverifiable output.'
  try {
    if (!(error instanceof Error) || typeof error.message !== 'string') {
      return fallback
    }
    const message = error.message
    const fixedMessages = [
      'Workspace reader unavailable',
      'Ollama deadline reached',
      'Ollama returned an unverified model or error',
      'Ollama did not finish the turn',
      'Ollama ran out of room to answer: the model may be stuck thinking',
      'Ollama ran out of context for this call',
      'Ollama requested too many tools',
      'Ollama returned no final answer',
      'Ollama tool round limit reached',
      'Ollama is not running on this computer'
    ]
    if (fixedMessages.includes(message)) {
      return message
    }
    const status = /^Ollama request failed \(HTTP ([0-9]{3})\)$/.exec(message)?.[1]
    if (status && Number(status) >= 100 && Number(status) <= 599) {
      return `Ollama request failed (HTTP ${Number(status)})`
    }
    return fallback
  } catch {
    return fallback
  }
}

type WorkerDependencies = {
  /**
   * One chat request. Not `fetch`: its headers timeout ends any reply slower than five minutes,
   * and a local model answering a long prompt in one piece can take longer. Rejects with `code`
   * ECONNREFUSED when nothing listens, ETIMEDOUT when the reply does not come in time.
   */
  post: (body: string, timeoutMs: number) => Promise<{ status: number; text: string }>
  emit: (value: unknown) => void
  workspace?: ReturnType<typeof createOpenRouterWorkspace>
}

/**
 * One workflow call on a local Ollama model, over its native chat API: it alone sets the context
 * size per call (the OpenAI-compatible endpoint cuts a long prompt to the server default without
 * saying so). Ollama also drops the oldest messages, the task first, once a conversation outgrows
 * its context, and reports nothing; so what the tools bring in is counted and cut to fit. Emits
 * the same lines as the OpenRouter worker, so one parser reads both. All dependencies are explicit
 * because this function is also serialized into the child.
 */
export async function runOllamaWorker(
  request: OllamaRequest,
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
        required: name === 'search' ? ['pattern'] : ['path']
      }
    }
  }))
  const count = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
  // Two characters a token: denser than prose or code ever is, so the count errs on the safe side.
  let toolRoom = request.toolTokens
  const TOOL_CUT = '\n[Cut: this call has no more room to read files. Answer from what you have.]'
  // Some local runtimes (MLX) cannot constrain output to a schema: then the schema is asked for in
  // words and the answer's JSON is cut out of whatever fence the model puts around it.
  let plainSchema = false
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
      throw new Error('Ollama deadline reached')
    }
    let reply: { status: number; text: string }
    try {
      reply = await deps.post(
        JSON.stringify({
          model: request.model,
          messages,
          stream: false,
          options: { num_ctx: request.contextTokens, num_predict: request.maxTokens },
          ...(final && request.schema && !plainSchema ? { format: request.schema } : {}),
          ...(!final ? { tools } : {})
        }),
        remaining
      )
    } catch (cause) {
      const code = (cause as { code?: unknown } | null)?.code
      throw new Error(
        code === 'ETIMEDOUT'
          ? 'Ollama deadline reached'
          : code === 'ECONNREFUSED'
            ? 'Ollama is not running on this computer'
            : 'Ollama request failed'
      )
    }
    if (reply.status === 501 && final && request.schema && !plainSchema) {
      plainSchema = true
      messages.push({
        role: 'user',
        content: `Return only a JSON object that matches this JSON schema, with no other text:\n${JSON.stringify(request.schema)}`
      })
      continue
    }
    if (reply.status !== 200) {
      throw new Error(`Ollama request failed (HTTP ${reply.status})`)
    }
    const data = JSON.parse(reply.text) as {
      model?: string
      created_at?: string
      error?: unknown
      done?: boolean
      done_reason?: string
      prompt_eval_count?: number
      eval_count?: number
      message?: {
        content?: string
        tool_calls?: { function: { name: string; arguments: unknown } }[]
      }
    }
    if (data.error || data.model !== request.model) {
      throw new Error('Ollama returned an unverified model or error')
    }
    usage.input_tokens += count(data.prompt_eval_count)
    usage.output_tokens += count(data.eval_count)
    const message = data.message
    if (data.done === true && data.done_reason === 'length') {
      throw new Error('Ollama ran out of room to answer: the model may be stuck thinking')
    }
    if (!message || data.done !== true || (data.done_reason ?? 'stop') !== 'stop') {
      throw new Error('Ollama did not finish the turn')
    }
    // A full context means Ollama dropped part of the conversation without saying so.
    if (count(data.prompt_eval_count) + count(data.eval_count) >= request.contextTokens) {
      throw new Error('Ollama ran out of context for this call')
    }
    if (!final) {
      messages.push({ ...message, role: 'assistant' })
      if (message.tool_calls?.length) {
        if (message.tool_calls.length > 20) {
          throw new Error('Ollama requested too many tools')
        }
        for (const tool of message.tool_calls) {
          let content: string
          try {
            const args =
              typeof tool.function.arguments === 'string'
                ? JSON.parse(tool.function.arguments)
                : tool.function.arguments
            content = await deps.workspace!(tool.function.name, args)
          } catch {
            content = 'Tool refused: use a readable relative workspace path and valid arguments.'
          }
          const allowed = Math.max(0, Math.floor(toolRoom * 2) - TOOL_CUT.length)
          if (content.length > allowed) {
            content = content.slice(0, allowed) + TOOL_CUT
          }
          toolRoom -= Math.ceil(content.length / 2)
          deps.emit({ type: 'tool', name: tool.function.name })
          messages.push({ role: 'tool', tool_name: tool.function.name, content })
        }
        // The model's own turn stays in the conversation too.
        toolRoom -= count(data.eval_count)
        if (toolRoom <= 0) {
          final = true
          messages.push({
            role: 'user',
            content:
              'Now return the final answer using the requested output format. No more tools are available.'
          })
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
      !message.content.trim()
    ) {
      throw new Error('Ollama returned no final answer')
    }
    const text = message.content
    const open = text.indexOf('{')
    const close = text.lastIndexOf('}')
    deps.emit({
      type: 'result',
      model: data.model,
      requested_model: request.model,
      provider: 'ollama',
      id: `${request.attemptId}:${data.created_at ?? round}`,
      usage,
      text: plainSchema && open !== -1 && close > open ? text.slice(open, close + 1) : text
    })
    return
  }
  throw new Error('Ollama tool round limit reached')
}

/** The endpoint comes from the host (OLLAMA_HOST or the default), never from the request. */
export const OLLAMA_WORKER_SCRIPT = `
const fs = require('node:fs/promises');
const path = require('node:path');
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
// A bundler that keeps function names wraps the serialized functions' inner ones in this helper.
const __name = fn => fn;
(async () => {
  let input = '';
  // Decoded as a stream: a character split across two chunks stays one character.
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 8 * 1024 * 1024) throw new Error('Input too large'); }
  const request = JSON.parse(input);
  const base = process.env.OMNI_WORKFLOW_OLLAMA_URL || '';
  if (!/^https?:\\/\\/[^\\s/]+$/.test(base)) throw new Error('Invalid Ollama endpoint');
  const url = new URL(base + '/api/chat');
  const http = require(url.protocol === 'https:' ? 'node:https' : 'node:http');
  const fail = code => Object.assign(new Error(code), { code });
  // node:http, not fetch: fetch ends any reply slower than five minutes, and a local model may be.
  const post = (body, timeoutMs) => new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 32 * 1024 * 1024) req.destroy(fail('EMSGSIZE')); else chunks.push(chunk); });
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(fail('ETIMEDOUT')));
    req.on('error', reject);
    req.end(body);
  });
  await (${runOllamaWorker.toString()})(request, {
    post, emit,
    workspace: request.mode === 'workspace-read' && request.root ? (${createOpenRouterWorkspace.toString()})(fs, path, request.root, Date.now() + request.timeoutMs, require('node:fs').constants) : undefined
  });
})().catch(error => { emit({ type: 'error', message: (${ollamaWorkerFailureMessage.toString()})(error) }); process.exitCode = 1; });
`
