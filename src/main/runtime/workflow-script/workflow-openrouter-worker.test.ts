import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { runProcess } from '../../../shared/child-process/run-process'
import { validateJsonSchema, type JsonSchema } from '../../../shared/json-schema-validate'
import {
  OPENROUTER_WORKER_SCRIPT,
  openRouterModelMatches,
  openRouterRequestBody,
  openRouterWorkerFailureMessage,
  runOpenRouterWorker,
  type OpenRouterRequest
} from './workflow-openrouter-worker'
import { openRouterOriginalValue, openRouterStrictSchema } from './workflow-openrouter-schema'
import { parseWorkflowNativeResult } from './workflow-native-result'
import { attestNativeResult } from './local-workflow-provider-launch'

const schema: JsonSchema = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, note: { type: 'string' } },
  required: ['ok'],
  additionalProperties: false
}
const request: OpenRouterRequest = {
  model: 'deepseek/deepseek-chat-v3.1',
  attemptId: 'attempt',
  prompt: 'Return ok true',
  schema,
  mode: 'frozen',
  maxTokens: 64,
  timeoutMs: 5000
}
const response = {
  model: request.model,
  id: 'generation',
  provider: 'test',
  choices: [{ finish_reason: 'stop', message: { content: '{"ok":true,"note":null}' } }],
  usage: { prompt_tokens: 7, completion_tokens: 4, cost: 0.00001 }
}

