import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import { AGENT_HOOK_PROMPT_REPLY_MAX_BYTES } from '../../shared/agent-hook-prompt-reply-limit'
import { getManagedScript } from './gemini-managed-hook-script'

const TOKEN = 'synthetic-gemini-hook-token'
const PROMPT = 'When done, hand off the café 日本語 😀 files to Uma.'
const REPLY = JSON.stringify({
  hookSpecificOutput: { hookEventName: 'BeforeAgent', additionalContext: 'Save café 日本語 😀' }
})

describe.skipIf(process.platform === 'win32')('Gemini managed hook stdout contract', () => {
  const servers: Server[] = []
  const directories: string[] = []

  function directory(): string {
    const path = mkdtempSync(join(tmpdir(), 'omni-gemini-reply-'))
    directories.push(path)
    return path
  }

  async function listen(reply: string | null, status = reply === null ? 204 : 200) {
    const posts: { body: string; headers: IncomingHttpHeaders; url: string | undefined }[] = []
    const server = createServer((req, res) => {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => {
        body += chunk
      })
      req.on('end', () => {
        posts.push({ body, headers: req.headers, url: req.url })
        res.writeHead(status, { 'Content-Type': 'application/json' }).end(reply ?? '')
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Missing loopback listener address')
    }
    return { port: address.port, posts }
  }

  async function runHook(port: number, input: string, env: NodeJS.ProcessEnv = {}) {
    const home = directory()
    const script = join(home, 'gemini-hook.sh')
    writeFileSync(script, getManagedScript('posix'))
    return runProcess({
      program: '/bin/sh',
      args: [script],
      input,
      timeoutMs: 10_000,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        ORCA_AGENT_HOOK_PORT: String(port),
        ORCA_AGENT_HOOK_TOKEN: TOKEN,
        ORCA_AGENT_HOOK_TRANSPORT: 'raw-json-v1',
        ORCA_PANE_KEY: 'tab-reply:11111111-1111-4111-8111-111111111111',
        ORCA_TAB_ID: 'tab-reply',
        ORCA_AGENT_LAUNCH_TOKEN: 'launch-reply',
        ORCA_WORKTREE_ID: 'workspace café 日本語 😀',
        ORCA_AGENT_HOOK_ENV: 'production',
        ORCA_AGENT_HOOK_VERSION: '1',
        ...env
      }
    })
  }

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()))
          })
      )
    )
    for (const path of directories.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  it.each([
    ['raw-json-v1', undefined],
    ['form', 2]
  ] as const)('delivers UTF-8 %s input and one JSON context reply', async (transport, indent) => {
    const listener = await listen(REPLY)
    const payload = JSON.stringify({ hook_event_name: 'BeforeAgent', prompt: PROMPT }, null, indent)
    const result = await runHook(listener.port, payload, { ORCA_AGENT_HOOK_TRANSPORT: transport })
    expect(result).toMatchObject({ code: 0, stderr: '', timedOut: false })
    expect(JSON.parse(result.stdout)).toEqual(JSON.parse(REPLY))
    expect(listener.posts).toHaveLength(1)
    const post = listener.posts[0]
    expect(post.url).toBe('/hook/gemini')
    expect(post.headers['x-orca-agent-hook-token']).toBe(TOKEN)
    expect(post.headers['x-omni-agent-hook-token']).toBe(TOKEN)
    if (transport === 'raw-json-v1') {
      expect(post.body).toBe(payload)
      const metadata = Buffer.from(post.headers['x-orca-agent-hook-meta'] as string, 'base64')
        .toString('utf8')
        .split('\x1f')
      expect(metadata[3]).toBe('workspace café 日本語 😀')
    } else {
      const form = new URLSearchParams(post.body)
      expect(form.get('payload')).toBe(payload)
      expect(form.get('worktreeId')).toBe('workspace café 日本語 😀')
      expect(form.get('launchToken')).toBe('launch-reply')
    }
  })

  it.each([null, '', '{broken', '[]', 'null', 'unavailable', '{"error":"old listener"}'])(
    'keeps a prompt running with neutral JSON for reply %j',
    async (reply) => {
      const listener = await listen(reply)
      const result = await runHook(
        listener.port,
        JSON.stringify({ hook_event_name: 'BeforeAgent', prompt: PROMPT })
      )
      expect(result).toMatchObject({ code: 0, stderr: '', stdout: '{}\n', timedOut: false })
    }
  )

  it.each(['AfterAgent', 'BeforeTool', 'AfterTool'])(
    'does not inject a reply on %s even when a listener returns context',
    async (event) => {
      const listener = await listen(REPLY)
      const result = await runHook(
        listener.port,
        JSON.stringify({ hook_event_name: event, prompt: PROMPT })
      )
      expect(result).toMatchObject({ code: 0, stderr: '', stdout: '{}\n', timedOut: false })
      expect(listener.posts).toHaveLength(1)
    }
  )

  it('discards a failed HTTP response and an oversized context', async () => {
    for (const [reply, status] of [
      [REPLY, 403],
      [REPLY.replace('Save', 'x'.repeat(AGENT_HOOK_PROMPT_REPLY_MAX_BYTES)), 200]
    ] as const) {
      const listener = await listen(reply, status)
      const result = await runHook(
        listener.port,
        JSON.stringify({ hook_event_name: 'BeforeAgent', prompt: PROMPT })
      )
      expect(result).toMatchObject({ code: 0, stderr: '', stdout: '{}\n', timedOut: false })
    }
  })

  it.each([
    { ORCA_AGENT_HOOK_PORT: '' },
    { ORCA_AGENT_HOOK_TOKEN: '' },
    { ORCA_PANE_KEY: '' },
    { PATH: '' }
  ])('returns one neutral object when hook context or tools are unavailable: %j', async (env) => {
    const listener = await listen(REPLY)
    const result = await runHook(
      listener.port,
      JSON.stringify({ hook_event_name: 'BeforeAgent', prompt: PROMPT }),
      env
    )
    expect(result).toMatchObject({ code: 0, stderr: '', stdout: '{}\n', timedOut: false })
    expect(listener.posts).toHaveLength(0)
  })

  it('returns one neutral object for empty input', async () => {
    const result = await runHook(0, '', { ORCA_PANE_KEY: '' })
    expect(result).toMatchObject({ code: 0, stderr: '', stdout: '{}\n', timedOut: false })
  })

  it('spools an unavailable listener event and fails open with JSON', async () => {
    const endpointDir = directory()
    const listener = await listen(REPLY)
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()))
    const endpoint = join(endpointDir, 'endpoint.env')
    writeFileSync(
      endpoint,
      `ORCA_AGENT_HOOK_PORT=${listener.port}\nORCA_AGENT_HOOK_TOKEN=${TOKEN}\n`
    )
    const result = await runHook(
      listener.port,
      JSON.stringify({ hook_event_name: 'BeforeAgent', prompt: PROMPT }),
      { ORCA_AGENT_HOOK_ENDPOINT: endpoint }
    )
    expect(result).toMatchObject({ code: 0, stderr: '', stdout: '{}\n', timedOut: false })
    const spoolDir = join(endpointDir, 'spool')
    const files = readdirSync(spoolDir)
    expect(files).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(spoolDir, files[0]), 'utf8'))).toMatchObject({
      source: 'gemini',
      payload: { hook_event_name: 'BeforeAgent', prompt: PROMPT }
    })
  })
})
