import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import { getManagedScript } from './claude-managed-hook-script'

const TOKEN = 'synthetic-claude-reply-token'
const REPLY = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit',
    additionalContext: 'file it, do not do it'
  }
})

type Listener = { port: number; posts: string[] }

/** Answers a UserPromptSubmit with `reply` (or 204 when null); every other event gets 204. */
async function listen(servers: Server[], reply: string | null): Promise<Listener> {
  const posts: string[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      body += chunk
    })
    req.on('end', () => {
      posts.push(body)
      if (req.headers['x-orca-agent-hook-token'] !== TOKEN) {
        res.writeHead(403).end()
        return
      }
      if (reply && body.includes('"hook_event_name":"UserPromptSubmit"')) {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(reply)
        return
      }
      res.writeHead(204).end()
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('No test listener port')
  }
  return { port: address.port, posts }
}

async function runHook(port: number, payload: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'omni-claude-reply-'))
  const script = join(dir, 'claude-hook.sh')
  writeFileSync(script, getManagedScript('posix', { skipWhenDevinImportsClaude: true }))
  chmodSync(script, 0o755)
  return runProcess({
    program: '/bin/sh',
    args: [script],
    input: JSON.stringify(payload),
    timeoutMs: 10_000,
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      ORCA_AGENT_HOOK_PORT: String(port),
      ORCA_AGENT_HOOK_TOKEN: TOKEN,
      ORCA_AGENT_HOOK_TRANSPORT: 'raw-json-v1',
      ORCA_PANE_KEY: 'tab-reply:11111111-1111-4111-8111-111111111111',
      ORCA_TAB_ID: 'tab-reply',
      ORCA_AGENT_LAUNCH_TOKEN: 'launch-reply',
      ORCA_AGENT_HOOK_ENV: 'production',
      ORCA_AGENT_HOOK_VERSION: '1'
    }
  })
}

describe.skipIf(process.platform === 'win32')('Claude managed hook stdout contract', () => {
  const servers: Server[] = []
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()))
          })
      )
    )
  })

  it('relays the listener JSON reply verbatim on UserPromptSubmit', async () => {
    const listener = await listen(servers, REPLY)
    const result = await runHook(listener.port, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'when done hand it off to Uma'
    })
    expect(result).toMatchObject({ code: 0, stderr: '', timedOut: false })
    expect(result.stdout).toBe(`${REPLY}\n`)
    expect(listener.posts).toHaveLength(1)
  })

  it('prints the neutral object when the listener has nothing to say', async () => {
    const listener = await listen(servers, null)
    const result = await runHook(listener.port, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'fix the failing test'
    })
    expect(result).toMatchObject({ code: 0, stderr: '', timedOut: false })
    expect(result.stdout).toBe('{}\n')
    expect(listener.posts).toHaveLength(1)
  })

  it('stays neutral on Stop even when the listener would answer', async () => {
    const listener = await listen(servers, REPLY)
    const result = await runHook(listener.port, { hook_event_name: 'Stop' })
    expect(result).toMatchObject({ code: 0, stderr: '', timedOut: false })
    expect(result.stdout).toBe('{}\n')
    expect(listener.posts).toHaveLength(1)
  })

  it('never blocks the prompt: a dead listener still exits 0 with neutral JSON', async () => {
    const closed = await listen(servers, REPLY)
    await new Promise<void>((resolve, reject) => {
      servers.pop()!.close((error) => (error ? reject(error) : resolve()))
    })
    const result = await runHook(closed.port, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'when done hand it off to Uma'
    })
    expect(result).toMatchObject({ code: 0, stderr: '', timedOut: false })
    expect(result.stdout).toBe('{}\n')
  })
})
