export type NativeResult = {
  value: unknown
  providerSessionId: string
  usage: Record<string, unknown>
  providerRequestId?: string
  resolvedModels?: string[]
}

/** Turns the provider's final answer text into the value the call's schema validates. */
export type NativeAnswer = (text: string) => unknown

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('workflow result envelope must be an object')
  }
  return value as Record<string, unknown>
}

export function requiredText(value: unknown): string {
  if (typeof value !== 'string' || !value) {
    throw new Error('workflow result is missing identity or content')
  }
  return value
}

/** Every non-empty stdout line must be one JSON object. */
export function jsonLines(stdout: string): Record<string, unknown>[] {
  return stdout
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => object(JSON.parse(line)))
}

/** The answer text streamed after the provider's last tool event (earlier text is narration). */
export function textAfterLastTool(
  lines: readonly Record<string, unknown>[],
  isTool: (line: Record<string, unknown>) => boolean,
  text: (line: Record<string, unknown>) => string | undefined
): string {
  let start = 0
  lines.forEach((line, index) => {
    if (isTool(line)) {
      start = index + 1
    }
  })
  return lines
    .slice(start)
    .map((line) => text(line) ?? '')
    .join('')
}

/**
 * Tokens from an accepted receipt's `usage`, in one shape for every route. Claude and Grok report
 * cache reads and writes beside `input_tokens`; Codex and Gemini already count them in it.
 */
export function workflowUsageTokens(usage: unknown): { input: number; output: number } | undefined {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    return undefined
  }
  const value = usage as Record<string, unknown>
  const count = (key: string) => {
    const amount = value[key]
    return typeof amount === 'number' && Number.isFinite(amount) ? amount : 0
  }
  const input =
    count('input_tokens') + count('cache_creation_input_tokens') + count('cache_read_input_tokens')
  const output = count('output_tokens')
  return input || output ? { input, output } : undefined
}

/**
 * What the provider last said about a failed turn, when it said it on stdout: Codex's `error` or
 * `turn.failed` event, or Claude's error result. Lines that are not JSON are skipped.
 */
export function providerFailureText(stdout: string): string | undefined {
  let said: string | undefined
  for (const line of stdout.split('\n')) {
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (!event || typeof event !== 'object') {
      continue
    }
    const entry = event as Record<string, unknown>
    const error = entry.error as { message?: unknown } | undefined
    const text =
      entry.type === 'error'
        ? entry.message
        : entry.type === 'turn.failed'
          ? error?.message
          : entry.type === 'result' && entry.is_error === true
            ? entry.result
            : undefined
    if (typeof text === 'string' && text.trim()) {
      said = text.trim()
    }
  }
  return said?.slice(0, 240)
}
