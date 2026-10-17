import { tokenizeCustomCommandTemplate } from '../../shared/commit-message-prompt'
import { promptTextIncomplete } from './session-prompt'

/** A backslash-newline disappears only outside a single-quoted literal. */
function joinContinuations(command: string): string {
  const result: string[] = []
  let quote: '"' | "'" | null = null
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!
    if (quote !== "'" && character === '\\' && index + 1 < command.length) {
      const next = command[++index]!
      if (next !== '\n') {
        result.push(character, next)
      }
      continue
    }
    if (character === quote) {
      quote = null
    } else if (quote === null && (character === "'" || character === '"')) {
      quote = character
    }
    result.push(character)
  }
  return result.join('')
}

/** Only literal shell words: expansion, control flow and another interpreter require a person. */
export function literalPromptCommand(command: string): string | null {
  if (promptTextIncomplete(command) || /[$`%^{[\]()*?~!]/.test(command)) {
    return null
  }
  const source = joinContinuations(command)
  // The tokenizer joins adjacent quoted fragments but deliberately refuses shell operators.
  const parsed = tokenizeCustomCommandTemplate(source)
  if (!parsed.ok || !parsed.tokens.length || parsed.spans.some((span) => span.divergesFromShell)) {
    return null
  }
  if (
    /[\r\n]/.test(source) ||
    parsed.tokens.some((word) =>
      /^(?:.*[/\\])?(?:(?:ba|da|z|k|c|fi)?sh|eval|exec|source|\.|cmd|powershell|pwsh|python[\d.]*|node|perl|ruby|lua|php)(?:\.exe)?$/i.test(
        word
      )
    )
  ) {
    return null
  }
  return parsed.tokens.join(' ')
}

/** Decode the schemas published by the Claude Bash and Codex command approval adapters. */
export function structuredPromptCommand(
  title: string,
  detail: string | null,
  command?: string
): string | null {
  if (!detail || promptTextIncomplete(detail)) {
    return null
  }
  if (title === 'Run a command?') {
    return command ?? null
  }
  if (title !== 'Allow Bash?') {
    return null
  }
  try {
    const value: unknown = JSON.parse(detail)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null
    }
    const input = value as Record<string, unknown>
    return typeof input.command === 'string' ? input.command : null
  } catch {
    return null
  }
}
