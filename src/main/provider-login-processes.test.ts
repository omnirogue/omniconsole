import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnProcess } from '../shared/child-process/run-process'
import { runClaudeCommandProcess } from './claude-accounts/claude-command-process'
import { runCodexLoginSession } from './codex-accounts/codex-login-session'

const command = vi.hoisted(() => ({ path: '' }))
vi.mock('./codex-cli/command', () => ({
  resolveClaudeCommand: () => command.path,
  resolveCodexCommand: () => command.path
}))
const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function fixture(source: string): string {
  const root = mkdtempSync(join(tmpdir(), 'omni login test '))
  roots.push(root)
  const script = join(root, 'fixture.cjs')
  writeFileSync(script, source)
  command.path = join(root, process.platform === 'win32' ? 'provider.cmd' : 'provider')
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
  writeFileSync(
    command.path,
    process.platform === 'win32'
      ? `@"${process.execPath}" "${script}" %*\r\n`
      : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`,
    { mode: 0o755 }
  )
  return root
}

describe('native provider link processes', () => {
  it('reads a Claude link and submits the browser code through the live process pipe', async () => {
    const root = fixture(`
      console.log('https://claude.com/cai/oauth/authorize?state=fixture');
      console.log('Paste code here if prompted:');
      process.stdin.once('data', data => { console.log(data.toString().trim() === 'fixture-code#state' ? 'CODE_ACCEPTED' : 'CODE_REJECTED'); process.exit(0); });
    `)
    let input: ((code: string) => void) | null = null
    let sent = false
    const output = await runClaudeCommandProcess(
      ['auth', 'login', '--claudeai'],
      {
        windowsPath: root,
        linuxPath: null,
        wslDistro: null
      },
      10_000,
      {
        keepStdinOpen: true,
        interaction: {
          signal: new AbortController().signal,
          setInput: (write) => {
            input = write
          },
          onOutput: (output) => {
            if (!sent && output.includes('Paste code')) {
              sent = true
              input?.('fixture-code#state')
            }
          }
        }
      }
    )
    expect(output).toContain('CODE_ACCEPTED')
    expect(input).toBeNull()
  })

  it('runs Codex device login through a native CLI shim whose path contains spaces', async () => {
    const root = fixture(`
      if (!process.argv.includes('--device-auth')) process.exit(2);
      console.log('https://auth.openai.com/codex/device');
      console.log('ABCD-EFGHI');
    `)
    const output = vi.fn()
    await runCodexLoginSession(root, {
      wslCommand: 'wsl.exe',
      spawn: (request) =>
        spawnProcess({
          program: request.command,
          args: request.args,
          env: request.env,
          stdio: request.stdio
        }),
      killProcessTree: (child) => {
        child.kill()
      },
      interaction: { signal: new AbortController().signal, onOutput: output }
    })
    expect(output).toHaveBeenLastCalledWith(expect.stringContaining('ABCD-EFGHI'))
  })
})
