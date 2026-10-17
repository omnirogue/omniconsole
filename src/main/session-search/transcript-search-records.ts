import {
  isCompactContinuationUserTurnText,
  isKnownHarnessInjectedUserTurnText
} from '../../shared/harness-injected-user-turns'
import { personWords } from '../../shared/session-handoff-summary'
import type { SessionSearchAgent, SessionSearchRole } from '../../shared/session-search-types'

/** One piece of searchable text from a transcript line. */
export type TranscriptSearchRecord = {
  role: SessionSearchRole
  text: string
  ts: number | null
  /** Tool output: searchable, but never shown as a snippet (see the index's `outputs` table). */
  output?: true
}

/** Everything one JSONL line contributes to the index. */
export type TranscriptLineFacts = {
  records: TranscriptSearchRecord[]
  /** Higher rank wins: a name the person chose beats a generated one. */
  title?: { text: string; rank: number }
  cwd?: string
  links?: string[]
  ts: number | null
}

const USER_TEXT_CAP = 16_000
const ASSISTANT_TEXT_CAP = 16_000
const TOOL_INPUT_CAP = 1_500
const TOOL_OUTPUT_HEAD = 1_600
const TOOL_OUTPUT_TAIL = 600

// Codex wraps injected context in snake_case tags (<environment_context>, <user_instructions>);
// people rarely open a prompt with one, so these turns are machinery, not asks.
const CODEX_INJECTED_BLOCK = /^\s*<([a-z]+_[a-z_]+|INSTRUCTIONS)>/
const AGENTS_INSTRUCTIONS_PREFIX = '# AGENTS.md instructions'

const TOOL_INPUT_KEYS = [
  'description',
  'command',
  'cmd',
  'file_path',
  'path',
  'pattern',
  'url',
  'query',
  'prompt',
  'title',
  'content',
  'new_string'
]

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null
  }
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function cap(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** Tool output keeps its head and tail: IDs and URLs sit at either end of most logs. */
function capToolOutput(text: string): string {
  if (text.length <= TOOL_OUTPUT_HEAD + TOOL_OUTPUT_TAIL) {
    return text
  }
  return `${text.slice(0, TOOL_OUTPUT_HEAD)} … ${text.slice(-TOOL_OUTPUT_TAIL)}`
}

function textParts(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  const parts: string[] = []
  for (const item of content) {
    if (typeof item === 'string') {
      parts.push(item)
      continue
    }
    const record = asRecord(item)
    if (record && typeof record.text === 'string') {
      parts.push(record.text)
    }
  }
  return parts.join('\n')
}

function summarizeToolInput(name: string, input: unknown): string {
  const record = asRecord(input)
  if (!record) {
    return cap(`${name} ${typeof input === 'string' ? input : ''}`.trim(), TOOL_INPUT_CAP)
  }
  const values: string[] = []
  for (const key of TOOL_INPUT_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) {
      values.push(cap(value, 600))
    }
  }
  const body = values.length > 0 ? values.join(' ') : safeJson(record)
  return cap(`${name} ${body}`, TOOL_INPUT_CAP)
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

function personText(text: string): string | null {
  if (
    !text.trim() ||
    isKnownHarnessInjectedUserTurnText(text) ||
    isCompactContinuationUserTurnText(text)
  ) {
    return null
  }
  const words = personWords(text)
  return words ? cap(words, USER_TEXT_CAP) : null
}

function claudeLine(record: Record<string, unknown>, ts: number | null): TranscriptLineFacts {
  const facts: TranscriptLineFacts = { records: [], ts }
  if (typeof record.cwd === 'string') {
    facts.cwd = record.cwd
  }
  switch (record.type) {
    case 'custom-title':
      return withTitle(facts, record.customTitle, 3)
    case 'ai-title':
      return withTitle(facts, record.aiTitle ?? record.title, 2)
    case 'agent-name':
      return withTitle(facts, record.agentName ?? record.name, 1)
    case 'summary':
      return withTitle(facts, record.summary, 1)
    case 'pr-link': {
      const url = typeof record.prUrl === 'string' ? record.prUrl : null
      if (url) {
        facts.links = [url]
        facts.records.push({ role: 'tool', text: `pull request ${url}`, ts })
      }
      return facts
    }
    case 'user':
    case 'assistant':
      break
    default:
      // Attachments carry hook-injected context (memory, peers, wiki) that names people and
      // projects the conversation never discussed; indexing them makes every session match.
      return facts
  }
  if (record.isMeta === true || record.isCompactSummary === true) {
    return facts
  }
  const message = asRecord(record.message)
  const content = message?.content
  if (record.type === 'user') {
    if (typeof content === 'string') {
      const text = personText(content)
      if (text) {
        facts.records.push({ role: 'user', text, ts })
      }
      return facts
    }
    for (const item of Array.isArray(content) ? content : []) {
      const part = asRecord(item)
      if (part?.type === 'text' && typeof part.text === 'string') {
        const text = personText(part.text)
        if (text) {
          facts.records.push({ role: 'user', text, ts })
        }
      } else if (part?.type === 'tool_result') {
        const text = textParts(part.content)
        if (text.trim()) {
          facts.records.push({ role: 'tool', text: capToolOutput(text), ts, output: true })
        }
      }
    }
    return facts
  }
  for (const item of Array.isArray(content) ? content : []) {
    const part = asRecord(item)
    if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
      facts.records.push({ role: 'assistant', text: cap(part.text, ASSISTANT_TEXT_CAP), ts })
    } else if (part?.type === 'tool_use') {
      const name = typeof part.name === 'string' ? part.name : 'tool'
      facts.records.push({ role: 'tool', text: summarizeToolInput(name, part.input), ts })
    }
  }
  return facts
}

