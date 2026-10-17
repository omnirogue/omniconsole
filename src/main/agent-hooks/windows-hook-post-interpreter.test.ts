// Why (#15117): an agent holding a private copy of the shared post command missed the move to
// curl for three months, invisible to per-agent tests. Assert the invariant across every agent
// at once: status-only Windows .cmd hooks post through curl.exe and spawn no interpreter.
// Generated under a mocked win32 platform, not executed, so the POSIX CI legs guard it too.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as osModule from 'node:os'

let isolatedUserDataDir = ''
let previousUserDataPath: string | undefined

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/omni-user-data'
  }
}))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof osModule>()
  return {
    ...actual,
    homedir: homedirMock.mockImplementation(actual.homedir)
  }
})

import { AntigravityHookService } from '../antigravity/hook-service'
import { ClaudeHookService } from '../claude/hook-service'
import { CodexHookService } from '../codex/hook-service'
import { CommandCodeHookService } from '../command-code/hook-service'
import { CursorHookService } from '../cursor/hook-service'
import { DevinHookService } from '../devin/hook-service'
import { DroidHookService } from '../droid/hook-service'
import { GeminiHookService } from '../gemini/hook-service'
import { GrokHookService } from '../grok/hook-service'
import { openClaudeHookService } from '../openclaude/hook-service'

// Why: only agents whose managed Windows script is a .cmd batch file. Copilot's hook is a
// `.ps1` — PowerShell is its interpreter, not a child process it spawns per event — and Kimi's
// is a Git Bash `.sh`, so neither is subject to this invariant.
const BATCH_SCRIPT_INSTALLERS = [
  { agent: 'antigravity', install: () => new AntigravityHookService().install() },
  { agent: 'claude', install: () => new ClaudeHookService().install() },
  { agent: 'openclaude', install: () => openClaudeHookService.install() },
  { agent: 'codex', install: () => new CodexHookService().install() },
  { agent: 'command-code', install: () => new CommandCodeHookService().install() },
  { agent: 'cursor', install: () => new CursorHookService().install() },
  { agent: 'devin', install: () => new DevinHookService().install() },
  { agent: 'droid', install: () => new DroidHookService().install() },
  { agent: 'gemini', install: () => new GeminiHookService().install() },
  { agent: 'grok', install: () => new GrokHookService().install() }
] as const

// Why: the Codex installer awaits an app-server trust-grant session, so the
// override has to stay pinned across the await instead of being restored by a
// synchronous `finally` while the install is still running.
async function withPlatform<T>(platform: NodeJS.Platform, run: () => T | Promise<T>): Promise<T> {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return await run()
  } finally {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  }
}

