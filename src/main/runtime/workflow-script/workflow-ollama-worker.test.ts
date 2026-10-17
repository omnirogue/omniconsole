import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { runProcess } from '../../../shared/child-process/run-process'
import type { JsonSchema } from '../../../shared/json-schema-validate'
import { attestNativeResult } from './local-workflow-provider-launch'
import { parseWorkflowNativeResult } from './workflow-native-result'
import { workflowOllamaCallContext } from './workflow-ollama-catalog'
import {
  OLLAMA_WORKER_SCRIPT,
  ollamaWorkerFailureMessage,
  runOllamaWorker,
  type OllamaRequest
} from './workflow-ollama-worker'

const schema: JsonSchema = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, note: { type: 'string' } },
  required: ['ok'],
  additionalProperties: false
}
const request: OllamaRequest = {
  model: 'qwen3:8b',
  attemptId: 'attempt',
  prompt: 'Return ok true',
  schema,
  mode: 'frozen',
  maxTokens: 64,
  timeoutMs: 5000,
  contextTokens: 8192,
  toolTokens: 0
}
const answer = {
  model: request.model,
  created_at: '2026-10-04T12:00:00Z',
  message: { role: 'assistant', content: '{"ok":true}' },
  done: true,
  done_reason: 'stop',
  prompt_eval_count: 7,
  eval_count: 4
}
const receipt = (lines: unknown[]) => ({
  code: 0,
  signal: null,
  stdout: lines.map((line) => JSON.stringify(line)).join('\n'),
  stderr: '',
  timedOut: false
})
const replying = (reply: unknown) => async () => ({ status: 200, text: JSON.stringify(reply) })