function withTitle(facts: TranscriptLineFacts, value: unknown, rank: number): TranscriptLineFacts {
  if (typeof value === 'string' && value.trim()) {
    facts.title = { text: cap(value.trim(), 200), rank }
  }
  return facts
}

function isCodexInjected(text: string): boolean {
  return (
    CODEX_INJECTED_BLOCK.test(text) ||
    text.trimStart().startsWith(AGENTS_INSTRUCTIONS_PREFIX) ||
    isKnownHarnessInjectedUserTurnText(text)
  )
}

function codexOutputText(output: unknown): string {
  if (typeof output === 'string') {
    // Why: function_call_output wraps shell results as a JSON string {output, metadata}.
    if (output.startsWith('{')) {
      try {
        const parsed = asRecord(JSON.parse(output))
        if (parsed && typeof parsed.output === 'string') {
          return parsed.output
        }
      } catch {
        // Not JSON after all; index it as text.
      }
    }
    return output
  }
  return textParts(output)
}

function codexLine(record: Record<string, unknown>, ts: number | null): TranscriptLineFacts {
  const facts: TranscriptLineFacts = { records: [], ts }
  const payload = asRecord(record.payload)
  if (!payload) {
    return facts
  }
  if (record.type === 'session_meta' || record.type === 'turn_context') {
    if (typeof payload.cwd === 'string') {
      facts.cwd = payload.cwd
    }
    return facts
  }
  if (record.type !== 'response_item') {
    return facts
  }
  switch (payload.type) {
    case 'message': {
      const text = textParts(payload.content)
      if (payload.role === 'user') {
        if (!isCodexInjected(text)) {
          const person = personText(text)
          if (person) {
            facts.records.push({ role: 'user', text: person, ts })
          }
        }
      } else if (payload.role === 'assistant' && text.trim()) {
        facts.records.push({ role: 'assistant', text: cap(text, ASSISTANT_TEXT_CAP), ts })
      }
      return facts
    }
    case 'function_call':
    case 'custom_tool_call': {
      const name = typeof payload.name === 'string' ? payload.name : 'tool'
      const input = payload.type === 'function_call' ? payload.arguments : payload.input
      let parsed: unknown = input
      if (typeof input === 'string' && input.startsWith('{')) {
        try {
          parsed = JSON.parse(input)
        } catch {
          parsed = input
        }
      }
      facts.records.push({ role: 'tool', text: summarizeToolInput(name, parsed), ts })
      return facts
    }
    case 'local_shell_call': {
      const action = asRecord(payload.action)
      const command = Array.isArray(action?.command) ? action.command.join(' ') : ''
      if (command) {
        facts.records.push({ role: 'tool', text: cap(`shell ${command}`, TOOL_INPUT_CAP), ts })
      }
      return facts
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const text = codexOutputText(payload.output)
      if (text.trim()) {
        facts.records.push({ role: 'tool', text: capToolOutput(text), ts, output: true })
      }
      return facts
    }
    default:
      return facts
  }
}

/** Parse one transcript line; null when it is not JSON. Never throws on odd shapes. */
export function readTranscriptLine(
  agent: SessionSearchAgent,
  line: string
): TranscriptLineFacts | null {
  if (!line.trim()) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  const record = asRecord(parsed)
  if (!record) {
    return null
  }
  const ts = parseTimestamp(record.timestamp)
  return agent === 'claude' ? claudeLine(record, ts) : codexLine(record, ts)
}
