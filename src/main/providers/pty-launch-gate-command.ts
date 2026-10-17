import type { PtyLaunchGateRequest } from '../../shared/pty-launch-gate'
import { tokenizeStartupCommand } from '../../shared/tui-agent-startup-shell'

/**
 * True when the command would not stay one shell line under POSIX quoting: a CR or LF
 * outside quotes (including a backslash line continuation), a backslash-newline inside
 * double quotes, or a backslash inside single quotes.
 *
 * Why a quoted line break is allowed: argv-prompt providers (Claude, Codex) carry the
 * prompt as one word built by quoteStartupArg, so a multi-line brief puts LF bytes inside
 * single quotes. The `exec …` line is typed into the PTY's interactive login shell; OmniConsole's
 * wrapped bash/zsh/fish get it as one bracketed paste (startup-command-submission.ts) and
 * other sh-family shells read the next lines as continuation of the open quote. Either way the
 * quoted word reaches `exec` as one argument, exactly as non-managed launches already send
 * the same multi-line quoted prompts.
 *
 * Why a backslash inside single quotes is refused: fish treats `\'` and `\\` there as
 * escapes, so its quote boundaries would differ from this scan. quoteStartupArg never emits
 * one (it writes backslashes as `"\\"`).
 */
function breaksSingleShellLine(command: string): boolean {
  let quote: "'" | '"' | null = null
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (quote === "'") {
      if (char === '\\') {
        return true
      }
      if (char === "'") {
        quote = null
      }
      continue
    }
    if (char === '\\') {
      const next = command[index + 1]
      if (next === '\n' || next === '\r') {
        return true
      }
      index += 1
      continue
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null
      }
      continue
    }
    if (char === '\n' || char === '\r') {
      return true
    }
    if (char === "'" || char === '"') {
      quote = char
    }
  }
  return false
}

export function buildPtyLaunchGateCommand(command: string, request?: PtyLaunchGateRequest): string {
  if (request?.startupCommandMode !== 'exec') {
    return command
  }
  const parsed = tokenizeStartupCommand(command, 'posix')
  if (
    !parsed.ok ||
    !parsed.tokens.length ||
    // `@` appears in npm-scoped install paths (…/@openai/codex-darwin-arm64/…/codex).
    !/^[A-Za-z0-9_./][A-Za-z0-9_./@ -]*$/.test(parsed.tokens[0]) ||
    parsed.spans.some((span) => span.divergesFromShell) ||
    breaksSingleShellLine(command) ||
    ['exec', 'eval', 'source', '.', 'command', 'builtin'].includes(parsed.tokens[0])
  ) {
    throw new Error('pty_launch_gate_exec_command_unsupported')
  }
  // Keep the existing launcher's quoting and environment; reject compound shell programs.
  return `exec ${command}`
}
