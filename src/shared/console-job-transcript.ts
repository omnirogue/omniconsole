import type { ConsoleJobEvidenceEntry } from './console-job-evidence'
import type { NativeChatBlock, NativeChatMessage } from './native-chat-types'

type RecordValue = Record<string, unknown>
const record = (value: unknown): RecordValue | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : null

function text(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value)
}

/** The runner may split a large provider record; only a contiguous, final record is decoded. */
export function assembleJobEvidenceRecords(entries: readonly ConsoleJobEvidenceEntry[]): {
  records: ConsoleJobEvidenceEntry[]
  pending: number
} {
  const records: ConsoleJobEvidenceEntry[] = []
  const parts = new Map<number, ConsoleJobEvidenceEntry[]>()
  for (const entry of entries) {
    if (entry.record_id === undefined) {
      records.push(entry)
    } else {
      const group = parts.get(entry.record_id) ?? []
      group.push(entry)
      parts.set(entry.record_id, group)
    }
  }
  let pending = 0
  for (const group of parts.values()) {
    const ordered = [...group].sort((left, right) => (left.part ?? 0) - (right.part ?? 0))
    if (
      !ordered.at(-1)?.final ||
      ordered.some(
        (entry, index) =>
          entry.part !== index ||
          entry.kind !== ordered[0].kind ||
          (index < ordered.length - 1 && entry.final)
      )
    ) {
      pending += 1
      continue
    }
    records.push({ ...ordered[0], text: ordered.map((entry) => entry.text).join('') })
  }
  return { records: records.sort((left, right) => left.id - right.id), pending }
}

function contentBlocks(content: unknown): NativeChatBlock[] {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : []
  }
  if (!Array.isArray(content)) {
    return []
  }
  return content.flatMap((value): NativeChatBlock[] => {
    const block = record(value)
    if (!block) {
      return []
    }
    if (['text', 'input_text', 'output_text', 'thinking'].includes(String(block.type))) {
      const body = text(block.text ?? block.thinking)
      return body ? [{ type: 'text', text: body }] : []
    }
    if (block.type === 'tool_use') {
      return [{ type: 'tool-call', name: text(block.name) || 'Tool', input: block.input }]
    }
    if (block.type === 'tool_result') {
      return [
        { type: 'tool-result', output: text(block.content), isError: block.is_error === true }
      ]
    }
    return [{ type: 'tool-result', output: text(block) }]
  })
}

function message(
  entry: ConsoleJobEvidenceEntry,
  role: NativeChatMessage['role'],
  blocks: NativeChatBlock[]
): NativeChatMessage {
  const at = Date.parse(entry.at)
  return {
    id: `evidence:${entry.id}`,
    role,
    blocks,
    timestamp: Number.isFinite(at) ? at : null,
    source: 'transcript'
  }
}

function providerMessage(entry: ConsoleJobEvidenceEntry): NativeChatMessage | null {
  let event: RecordValue | null = null
  try {
    event = record(JSON.parse(entry.text))
  } catch {
    /* Plain provider output remains readable. */
  }
  if (!event) {
    return message(entry, 'system', [{ type: 'text', text: entry.text }])
  }
  const nested = record(event.message)
  const role = nested?.role ?? event.role ?? event.type
  if (role === 'user' || role === 'assistant') {
    const blocks = contentBlocks(nested?.content ?? event.content)
    if (blocks.length) {
      return message(
        entry,
        role === 'user' && blocks.every((block) => block.type === 'tool-result') ? 'tool' : role,
        blocks
      )
    }
  }
  const item = record(event.item)
  if (event.type === 'item.completed' && item) {
    if (item.type === 'agent_message') {
      return message(entry, 'assistant', [{ type: 'text', text: text(item.text) }])
    }
    if (item.type === 'reasoning') {
      return message(entry, 'reasoning', [{ type: 'text', text: text(item.text) }])
    }
    if (item.type === 'command_execution') {
      return message(entry, 'tool', [
        { type: 'tool-call', name: 'Command', input: item.command },
        {
          type: 'tool-result',
          output: text(item.aggregated_output),
          isError: Number(item.exit_code) > 0
        }
      ])
    }
    if (item.type === 'mcp_tool_call') {
      return message(entry, 'tool', [
        { type: 'tool-call', name: text(item.tool), input: item.arguments },
        {
          type: 'tool-result',
          output: text(item.result ?? item.error),
          isError: Boolean(item.error)
        }
      ])
    }
  }
  // Lifecycle frames stay in the raw session log; they do not invent conversation turns.
  if (
    ['system', 'thread.started', 'turn.started', 'turn.completed', 'result'].includes(
      String(event.type)
    )
  ) {
    return null
  }
  return message(entry, 'tool', [{ type: 'tool-result', output: entry.text }])
}

/** Actual captured input and provider records, rendered with the conversation's existing message view. */
export function jobEvidenceTranscript(entries: readonly ConsoleJobEvidenceEntry[]): {
  messages: NativeChatMessage[]
  pending: number
} {
  const { records, pending } = assembleJobEvidenceRecords(entries)
  const messages: NativeChatMessage[] = []
  let previousInput = false
  for (const entry of records) {
    if (entry.kind === 'input') {
      const previous = messages.at(-1)?.blocks[0]
      // The capture transport splits on newlines; a submitted prompt remains one user turn.
      if (previousInput && previous?.type === 'text') {
        previous.text += entry.text
      } else {
        messages.push(message(entry, 'user', [{ type: 'text', text: entry.text }]))
      }
      previousInput = true
    } else {
      previousInput = false
      if (entry.kind === 'provider_event') {
        const parsed = providerMessage(entry)
        if (parsed) {
          messages.push(parsed)
        }
      }
    }
  }
  return { pending, messages }
}