describe('OpenRouter worker', () => {
  it('requires every property on the wire and validates the original optional contract', () => {
    const strict = openRouterStrictSchema(schema)
    expect(strict.required).toEqual(['ok', 'note'])
    expect(strict.properties?.note).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] })
    expect(schema.required).toEqual(['ok'])
    expect(
      validateJsonSchema(schema, openRouterOriginalValue(schema, { ok: true, note: null }))
    ).toEqual([])
    expect(
      validateJsonSchema(schema, openRouterOriginalValue(schema, { ok: null, note: null }))
    ).not.toEqual([])
  })
  it('builds strict requests and attributable output with usage and cost', async () => {
    const lines: unknown[] = []
    const fetcher = async (_url: unknown, init: RequestInit | undefined) => {
      const body = JSON.parse(String(init?.body))
      expect(body.provider).toEqual({ require_parameters: true })
      expect(body.response_format.json_schema.strict).toBe(true)
      expect(body.usage.include).toBe(true)
      return Response.json(response)
    }
    await runOpenRouterWorker(request, {
      fetch: fetcher as typeof fetch,
      key: 'secret',
      endpoint: 'http://test',
      emit: (line) => lines.push(line),
      strictSchema: openRouterStrictSchema,
      body: openRouterRequestBody,
      matches: openRouterModelMatches
    })
    expect(lines).toMatchObject([
      { type: 'init', session_id: 'attempt' },
      { type: 'result', usage: { input_tokens: 7, output_tokens: 4, cost: 0.00001 } }
    ])
    const parsed = parseWorkflowNativeResult(
      'openrouter',
      {
        code: 0,
        signal: null,
        stdout: lines.map((line) => JSON.stringify(line)).join('\n'),
        stderr: '',
        timedOut: false
      },
      schema,
      () => null
    )
    expect(parsed.value).toEqual({ ok: true })
    expect(parsed.resolvedModels).toEqual([request.model])
    const input = {
      route: 'openrouter',
      parsed,
      attemptId: 'attempt',
      seat: { model: request.model }
    } as Parameters<typeof attestNativeResult>[0]
    expect(() => attestNativeResult(input)).not.toThrow()
    expect(() =>
      attestNativeResult({ ...input, seat: { ...input.seat, model: 'qwen/other' } })
    ).toThrow('different session or model')
  })
  it('never attributes a variant or different model to the selected seat', () => {
    expect(openRouterModelMatches(request.model, `${request.model}-20260901`)).toBe(false)
    expect(openRouterModelMatches(request.model, 'qwen/qwen3')).toBe(false)
  })
  it('projects only fixed worker causes and valid numeric HTTP statuses', () => {
    expect(openRouterWorkerFailureMessage(new Error('OpenRouter deadline reached'))).toBe(
      'OpenRouter deadline reached'
    )
    expect(openRouterWorkerFailureMessage(new Error('OpenRouter request failed (HTTP 503)'))).toBe(
      'OpenRouter request failed (HTTP 503)'
    )
    expect(openRouterWorkerFailureMessage(new Error('OpenRouter request failed (HTTP 999)'))).toBe(
      'OpenRouter request failed or returned unverifiable output.'
    )
    expect(
      openRouterWorkerFailureMessage(
        new Error('provider response contained API_KEY=secret-token and private body')
      )
    ).toBe('OpenRouter request failed or returned unverifiable output.')
    expect(openRouterWorkerFailureMessage('OpenRouter deadline reached')).toBe(
      'OpenRouter request failed or returned unverifiable output.'
    )
  })
  it('runs the shipped -e script through a real child against a local stub', async () => {
    const server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) {
        body += chunk
      }
      expect(JSON.parse(body).model).toBe(request.model)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(response))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address() as { port: number }
      const result = await runProcess({
        program: process.execPath,
        args: ['-e', OPENROUTER_WORKER_SCRIPT],
        input: JSON.stringify(request),
        env: {
          ...process.env,
          NODE_ENV: 'test',
          ELECTRON_RUN_AS_NODE: '1',
          OPENROUTER_API_KEY: 'test-key',
          OPENROUTER_BASE_URL: `http://127.0.0.1:${address.port}`
        },
        timeoutMs: 10000,
        maxOutputBytes: 32768
      })
      expect(result.code, result.stderr + result.stdout).toBe(0)
      expect(parseWorkflowNativeResult('openrouter', result, schema, () => null).value).toEqual({
        ok: true
      })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
  it('sends a relaxed provider schema from the serialized child and keeps host validation strict', async () => {
    const patternedSchema: JsonSchema = {
      type: 'object',
      properties: {
        summary: { type: 'string', minLength: 1, pattern: '\\S' },
        code: { type: 'string', pattern: '^[A-Z]+$' }
      },
      required: ['summary', 'code'],
      additionalProperties: false
    }
    let postedSchema: JsonSchema | undefined
    const server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) {
        body += chunk
      }
      postedSchema = JSON.parse(body).response_format.json_schema.schema
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          ...response,
          choices: [
            {
              finish_reason: 'stop',
              message: { content: '{"summary":"a complete multiword response","code":"ABC"}' }
            }
          ]
        })
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address() as { port: number }
      const result = await runProcess({
        program: process.execPath,
        args: ['-e', OPENROUTER_WORKER_SCRIPT],
        input: JSON.stringify({ ...request, schema: patternedSchema }),
        env: {
          ...process.env,
          NODE_ENV: 'test',
          ELECTRON_RUN_AS_NODE: '1',
          OPENROUTER_API_KEY: 'test-key',
          OPENROUTER_BASE_URL: `http://127.0.0.1:${address.port}`
        },
        timeoutMs: 10000,
        maxOutputBytes: 32768
      })
      expect(result.code, result.stderr + result.stdout).toBe(0)
      expect(postedSchema?.properties?.summary?.pattern).toBeUndefined()
      expect(postedSchema?.properties?.code?.pattern).toBe('^[A-Z]+$')
      const parsed = parseWorkflowNativeResult('openrouter', result, patternedSchema, () => null)
      expect(parsed.value).toEqual({ summary: 'a complete multiword response', code: 'ABC' })
      const whitespaceAnswer = [
        { type: 'init', session_id: 'attempt' },
        {
          type: 'result',
          model: request.model,
          requested_model: request.model,
          id: 'generation',
          usage: {},
          text: JSON.stringify({ summary: '   ', code: 'ABC' })
        }
      ]
        .map((line) => JSON.stringify(line))
        .join('\n')
      expect(() =>
        parseWorkflowNativeResult(
          'openrouter',
          { ...result, stdout: whitespaceAnswer },
          patternedSchema,
          () => null
        )
      ).toThrow('expected to match \\S')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
  it('serializes a safe HTTP cause from the child without exposing the response body', async () => {
    const secretBody = 'provider-secret-token and raw provider diagnostic'
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) {
        void _chunk
      }
      res.statusCode = 503
      res.end(secretBody)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address() as { port: number }
      const result = await runProcess({
        program: process.execPath,
        args: ['-e', OPENROUTER_WORKER_SCRIPT],
        input: JSON.stringify(request),
        env: {
          ...process.env,
          NODE_ENV: 'test',
          ELECTRON_RUN_AS_NODE: '1',
          OPENROUTER_API_KEY: 'test-key',
          OPENROUTER_BASE_URL: `http://127.0.0.1:${address.port}`
        },
        timeoutMs: 10000,
        maxOutputBytes: 32768
      })
      expect(result.code).toBe(1)
      expect(result.stdout).toContain('OpenRouter request failed (HTTP 503)')
      expect(result.stdout).not.toContain(secretBody)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
  it('uses tools before requesting final schema and totals every turn', async () => {
    let calls = 0
    const lines: unknown[] = []
    await runOpenRouterWorker(
      { ...request, mode: 'workspace-read' },
      {
        fetch: (async (_url: unknown, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body))
          calls++
          if (calls === 1) {
            expect(body.response_format).toBeUndefined()
            expect(body.tools).toHaveLength(3)
            return Response.json({
              ...response,
              choices: [
                {
                  finish_reason: 'tool_calls',
                  message: {
                    tool_calls: [
                      {
                        id: 'tool-1',
                        function: { name: 'read_file', arguments: '{"path":"README.md"}' }
                      }
                    ]
                  }
                }
              ]
            })
          }
          if (calls === 2) {
            expect(body.messages.at(-1).content).toBe('file evidence')
          }
          if (calls === 3) {
            expect(body.tools).toBeUndefined()
            expect(body.response_format).toBeDefined()
          }
          return Response.json(response)
        }) as typeof fetch,
        key: 'secret',
        endpoint: 'test',
        emit: (line) => lines.push(line),
        strictSchema: openRouterStrictSchema,
        body: openRouterRequestBody,
        matches: openRouterModelMatches,
        workspace: async () => 'file evidence'
      }
    )
    expect(calls).toBe(3)
    expect(lines.at(-1)).toMatchObject({ usage: { input_tokens: 21, output_tokens: 12 } })
  })
})
