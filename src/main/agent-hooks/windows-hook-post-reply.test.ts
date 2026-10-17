import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess, spawnProcess } from '../../shared/child-process/run-process'
import {
  buildWindowsGeminiHookScript,
  buildWindowsPromptHookScript
} from './windows-hook-post-reply'
import { AGENT_HOOK_PROMPT_REPLY_MAX_BYTES } from '../../shared/agent-hook-prompt-reply-limit'
import { getGeminiManagedHookCommand } from '../gemini/hook-service'
import { getWindowsPowerShellExecutablePath } from './windows-powershell-hook-launcher'

function decodeTransport(script: string): string {
  const encoded = script.match(/-EncodedCommand (\S+)/)?.[1]
  expect(encoded).toBeTruthy()
  return Buffer.from(encoded!, 'base64').toString('utf16le')
}

it('targets Codex prompt replies with the same bounded Windows transport', () => {
  const script = buildWindowsPromptHookScript('codex')
  const transport = decodeTransport(script)
  expect(transport).toContain('/hook/codex')
  expect(transport).toContain("$event.hook_event_name -ceq 'UserPromptSubmit'")
  expect(transport).toContain('"UserPromptSubmit"')
  expect(transport).not.toContain('BeforeAgent')
  expect(
    script.split('\r\n').find((line) => line.includes('-EncodedCommand'))!.length
  ).toBeLessThan(8191)
})

describe('Windows Gemini reply transport structure', () => {
  it('guards before starting the stdin reader and has one neutral-output path', () => {
    const script = buildWindowsGeminiHookScript()
    const transportAt = script.indexOf('-EncodedCommand')
    for (const variable of ['ORCA_PANE_KEY', 'ORCA_AGENT_HOOK_PORT', 'ORCA_AGENT_HOOK_TOKEN']) {
      const guard = `if not defined ${variable} goto :orca_gemini_neutral_reply`
      expect(script.indexOf(guard)).toBeGreaterThan(-1)
      expect(script.indexOf(guard)).toBeLessThan(transportAt)
    }
    expect(script).toContain('setlocal DisableDelayedExpansion')
    expect(script).toContain('if errorlevel 1 goto :orca_gemini_neutral_reply')
    expect(script).toContain(':orca_gemini_neutral_reply\r\necho {}\r\nexit /b 0')
    expect(script.slice(0, transportAt)).not.toContain('echo {}')
    expect(script).not.toContain('more.com')
  })

  it('uses the qualified shared launcher and keeps the encoded command within cmd limits', () => {
    const script = buildWindowsGeminiHookScript()
    const command = script.split('\r\n').find((line) => line.includes('-EncodedCommand'))!
    expect(command).toMatch(
      /^"[A-Za-z]:\/.*\/System32\/WindowsPowerShell\/v1\.0\/powershell\.exe" -NoProfile -EncodedCommand /
    )
    expect(command.length).toBeLessThan(8191)
    const transport = decodeTransport(script)
    expect(transport).toContain('[System.Text.UTF8Encoding]::new($false,$true)')
    expect(transport).not.toContain('Set-ExecutionPolicy')
    expect(transport).not.toContain('New-Object')
    expect(transport).toContain("$PSModuleAutoLoadingPreference='None'")
    expect(transport).toContain(
      'Import-Module "$PSHOME/Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1"'
    )
    expect(transport).toContain('[Console]::OpenStandardInput()')
    expect(transport).toContain('[Console]::OpenStandardOutput().Write(')
    expect(transport).toContain('[System.Net.WebUtility]::UrlEncode(')
    expect(transport).toContain('ConvertFrom-Json -InputObject $payload')
    expect(transport).toContain("$event.hook_event_name -ceq 'BeforeAgent'")
    expect(transport).toContain('ConvertFrom-Json -InputObject $raw')
    expect(transport).toContain('$raw -cmatch $shape')
    expect(transport).toContain(`$utf8.GetByteCount($raw) -gt ${AGENT_HOOK_PROMPT_REPLY_MAX_BYTES}`)
    expect(transport).toContain('$request.Proxy=$null; $request.AllowAutoRedirect=$false')
  })
})

const CONTEXT = 'Review with 3 agents, then send to Gamma: café 日本語 😀'
const REPLY = { hookSpecificOutput: { hookEventName: 'BeforeAgent', additionalContext: CONTEXT } }
const PAYLOAD = JSON.stringify(
  { hook_event_name: 'BeforeAgent', prompt: CONTEXT, transcript: 'x'.repeat(40_000) },
  null,
  2
)

