import {
  cleanupHiddenRateLimitPty,
  registerHiddenRateLimitPty
} from '../rate-limits/hidden-pty-cleanup'

export type ClaudeConnectorLoginResult = { code: number | null; timedOut: boolean }

/**
 * Runs `claude mcp login <name>` in a hidden pseudo-terminal and waits for it to exit.
 *
 * Why: Claude Code 2.1 refuses `mcp login` when stdin is not a terminal ("stdin isn't a
 * terminal, so authentication can't be completed here") even when it opens the browser
 * itself, so the piped child-process path exited 1 on every Claude account. The terminal
 * only satisfies that check; the browser callback completes sign-in. Output is drained and
 * dropped because it carries the authorization URL.
 */
export async function runClaudeConnectorLoginInPty(input: {
  program: string
  name: string
  env: NodeJS.ProcessEnv
  cwd: string
  timeoutMs: number
}): Promise<ClaudeConnectorLoginResult> {
  const pty = await import('node-pty')
  const args = ['mcp', 'login', input.name]
  // Why: node-pty cannot spawn .cmd/.bat shims directly on Windows; cmd.exe interprets them.
  const isWin32 = process.platform === 'win32'
  const env: Record<string, string> = { TERM: 'xterm-256color' }
  for (const [key, value] of Object.entries(input.env)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  const term = pty.spawn(
    isWin32 ? 'cmd.exe' : input.program,
    isWin32 ? ['/c', `"${input.program}"`, ...args] : args,
    { name: 'xterm-256color', cols: 120, rows: 40, cwd: input.cwd, env }
  )
  const disposables: { dispose: () => void }[] = [registerHiddenRateLimitPty(term)]
  return new Promise((resolve) => {
    let settled = false
    const settle = (result: ClaudeConnectorLoginResult, kill: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      cleanupHiddenRateLimitPty(term, disposables, { kill })
      resolve(result)
    }
    const timer = setTimeout(() => settle({ code: null, timedOut: true }, true), input.timeoutMs)
    disposables.push(term.onData(() => {}))
    disposables.push(
      term.onExit(({ exitCode }) => settle({ code: exitCode, timedOut: false }, false))
    )
  })
}