describe('Windows managed hook post interpreter', () => {
  let home = ''

  beforeEach(() => {
    previousUserDataPath = process.env.ORCA_USER_DATA_PATH
    isolatedUserDataDir = mkdtempSync(join(tmpdir(), 'omni-hook-interpreter-user-data-'))
    // Why: Orca-managed Codex hooks resolve through ORCA_USER_DATA_PATH before the mocked
    // home; an inherited live path would let this test rewrite the developer's own hooks.
    process.env.ORCA_USER_DATA_PATH = isolatedUserDataDir
    home = mkdtempSync(join(tmpdir(), 'omni-hook-interpreter-'))
    homedirMock.mockReturnValue(home)
  })

  afterEach(() => {
    if (previousUserDataPath === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = previousUserDataPath
    }
    rmSync(isolatedUserDataDir, { recursive: true, force: true })
    homedirMock.mockImplementation(() => process.env.HOME ?? tmpdir())
    rmSync(home, { recursive: true, force: true })
    home = ''
  })

  it('keeps status-only batch hooks on curl and validates the Gemini and Codex reply parsers', async () => {
    const scripts = await withPlatform('win32', async () => {
      for (const entry of BATCH_SCRIPT_INSTALLERS) {
        expect((await entry.install()).state, `${entry.agent} install status`).toBe('installed')
      }
      const hooksDir = join(home, '.omni', 'agent-hooks')
      return readdirSync(hooksDir)
        .filter((name) => name.endsWith('.cmd'))
        .map((name) => ({ name, body: readFileSync(join(hooksDir, name), 'utf8') }))
    })

    // Why: a silent zero would make this suite pass while asserting nothing.
    expect(scripts.length).toBeGreaterThanOrEqual(BATCH_SCRIPT_INSTALLERS.length)

    // Why: assert this across every .cmd before narrowing. Filtering to posting scripts first
    // hides the failure that matters — a script that swapped its curl POST for an interpreter
    // no longer matches the filter, so the suite fails on an opaque count instead.
    const replyAgents = [
      { name: 'gemini', event: 'BeforeAgent' },
      { name: 'codex', event: 'UserPromptSubmit' }
    ]
    for (const agent of replyAgents) {
      const script = scripts.find((script) => script.name === `${agent.name}-hook.cmd`)
      expect(script, `reply-aware ${agent.name} script`).toBeDefined()
      const body = script!.body
      const encoded = body.match(/-EncodedCommand (\S+)/)?.[1]
      expect(encoded, `${agent.name} reply parser must be encoded`).toBeDefined()
      const transport = Buffer.from(encoded!, 'base64').toString('utf16le')
      expect(body).toMatch(
        /"[A-Za-z]:\/.*\/System32\/WindowsPowerShell\/v1\.0\/powershell\.exe" -NoProfile -EncodedCommand /
      )
      for (const variable of ['ORCA_PANE_KEY', 'ORCA_AGENT_HOOK_PORT', 'ORCA_AGENT_HOOK_TOKEN']) {
        const guardAt = body.indexOf(`if not defined ${variable} goto :orca_gemini_neutral_reply`)
        expect(guardAt).toBeGreaterThan(-1)
        expect(guardAt).toBeLessThan(body.indexOf('-EncodedCommand'))
      }
      expect(transport).toContain('[System.Text.UTF8Encoding]::new($false,$true)')
      expect(transport).toContain('ConvertFrom-Json -InputObject $payload')
      expect(transport).toContain(`$event.hook_event_name -ceq '${agent.event}'`)
      expect(transport).toContain('ConvertFrom-Json -InputObject $raw')
      expect(transport).toContain('$raw -cmatch $shape')
      expect(transport).toContain(`http://127.0.0.1:$port/hook/${agent.name}`)
    }

    // Why: reply-aware hooks consume listener JSON; ordinary status hooks retain the cheap curl path.
    const statusScripts = scripts.filter(
      (script) => !replyAgents.some((agent) => script.name === `${agent.name}-hook.cmd`)
    )
    for (const script of statusScripts) {
      // Why: PowerShell costs ~300ms of interpreter startup per event and recodes the UTF-8
      // payload through the console code page. curl.exe (Win10 1803+) does neither.
      expect(script.body, `${script.name} must not spawn an interpreter`).not.toMatch(
        /powershell(\.exe)?/i
      )
    }

    // Why: `%~dp0` marks an event wrapper that only sets env and delegates to the core script.
    const isWrapper = (body: string): boolean => body.includes('%~dp0')
    const posts = (body: string): boolean => body.includes('127.0.0.1:%ORCA_AGENT_HOOK_PORT%')

    // Why: name the script that stopped posting rather than failing on a bare count.
    expect(
      statusScripts.filter((s) => !isWrapper(s.body) && !posts(s.body)).map((s) => s.name),
      'every non-wrapper script must post to the hook port'
    ).toEqual([])

    const posting = statusScripts.filter((script) => posts(script.body))
    expect(posting.length).toBeGreaterThanOrEqual(
      BATCH_SCRIPT_INSTALLERS.length - replyAgents.length
    )

    for (const script of posting) {
      // Why: fully qualified so a repo-local curl.exe cannot intercept hook payloads.
      expect(script.body, `${script.name} must post through curl.exe`).toContain(
        '"%SystemRoot%\\System32\\curl.exe"'
      )
    }

    // Why: hook events pipe via stdin to keep multi-KB tool output off the command line (EDR
    // oversized-command-line rules). The statusline script stages a temp file instead.
    for (const script of posting.filter((s) => s.body.includes('/hook/'))) {
      expect(script.body, `${script.name} must pipe the payload via stdin`).toContain(
        '--data-urlencode "payload@-"'
      )
    }
  })
})