describe.skipIf(process.platform !== 'win32')('Windows Gemini reply transport', () => {
  const dirs: string[] = []
  const servers: Server[] = []

  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections()
      server.close()
    }
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function writeScript(): string {
    const dir = mkdtempSync(join(tmpdir(), 'omni gemini reply '))
    dirs.push(dir)
    const script = join(dir, 'gemini-hook.cmd')
    writeFileSync(script, buildWindowsGeminiHookScript())
    return script
  }

  function environment(port: number, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const base = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('ORCA_'))
    )
    return {
      ...base,
      ORCA_PANE_KEY: 'tab!1:pane!2',
      ORCA_TAB_ID: 'tab!1',
      ORCA_AGENT_LAUNCH_TOKEN: 'launch-token',
      ORCA_WORKTREE_ID: 'folder::C:/work/a"b&c%PATH%!',
      ORCA_AGENT_HOOK_ENV: 'local',
      ORCA_AGENT_HOOK_VERSION: 'test-version',
      ORCA_AGENT_HOOK_PORT: String(port),
      ORCA_AGENT_HOOK_TOKEN: 'hook-token',
      ...overrides
    }
  }

  async function listen(reply: string, status = 200) {
    const posts: {
      url: string | undefined
      form: URLSearchParams
      headers: Record<string, unknown>
    }[] = []
    const server = createServer((req, res) => {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => {
        body += chunk
      })
      req.on('end', () => {
        posts.push({ url: req.url, form: new URLSearchParams(body), headers: req.headers })
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(reply)
      })
    })
    servers.push(server)
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') {
          return reject(new Error('Missing port'))
        }
        resolve(address.port)
      })
    })
    return { port, posts, server }
  }

  async function run(port: number, payload = PAYLOAD, overrides: NodeJS.ProcessEnv = {}) {
    // Why: exercise the installed outer launcher too, including first-use startup cost.
    const command = getGeminiManagedHookCommand(writeScript())
    const encoded = command.match(/ -EncodedCommand (\S+)$/)?.[1]
    expect(encoded).toBeTruthy()
    const result = await runProcess({
      program: getWindowsPowerShellExecutablePath(),
      args: ['-NoProfile', '-EncodedCommand', encoded!],
      env: environment(port, overrides),
      input: payload,
      // The installed PowerShell launcher can take longer under the full Windows CI suite.
      timeoutMs: 30_000
    })
    expect(result.timedOut, JSON.stringify(result)).toBe(false)
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    // JSON.parse rejects a second response document as well as non-JSON stdout.
    return JSON.parse(result.stdout) as unknown
  }

  it('relays through the installed launcher and preserves UTF-8 payload and envelope bytes', async () => {
    const listener = await listen(`\n ${JSON.stringify(REPLY, null, 2)}\n`)
    expect(await run(listener.port)).toEqual(REPLY)
    expect(listener.posts).toHaveLength(1)
    const { url, form, headers } = listener.posts[0]
    expect(url).toBe('/hook/gemini')
    expect(form.get('payload')).toBe(PAYLOAD)
    expect(form.get('paneKey')).toBe('tab!1:pane!2')
    expect(form.get('worktreeId')).toBe('folder::C:/work/a"b&c%PATH%!')
    expect(form.get('tabId')).toBe('tab!1')
    expect(form.get('launchToken')).toBe('launch-token')
    expect(form.get('env')).toBe('local')
    expect(form.get('version')).toBe('test-version')
    expect(headers['x-orca-agent-hook-token']).toBe('hook-token')
    expect(headers['x-omni-agent-hook-token']).toBe('hook-token')
  })

  it('reads and posts without searching inherited module paths', async () => {
    const listener = await listen(JSON.stringify(REPLY))
    expect(await run(listener.port, PAYLOAD, { PSModulePath: 'C:\\missing-hook-modules' })).toEqual(
      REPLY
    )
    expect(listener.posts[0].form.get('payload')).toBe(PAYLOAD)
  })

  it.each(['AfterAgent', 'AfterTool', 'BeforeTool', 'beforeagent'])(
    'discards instructions for %s while still posting its status',
    async (event) => {
      const listener = await listen(JSON.stringify(REPLY))
      const payload = JSON.stringify({ hook_event_name: event, prompt: 'BeforeAgent' })
      expect(await run(listener.port, payload)).toEqual({})
      expect(listener.posts[0].form.get('payload')).toBe(payload)
    }
  )

  it.each(['', '{broken}', '{"partial":', 'true', 'null', '123', '"text"', '[]', '[{}]', '{}\n{}'])(
    'answers once with a neutral object for invalid listener reply %j',
    async (reply) => {
      const listener = await listen(reply)
      expect(await run(listener.port)).toEqual({})
    }
  )

  it.each(['', '{broken}', '{"hook_event_name":'])(
    'answers once with a neutral object for malformed input %j',
    async (payload) => {
      const listener = await listen(JSON.stringify(REPLY))
      expect(await run(listener.port, payload)).toEqual({})
      expect(listener.posts).toHaveLength(0)
    }
  )

  it.each([
    JSON.stringify({ ...REPLY, decision: 'deny' }),
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'AfterAgent', additionalContext: 'x' } }),
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'BeforeAgent', additionalContext: 123 }
    }),
    JSON.stringify(REPLY).replace('"hookSpecificOutput"', 'hookSpecificOutput'),
    JSON.stringify(REPLY).replace('}}', ',}}'),
    `\u00a0${JSON.stringify(REPLY)}`
  ])('rejects unsupported controls and JSON extensions in listener reply %j', async (reply) => {
    const listener = await listen(reply)
    expect(await run(listener.port)).toEqual({})
  })

  it('accepts either field order and escaped context characters', async () => {
    const reply = {
      hookSpecificOutput: {
        additionalContext: 'Line 1\n"quoted"\\path',
        hookEventName: 'BeforeAgent'
      }
    }
    const listener = await listen(JSON.stringify(reply))
    expect(await run(listener.port, JSON.stringify({ hook_event_name: 'BeforeAgent' }))).toEqual(
      reply
    )
  })

  it.each(['`omni.cmd x` ＋ "quoted" '.repeat(30), "<>&'".repeat(100)])(
    'preserves a valid context without expanding its serialized byte budget',
    async (context) => {
      const reply = {
        hookSpecificOutput: { hookEventName: 'BeforeAgent', additionalContext: context }
      }
      const body = JSON.stringify(reply)
      expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(AGENT_HOOK_PROMPT_REPLY_MAX_BYTES)
      const listener = await listen(body)
      expect(await run(listener.port)).toEqual(reply)
    }
  )

  it.each(['x'.repeat(AGENT_HOOK_PROMPT_REPLY_MAX_BYTES), '😀'.repeat(300)])(
    'rejects replies over the UTF-8 byte cap',
    async (context) => {
      const reply = {
        hookSpecificOutput: { hookEventName: 'BeforeAgent', additionalContext: context }
      }
      const listener = await listen(JSON.stringify(reply))
      expect(await run(listener.port)).toEqual({})
    }
  )

  it('answers once with a neutral object for listener rejection', async () => {
    const listener = await listen(JSON.stringify(REPLY), 403)
    expect(await run(listener.port)).toEqual({})
  })

  it('answers once with a neutral object after a transport failure', async () => {
    const listener = await listen(JSON.stringify(REPLY))
    await new Promise<void>((resolve) => listener.server.close(() => resolve()))
    expect(await run(listener.port)).toEqual({})
  })

  it('refreshes a stale endpoint silently before posting', async () => {
    const listener = await listen(JSON.stringify(REPLY))
    const script = writeScript()
    const endpoint = `${script}.endpoint.cmd`
    writeFileSync(
      endpoint,
      `@echo ignored endpoint output\r\n@set ORCA_AGENT_HOOK_PORT=${listener.port}\r\n`
    )
    expect(await run(1, PAYLOAD, { ORCA_AGENT_HOOK_ENDPOINT: endpoint })).toEqual(REPLY)
    expect(listener.posts).toHaveLength(1)
  })

  it.each(['ORCA_PANE_KEY', 'ORCA_AGENT_HOOK_PORT', 'ORCA_AGENT_HOOK_TOKEN'])(
    'does not read an unclosed stdin pipe when %s is absent',
    async (missing) => {
      const child = spawnProcess({
        program: writeScript(),
        env: environment(1, { [missing]: undefined })
      })
      let stdout = ''
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      child.stdin.on('error', () => {})
      const result = await new Promise<{ code: number | null; timedOut: boolean }>(
        (resolve, reject) => {
          const timer = setTimeout(() => {
            child.kill()
            resolve({ code: null, timedOut: true })
          }, 3_000)
          child.once('error', (error) => {
            clearTimeout(timer)
            reject(error)
          })
          child.once('close', (code) => {
            clearTimeout(timer)
            resolve({ code, timedOut: false })
          })
        }
      )
      expect(result).toEqual({ code: 0, timedOut: false })
      expect(JSON.parse(stdout)).toEqual({})
    }
  )
})
