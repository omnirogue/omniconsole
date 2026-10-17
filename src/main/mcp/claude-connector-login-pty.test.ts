import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ptySpawnMock } = vi.hoisted(() => ({ ptySpawnMock: vi.fn() }))
vi.mock('node-pty', () => ({ spawn: ptySpawnMock }))

import { getActiveHiddenRateLimitPtyCount } from '../rate-limits/hidden-pty-cleanup'
import { runClaudeConnectorLoginInPty } from './claude-connector-login-pty'

function fakeTerm() {
  const handlers: { exit?: (event: { exitCode: number }) => void } = {}
  const kill = vi.fn()
  const destroy = vi.fn()
  const term = {
    kill,
    destroy,
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn((handler: (event: { exitCode: number }) => void) => {
      handlers.exit = handler
      return { dispose: vi.fn() }
    })
  }
  ptySpawnMock.mockReturnValue(term)
  return { kill, destroy, handlers }
}

const input = {
  program: '/bin/claude',
  name: 'docs',
  env: { CLAUDE_CONFIG_DIR: '/accounts/one', UNSET: undefined },
  cwd: '/home',
  timeoutMs: 1_000
}

describe('runClaudeConnectorLoginInPty', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    ptySpawnMock.mockReset()
  })

  it.skipIf(process.platform === 'win32')(
    'runs mcp login for the account in a terminal and reports its exit code',
    async () => {
      const { kill, destroy, handlers } = fakeTerm()
      const pending = runClaudeConnectorLoginInPty(input)
      await vi.waitFor(() => expect(handlers.exit).toBeDefined())
      const [program, args, options] = ptySpawnMock.mock.calls[0]
      expect(program).toBe('/bin/claude')
      expect(args).toEqual(['mcp', 'login', 'docs'])
      expect(options.env).toEqual({ TERM: 'xterm-256color', CLAUDE_CONFIG_DIR: '/accounts/one' })
      expect(options.cwd).toBe('/home')
      handlers.exit!({ exitCode: 0 })
      await expect(pending).resolves.toEqual({ code: 0, timedOut: false })
      expect(kill).not.toHaveBeenCalled()
      expect(destroy).toHaveBeenCalled()
      expect(getActiveHiddenRateLimitPtyCount()).toBe(0)
    }
  )

  it('kills the terminal when sign-in does not finish before the deadline', async () => {
    const { kill, handlers } = fakeTerm()
    const pending = runClaudeConnectorLoginInPty(input)
    await vi.waitFor(() => expect(handlers.exit).toBeDefined())
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(pending).resolves.toEqual({ code: null, timedOut: true })
    expect(kill).toHaveBeenCalled()
    handlers.exit!({ exitCode: 1 })
    expect(getActiveHiddenRateLimitPtyCount()).toBe(0)
  })
})
