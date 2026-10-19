import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

type Listener = { port: number; posts: string[]; paths: string[] }

/** Answers the listed events (UserPromptSubmit by default) with `reply`, or 204; the rest get 204. */
async function listen(
  servers: Server[],
  reply: string | null,
  events: readonly string[] = ['UserPromptSubmit']
): Promise<Listener> {
  const posts: string[] = []
  const paths: string[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      body += chunk
    })
    req.on('end', () => {
      posts.push(body)
      paths.push(req.url ?? '')
      if (req.headers['x-orca-agent-hook-token'] !== TOKEN) {
        res.writeHead(403).end()
        return
      }
      if (reply && events.some((event) => body.includes(`"hook_event_name":"${event}"`))) {
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
  return { port: address.port, posts, paths }
}

async function runHook(
  port: number,
  payload: Record<string, unknown>,
  pathPrefix = '',
  extraEnv: Record<string, string> = {}
) {
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
      PATH: `${pathPrefix}${process.env.PATH}`,
      HOME: dir,
      ORCA_AGENT_HOOK_PORT: String(port),
      ORCA_AGENT_HOOK_TOKEN: TOKEN,
      ORCA_AGENT_HOOK_TRANSPORT: 'raw-json-v1',
      ORCA_PANE_KEY: 'tab-reply:11111111-1111-4111-8111-111111111111',
      ORCA_TAB_ID: 'tab-reply',
      ORCA_AGENT_LAUNCH_TOKEN: 'launch-reply',
      ORCA_AGENT_HOOK_ENV: 'production',
      ORCA_AGENT_HOOK_VERSION: '1',
      ...extraEnv
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

  it('stays neutral on Stop when the listener has nothing to say', async () => {
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

  it('relays an answer reply on PostToolUse, Stop and SessionStart', async () => {
    const answers = {
      PostToolUse: { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'a' } },
      Stop: { decision: 'block', reason: '[OmniOS decision] Approved' },
      SessionStart: {
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'a' }
      }
    }
    for (const [event, reply] of Object.entries(answers)) {
      const listener = await listen(servers, JSON.stringify(reply), [event])
      const result = await runHook(listener.port, { hook_event_name: event, source: 'resume' })
      expect(result).toMatchObject({ code: 0, stderr: '', timedOut: false })
      expect(result.stdout).toBe(`${JSON.stringify(reply)}\n`)
    }
  })

  it("keeps today's 1.5 s reply limit for every event (the listener guards answer timing)", async () => {
    const bin = mkdtempSync(join(tmpdir(), 'omni-claude-curl-'))
    const capture = join(bin, 'args.txt')
    writeFileSync(
      join(bin, 'curl'),
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${capture}"\ncat >/dev/null\nprintf '{}'\n`,
      { mode: 0o755 }
    )
    const limits: Record<string, string> = {}
    for (const event of ['PostToolUse', 'Stop', 'SessionStart', 'UserPromptSubmit']) {
      const result = await runHook(1, { hook_event_name: event, prompt: 'x' }, `${bin}:`)
      expect(result).toMatchObject({ code: 0, stdout: '{}\n' })
      const args = readFileSync(capture, 'utf8').split('\n')
      limits[event] = args[args.indexOf('--max-time') + 1]!
    }
    expect(limits).toEqual({
      PostToolUse: '1.5',
      Stop: '1.5',
      SessionStart: '1.5',
      UserPromptSubmit: '1.5'
    })
  })

  it('prints the neutral object for PostToolUse, Stop and SessionStart when the listener is gone', async () => {
    const closed = await listen(servers, REPLY, ['PostToolUse', 'Stop', 'SessionStart'])
    await new Promise<void>((resolve, reject) => {
      servers.pop()!.close((error) => (error ? reject(error) : resolve()))
    })
    for (const event of ['PostToolUse', 'Stop', 'SessionStart']) {
      const result = await runHook(closed.port, { hook_event_name: event, source: 'resume' })
      expect(result).toMatchObject({ code: 0, stderr: '', timedOut: false, stdout: '{}\n' })
    }
  })

  it('keeps the neutral object on early exits for answer events, and a prompt as before', async () => {
    const listener = await listen(servers, REPLY, ['PostToolUse', 'Stop', 'SessionStart'])
    const job = { CLAUDE_JOB_DIR: '/tmp/claude-job' }
    for (const event of ['PostToolUse', 'Stop', 'SessionStart']) {
      const result = await runHook(listener.port, { hook_event_name: event }, '', job)
      expect(result).toMatchObject({ code: 0, stdout: '{}\n' })
    }
    const prompt = await runHook(listener.port, { hook_event_name: 'UserPromptSubmit' }, '', job)
    expect(prompt).toMatchObject({ code: 0, stdout: '' })
    expect(listener.posts).toHaveLength(0)
  })

  it('prints only the JSON of an answer reply, then acknowledges it in the background', async () => {
    const json = JSON.stringify({ decision: 'block', reason: '[OmniOS decision] Approved' })
    const listener = await listen(servers, `omni-answer wd-1 nonce-7\n${json}`, ['Stop'])
    const result = await runHook(listener.port, { hook_event_name: 'Stop' })
    expect(result).toMatchObject({ code: 0, stderr: '', stdout: `${json}\n` })
    await vi.waitFor(() => expect(listener.paths).toContain('/hook-answer-ack'))
    const ack = listener.posts[listener.paths.indexOf('/hook-answer-ack')]!
    expect(new URLSearchParams(ack).get('ack')).toBe('wd-1 nonce-7')

    // a reply without an answer (the next-step pointer) is printed and never acknowledged
    const pointer = await listen(servers, REPLY)
    const prompt = await runHook(pointer.port, { hook_event_name: 'UserPromptSubmit', prompt: 'x' })
    expect(prompt.stdout).toBe(`${REPLY}\n`)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(pointer.paths).not.toContain('/hook-answer-ack')
  })
})
