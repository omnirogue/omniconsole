import type { TokenUsage } from './direct-vs-coordinated-report'

/** Token counts read from an agent's own transcript. Anything unreadable is unknown, never 0. */

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function jsonLines(text: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue
    }
    try {
      const row: unknown = JSON.parse(line)
      if (row && typeof row === 'object') {
        rows.push(row as Record<string, unknown>)
      }
    } catch {
      // A torn last line is normal while the agent is still writing.
    }
  }
  return rows
}

/** Claude Code JSONL: one usage per API message id, repeated on each content-block line. */
export function claudeTranscriptUsage(text: string): TokenUsage | 'unknown' {
  const seen = new Set<string>()
  const total: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const row of jsonLines(text)) {
    const message = row.message as { id?: unknown; usage?: Record<string, unknown> } | undefined
    if (row.type !== 'assistant' || !message?.usage || typeof message.id !== 'string') {
      continue
    }
    if (seen.has(message.id)) {
      continue
    }
    const input = count(message.usage.input_tokens)
    const output = count(message.usage.output_tokens)
    if (input === null || output === null) {
      return 'unknown'
    }
    seen.add(message.id)
    total.input += input
    total.output += output
    total.cacheRead += count(message.usage.cache_read_input_tokens) ?? 0
    total.cacheWrite += count(message.usage.cache_creation_input_tokens) ?? 0
  }
  return seen.size === 0 ? 'unknown' : total
}

/** Codex rollout JSONL: the last token_count event carries the session's running total. */
export function codexRolloutUsage(text: string): TokenUsage | 'unknown' {
  let total: Record<string, unknown> | null = null
  for (const row of jsonLines(text)) {
    const payload = row.payload as { type?: unknown; info?: unknown } | undefined
    const info = payload?.info as { total_token_usage?: Record<string, unknown> } | null | undefined
    if (row.type === 'event_msg' && payload?.type === 'token_count' && info?.total_token_usage) {
      total = info.total_token_usage
    }
  }
  if (!total) {
    return 'unknown'
  }
  const input = count(total.input_tokens)
  const output = count(total.output_tokens)
  if (input === null || output === null) {
    return 'unknown'
  }
  const cacheRead = count(total.cached_input_tokens) ?? 0
  const cacheWrite = count(total.cache_write_input_tokens) ?? 0
  // Why: Codex counts cached tokens inside input_tokens; Claude reports them apart.
  return { input: Math.max(0, input - cacheRead - cacheWrite), output, cacheRead, cacheWrite }
}

export function transcriptUsage(agent: string, text: string | null): TokenUsage | 'unknown' {
  if (text === null) {
    return 'unknown'
  }
  if (agent === 'claude') {
    return claudeTranscriptUsage(text)
  }
  return agent === 'codex' ? codexRolloutUsage(text) : 'unknown'
}
