import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { getManagedScript } from './codex-hook-script'

const ANSWER = JSON.stringify({ decision: 'block', reason: '[OmniOS decision] Approved' })

function fakeCurl(dir: string, name: string, capture: string, exitCode = 0) {
  writeFileSync(
    join(dir, name),
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${capture}"\ncat >/dev/null\nprintf '%s' '${ANSWER}'\nexit ${exitCode}\n`,
    { mode: 0o755 }
  )
}

async function run(event: string, bin: string, extraEnv: Record<string, string> = {}) {
  return runProcess({
    program: '/bin/sh',
    args: ['-c', getManagedScript('posix')],
    input: JSON.stringify({ hook_event_name: event, session_id: 'thread-1' }),
    timeoutMs: 10_000,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      ORCA_AGENT_HOOK_PORT: '43210',
      ORCA_AGENT_HOOK_TOKEN: 'test-token',
      ORCA_PANE_KEY: 'pane-test',
      ...extraEnv
    }
  })
}

const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1]

describe.skipIf(process.platform === 'win32')('Codex managed hook answer replies', () => {
  it("relays answer events' replies with today's limits; status events stay silent", async () => {
    const seen: Record<string, unknown> = {}
    for (const event of ['Stop', 'PostToolUse', 'SessionStart', 'UserPromptSubmit', 'PreToolUse']) {
      const bin = mkdtempSync(join(tmpdir(), 'omni-codex-curl-'))
      const capture = join(bin, 'args.txt')
      fakeCurl(bin, 'curl', capture)
      const result = await run(event, bin)
      const args = readFileSync(capture, 'utf8').split('\n')
      expect(result).toMatchObject({ code: 0, timedOut: false })
      seen[event] = [result.stdout.trim(), argAfter(args, '--max-time')]
      expect(args).toContain('X-Omni-Agent-Hook-Late: 0')
    }
    expect(seen).toEqual({
      Stop: [ANSWER, '1.5'],
      PostToolUse: [ANSWER, '1.5'],
      SessionStart: [ANSWER, '1.5'],
      UserPromptSubmit: [ANSWER, '1.5'],
      PreToolUse: ['', '1.5']
    })
  })

  it('marks the WSL retry late, so its reply never carries an answer past the deadline', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'omni-codex-wsl-'))
    fakeCurl(bin, 'curl', join(bin, 'loopback.txt'), 7)
    fakeCurl(bin, 'curl.exe', join(bin, 'retry.txt'))
    const result = await run('Stop', bin, { WSL_DISTRO_NAME: 'Ubuntu' })
    expect(result).toMatchObject({ code: 0, timedOut: false })
    expect(readFileSync(join(bin, 'loopback.txt'), 'utf8')).toContain('X-Omni-Agent-Hook-Late: 0')
    const retry = readFileSync(join(bin, 'retry.txt'), 'utf8').split('\n')
    expect(retry).toContain('X-Omni-Agent-Hook-Late: 1')
    expect(argAfter(retry, '--max-time')).toBe('5')
  })

  it('prints only the JSON of an answer reply and acknowledges it with its token', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'omni-codex-ack-'))
    const calls = join(bin, 'calls.txt')
    writeFileSync(
      join(bin, 'curl'),
      `#!/bin/sh\nprintf '%s\\n' "$@" >> "${calls}"\ncat >/dev/null\nprintf 'omni-answer wd-2 nonce-9\\n%s' '${ANSWER}'\n`,
      { mode: 0o755 }
    )
    const result = await run('PostToolUse', bin)
    expect(result.stdout.trim()).toBe(ANSWER)
    await vi.waitFor(() => expect(readFileSync(calls, 'utf8')).toContain('/hook-answer-ack'))
    expect(readFileSync(calls, 'utf8')).toContain('ack=wd-2 nonce-9')
  })
})