describe('Ollama worker', () => {
  it('asks the native chat API with the context for this call and the schema as given', async () => {
    const lines: unknown[] = []
    await runOllamaWorker(request, {
      post: async (text, timeoutMs) => {
        const body = JSON.parse(text)
        expect(body).toMatchObject({
          model: 'qwen3:8b',
          stream: false,
          options: { num_ctx: 8192, num_predict: 64 },
          format: schema
        })
        expect(body.tools).toBeUndefined()
        expect(timeoutMs).toBeLessThanOrEqual(5000)
        return { status: 200, text: JSON.stringify(answer) }
      },
      emit: (line) => lines.push(line)
    })
    expect(lines).toMatchObject([
      { type: 'init', session_id: 'attempt' },
      { type: 'result', provider: 'ollama', usage: { input_tokens: 7, output_tokens: 4, cost: 0 } }
    ])
    const parsed = parseWorkflowNativeResult('ollama', receipt(lines), schema, () => null)
    // The original schema went on the wire, so an optional field may simply be absent.
    expect(parsed.value).toEqual({ ok: true })
    expect(parsed.resolvedModels).toEqual(['qwen3:8b'])
    const input = {
      route: 'ollama',
      parsed,
      attemptId: 'attempt',
      seat: { model: 'qwen3:8b' }
    } as Parameters<typeof attestNativeResult>[0]
    expect(() => attestNativeResult(input)).not.toThrow()
    expect(() =>
      attestNativeResult({ ...input, seat: { ...input.seat, model: 'qwen3:30b' } })
    ).toThrow('different session or model')
  })

  const toolCall = (path: string) => ({
    ...answer,
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'read_file', arguments: { path } } }]
    }
  })
  async function read(toolTokens: number, replies: unknown[], fileChars = 20) {
    const lines: Record<string, unknown>[] = []
    const bodies: { tools?: unknown; format?: unknown; messages: { content?: string }[] }[] = []
    await runOllamaWorker(
      { ...request, mode: 'workspace-read', root: '/repo', toolTokens },
      {
        post: async (text) => {
          bodies.push(JSON.parse(text))
          return { status: 200, text: JSON.stringify(replies[bodies.length - 1]) }
        },
        emit: (line) => lines.push(line as Record<string, unknown>),
        workspace: async (_name, args) => `${args.path}:`.padEnd(fileChars, 'x')
      }
    )
    return { lines, bodies }
  }

  it('reads the workspace through tools, then asks for the final answer without them', async () => {
    const { lines, bodies } = await read(1_000, [
      toolCall('a.ts'),
      { ...answer, message: { role: 'assistant', content: 'I have what I need.' } },
      answer
    ])
    expect(bodies.map((body) => [!!body.tools, !!body.format])).toEqual([
      [true, false],
      [true, false],
      [false, true]
    ])
    expect(bodies[1].messages.at(-1)).toEqual({
      role: 'tool',
      tool_name: 'read_file',
      content: 'a.ts:xxxxxxxxxxxxxxx'
    })
    expect(lines.map((line) => line.type)).toEqual(['init', 'tool', 'result'])
    expect(lines.at(-1)?.usage).toMatchObject({ input_tokens: 21, output_tokens: 12 })
  })

  it('cuts what the tools bring in to the room this call has, then asks for the answer', async () => {
    // 300 tokens of room is 600 characters; the file is 5,000. Ollama would otherwise drop the
    // oldest message (the task itself) to make room and say nothing.
    const { bodies } = await read(300, [toolCall('big.ts'), answer], 5_000)
    expect(bodies).toHaveLength(2)
    const result = bodies[1].messages.at(-2)!.content!
    expect(result.length).toBeLessThanOrEqual(600)
    expect(result).toMatch(/^big\.ts:x+\n\[Cut: this call has no more room to read files/)
    expect(bodies[1].messages.at(-1)).toMatchObject({ role: 'user' })
    expect([!!bodies[1].tools, !!bodies[1].format]).toEqual([false, true])
    // The first message is still the task: nothing was left for Ollama to drop.
    expect(bodies[1].messages[0]).toEqual({ role: 'user', content: 'Return ok true' })
  })

  it('refuses another model, a cut-off answer and a full context', async () => {
    const run = (reply: unknown) =>
      runOllamaWorker(request, { post: replying(reply), emit: () => undefined })
    await expect(run({ ...answer, model: 'qwen3:30b' })).rejects.toThrow('unverified model')
    await expect(run({ ...answer, done_reason: 'length' })).rejects.toThrow(
      'ran out of room to answer: the model may be stuck thinking'
    )
    await expect(run({ ...answer, done: false })).rejects.toThrow('did not finish')
    await expect(run({ ...answer, prompt_eval_count: 8190 })).rejects.toThrow('ran out of context')
    await expect(run({ ...answer, message: { content: '  ' } })).rejects.toThrow('no final answer')
  })

  it('asks for the schema in words when the runtime cannot constrain output, and unwraps the fence', async () => {
    const bodies: { format?: unknown; messages: { role: string; content: string }[] }[] = []
    const lines: Record<string, unknown>[] = []
    await runOllamaWorker(request, {
      post: async (text) => {
        bodies.push(JSON.parse(text))
        return bodies.length === 1
          ? { status: 501, text: '{"error":"structured output is unavailable"}' }
          : {
              status: 200,
              text: JSON.stringify({
                ...answer,
                message: { role: 'assistant', content: '```json\n{"ok": true}\n```' }
              })
            }
      },
      emit: (line) => lines.push(line as Record<string, unknown>)
    })
    expect(bodies.map((body) => !!body.format)).toEqual([true, false])
    expect(bodies[1].messages.at(-1)?.content).toContain('matches this JSON schema')
    expect(lines.at(-1)?.text).toBe('{"ok": true}')
    expect(parseWorkflowNativeResult('ollama', receipt(lines), schema, () => null).value).toEqual({
      ok: true
    })
  })

  it('tells a server that is not there from one that is slow or broken', async () => {
    const failing = (code: string | undefined, status = 200) =>
      runOllamaWorker(request, {
        post: async () => {
          if (code) {
            throw Object.assign(new Error('socket'), { code })
          }
          return { status, text: '{}' }
        },
        emit: () => undefined
      })
    await expect(failing('ECONNREFUSED')).rejects.toThrow('Ollama is not running on this computer')
    await expect(failing('ETIMEDOUT')).rejects.toThrow('Ollama deadline reached')
    await expect(failing('ECONNRESET')).rejects.toThrow('Ollama request failed')
    await expect(failing(undefined, 404)).rejects.toThrow('Ollama request failed (HTTP 404)')
  })

  it('projects only fixed worker causes', () => {
    expect(ollamaWorkerFailureMessage(new Error('Ollama deadline reached'))).toBe(
      'Ollama deadline reached'
    )
    expect(ollamaWorkerFailureMessage(new Error('Ollama request failed (HTTP 404)'))).toBe(
      'Ollama request failed (HTTP 404)'
    )
    expect(ollamaWorkerFailureMessage(new Error('private body of /Users/someone'))).toBe(
      'Ollama request failed or returned unverifiable output.'
    )
  })

  it('runs the shipped -e script through a real child against a local stub', async () => {
    const seen: string[] = []
    const server = createServer(async (req, res) => {
      let body = ''
      req.setEncoding('utf8')
      for await (const chunk of req) {
        body += chunk
      }
      expect(req.url).toBe('/api/chat')
      const parsed = JSON.parse(body)
      expect(parsed.options.num_ctx).toBe(8192)
      seen.push(parsed.messages[0].content)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(answer))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    const env = { PATH: process.env.PATH ?? '', ELECTRON_RUN_AS_NODE: '1' }
    const run = (base: string, prompt = request.prompt) =>
      runProcess({
        program: process.execPath,
        args: ['-e', OLLAMA_WORKER_SCRIPT],
        input: JSON.stringify({ ...request, prompt }),
        env: { ...env, OMNI_WORKFLOW_OLLAMA_URL: base },
        timeoutMs: 10_000,
        maxOutputBytes: 64_000
      })
    try {
      const result = await run(`http://127.0.0.1:${port}`)
      expect(result.code).toBe(0)
      expect(parseWorkflowNativeResult('ollama', result, schema, () => null).value).toEqual({
        ok: true
      })
      // A long prompt of multi-byte characters arrives whole, whatever the pipe's chunking.
      const long = 'é漢🙂'.repeat(60_000)
      expect((await run(`http://127.0.0.1:${port}`, long)).code).toBe(0)
      expect(seen.at(-1)).toBe(long)
      const refused = await run(`http://127.0.0.1:${port}/v1`)
      expect(refused.code).toBe(1)
      expect(refused.stdout).toContain('Ollama request failed or returned unverifiable output.')
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
    // Nothing listens there any more.
    const gone = await run(`http://127.0.0.1:${port}`)
    expect(gone.code).toBe(1)
    expect(gone.stdout).toContain('Ollama is not running on this computer')
  })
})

describe('Ollama context for one call', () => {
  const size = (promptChars: number, limit?: number, workspaceRead = false) =>
    workflowOllamaCallContext({
      model: 'qwen3:8b',
      promptChars,
      workspaceRead,
      ...(limit ? { limit } : {})
    })
  it('takes the smallest step that holds the prompt, the answer and what a read brings in', () => {
    expect(size(3_000)).toEqual({ contextTokens: 16_384, maxTokens: 8_192, toolTokens: 0 })
    expect(size(150_000).contextTokens).toBe(65_536)
    expect(size(60_000, 40_960).contextTokens).toBe(32_768)
    expect(size(3_000, undefined, true)).toEqual({
      contextTokens: 65_536,
      maxTokens: 8_192,
      toolTokens: 24_000
    })
  })
  it('gives a smaller model what fits: a shorter answer and less to read', () => {
    // qwen3:8b reads 40,960: a workspace read fits whole, and a longer prompt reads less.
    expect(size(200, 40_960, true)).toEqual({
      contextTokens: 40_960,
      maxTokens: 8_192,
      toolTokens: 24_000
    })
    expect(size(30_000, 40_960, true)).toEqual({
      contextTokens: 40_960,
      maxTokens: 8_192,
      toolTokens: 21_744
    })
    expect(size(200, 8_192)).toEqual({ contextTokens: 8_192, maxTokens: 7_101, toolTokens: 0 })
    expect(size(200, 8_192, true)).toEqual({
      contextTokens: 8_192,
      maxTokens: 2_367,
      toolTokens: 4_734
    })
  })
  it('refuses a prompt the model cannot read whole, by name', () => {
    expect(() => size(150_000, 40_960)).toThrow(
      'Ollama: this call needs about 52,048 tokens of context and qwen3:8b reads 40,960.'
    )
    expect(size(100_000, 40_960).maxTokens).toBe(6_602)
    expect(() => size(0, 4_096, true)).toThrow('qwen3:8b reads 4,096')
    expect(() => size(0, 8_192, true)).not.toThrow()
  })
})
