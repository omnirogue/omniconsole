import type { LocalWorkflowRoute } from '../../../shared/local-workflow-seats'

/** Longest string a stored tool-output field keeps. */
export const WORKFLOW_STORED_FIELD_LIMIT = 2048

type Event = Record<string, unknown>

function record(value: unknown): Event | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Event) : undefined
}

function clipText(value: string): string {
  const omitted = value.length - WORKFLOW_STORED_FIELD_LIMIT
  return omitted > 0
    ? `${value.slice(0, WORKFLOW_STORED_FIELD_LIMIT)}… [${omitted} more characters not stored]`
    : value
}

/** Clips long strings anywhere in a value; returns the same reference when nothing changed. */
function clipStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    return clipText(value)
  }
  if (Array.isArray(value)) {
    const next = value.map(clipStrings)
    return next.every((item, index) => item === value[index]) ? value : next
  }
  const object = record(value)
  if (!object) {
    return value
  }
  let changed = false
  const entries = Object.entries(object).map(([key, item]) => {
    const next = clipStrings(item)
    changed ||= next !== item
    return [key, next] as const
  })
  return changed ? Object.fromEntries(entries) : value
}

function storedEvent(route: LocalWorkflowRoute, event: Event): Event | null {
  // Partial deltas and reasoning ticks are replayed in full elsewhere (assistant/end lines).
  if (route === 'claude' && event.type === 'stream_event') {
    const delta = record(record(event.event)?.delta)
    return delta?.type === 'text_delta' || delta?.type === 'input_json_delta' ? event : null
  }
  if (route === 'grok' && (event.type === 'thought' || event.type === 'available_commands')) {
    return null
  }
  const bulky =
    (route === 'claude' && event.type === 'user') ||
    (route === 'codex' && record(event.item)?.type === 'command_execution') ||
    (route === 'grok' && event.type === 'tool_call_update') ||
    (route === 'gemini' &&
      ((event.type === 'message' && event.role === 'user') || event.type === 'tool_result'))
  return bulky ? (clipStrings(event) as Event) : event
}

/**
 * The form of one stdout line the receipt keeps. File contents, command output and the echoed
 * prompt are clipped and streaming deltas dropped, so real workspaces fit the cap. Everything the
 * parsers read (result and end lines, agent messages, answer text, tool boundaries) stays whole;
 * other lines are stored byte for byte.
 */
export function storedWorkflowLine(route: LocalWorkflowRoute, line: string): string | null {
  let event: Event | undefined
  try {
    event = record(JSON.parse(line))
  } catch {
    return line
  }
  if (!event) {
    return line
  }
  const stored = storedEvent(route, event)
  return stored === event ? line : stored && JSON.stringify(stored)
}
