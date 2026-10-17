import { isAbsolute, relative } from 'node:path'
import type { LocalWorkflowRoute } from '../../../shared/local-workflow-seats'
import type { WorkflowLiveUpdate } from './workflow-live-observer'

type Line = Record<string, unknown>
type Emit = (update: WorkflowLiveUpdate) => void
type Tokens = { input: number; output: number }

const THINKING = 'Thinking…'
const WRITING = 'Writing the answer'
/** Line breaks between two text blocks or messages, so "…is." and "Small…" never touch. */
const BLANK_LINE = 2

function record(value: unknown): Line | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Line) : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function clip(value: string): string {
  const single = value.replace(/\s+/g, ' ').trim()
  return single.length > 120 ? `${single.slice(0, 119)}…` : single
}

function displayPath(path: string, root: string | undefined): string {
  const inside = root && isAbsolute(path) ? relative(root, path) : ''
  return inside && !inside.startsWith('..') && !isAbsolute(inside) ? inside : path
}

/** How many line breaks sit at one edge of `value`: `/^\n+/` for its start, `/\n+$/` its end. */
const breaks = (value: string, edge: RegExp): number => edge.exec(value)?.[0].length ?? 0

/**
 * One attempt's streamed text as a single readable tail. `next()` marks where a new text block or
 * message starts; its first chunk is set apart from earlier text by a blank line, counting any
 * line breaks already at the join, so a break is never doubled. Nothing is added before the
 * first text or after the last.
 */
function paragraphs() {
  let end = ''
  let fresh = false
  return {
    next: () => {
      fresh = end !== ''
    },
    join: (chunk: string): string => {
      const missing = fresh ? BLANK_LINE - breaks(end, /\n+$/) - breaks(chunk, /^\n+/) : 0
      const joined = `${'\n'.repeat(Math.max(0, missing))}${chunk}`
      // The last two characters are enough to count the breaks at the next join.
      end = `${end}${joined}`.slice(-BLANK_LINE)
      fresh = false
      return joined
    }
  }
}

/** `/bin/zsh -lc "rg foo src"` becomes `rg foo src`. */
export function workflowShellCommand(command: string): string {
  const wrapped = /^\S*\/(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(command.trim())
  return (wrapped ? wrapped[2] : command).trim()
}

/** Short human line for one read-only tool call, e.g. "Reading src/app.ts". */
export function workflowToolActivity(name: string, input: Line | undefined, root?: string): string {
  const path =
    text(input?.file_path) ??
    text(input?.target_file) ??
    text(input?.path) ??
    text(input?.dir_path) ??
    text(input?.target_directory)
  const pattern = text(input?.pattern) ?? text(input?.query)
  const shown = path ? displayPath(path, root) : undefined
  switch (name.toLowerCase()) {
    case 'read':
    case 'read_file':
      return clip(shown ? `Reading ${shown}` : 'Reading files')
    case 'grep':
    case 'grep_search':
      return clip(pattern ? `Searching for ${pattern}` : 'Searching the code')
    case 'glob':
      return clip(pattern ? `Finding ${pattern}` : 'Finding files')
    case 'list_dir':
    case 'list_directory':
      return clip(shown ? `Listing ${shown}` : 'Listing files')
    case 'structuredoutput':
      return WRITING
    default:
      return clip(`Using ${name}`)
  }
}

function claudeStream(emit: Emit, root: string | undefined): (line: Line) => void {
  const blocks = new Map<number, string>()
  const tail = paragraphs()
  let done: Tokens = { input: 0, output: 0 }
  let current: Tokens = { input: 0, output: 0 }
  const tokens = () => ({ input: done.input + current.input, output: done.output + current.output })
  const onEvent = (event: Line) => {
    const index = count(event.index)
    const usage = record(event.usage) ?? record(record(event.message)?.usage)
    if (event.type === 'message_start') {
      blocks.clear()
      current = {
        input:
          count(usage?.input_tokens) +
          count(usage?.cache_creation_input_tokens) +
          count(usage?.cache_read_input_tokens),
        output: count(usage?.output_tokens)
      }
      emit({ tokens: tokens() })
    } else if (event.type === 'message_delta' && usage) {
      current = { ...current, output: count(usage.output_tokens) }
      emit({ tokens: tokens() })
    } else if (event.type === 'message_stop') {
      done = tokens()
      current = { input: 0, output: 0 }
    } else if (event.type === 'content_block_start') {
      const block = record(event.content_block)
      const kind = block?.type === 'tool_use' ? (text(block.name) ?? 'tool') : text(block?.type)
      blocks.set(index, kind ?? '')
      if (kind === 'thinking') {
        emit({ activity: THINKING })
      } else if (kind === 'text' || kind === 'StructuredOutput') {
        tail.next()
        emit({ activity: WRITING })
      }
    } else if (event.type === 'content_block_delta') {
      const delta = record(event.delta)
      const chunk =
        delta?.type === 'text_delta'
          ? text(delta.text)
          : delta?.type === 'input_json_delta' && blocks.get(index) === 'StructuredOutput'
            ? text(delta.partial_json)
            : undefined
      if (chunk) {
        emit({ text: tail.join(chunk) })
      }
    }
  }
  return (line) => {
    const event = record(line.event)
    if (line.type === 'stream_event' && event) {
      onEvent(event)
    } else if (line.type === 'assistant') {
      // Tool arguments are complete here; partial_json would have to be reassembled.
      const content = record(line.message)?.content
      for (const block of Array.isArray(content) ? content : []) {
        const tool = record(block)
        if (tool?.type === 'tool_use' && tool.name !== 'StructuredOutput') {
          emit({
            activity: workflowToolActivity(text(tool.name) ?? 'tool', record(tool.input), root)
          })
        }
      }
    } else if (line.type === 'user') {
      emit({ activity: THINKING })
    } else if (line.type === 'system' && line.subtype === 'permission_denied') {
      emit({ activity: clip(`Refused ${text(line.tool_name) ?? 'a tool'} (read-only)`) })
    }
  }
}

function codexStream(emit: Emit): (line: Line) => void {
  const tail = paragraphs()
  return (line) => {
    const item = record(line.item)
    if (line.type === 'turn.started') {
      emit({ activity: THINKING })
    } else if (line.type === 'item.started' && item?.type === 'command_execution') {
      emit({ activity: clip(`Running ${workflowShellCommand(text(item.command) ?? '')}`) })
    } else if (line.type === 'item.completed' && item) {
      // Every completed item is a whole message; it never runs into the one before it.
      tail.next()
      const message = text(item.text)
      if (item.type === 'agent_message' && message) {
        emit({ activity: WRITING, text: tail.join(message) })
      } else if (item.type === 'reasoning' || item.type === 'command_execution') {
        emit({ activity: THINKING, ...(message ? { text: tail.join(message) } : {}) })
      }
    } else if (line.type === 'turn.completed') {
      const usage = record(line.usage)
      emit({ tokens: { input: count(usage?.input_tokens), output: count(usage?.output_tokens) } })
    }
  }
}

function grokStream(emit: Emit, root: string | undefined): (line: Line) => void {
  let total: Tokens = { input: 0, output: 0 }
  const tail = paragraphs()
  return (line) => {
    const usage = record(line.usage)
    const data = text(line.data)
    if (line.type === 'usage' || line.type === 'tool_call' || line.type === 'tool_call_update') {
      // A usage line closes one model response and a tool call splits one; text after is new.
      tail.next()
    }
    if (line.type === 'thought') {
      emit({ activity: THINKING })
    } else if (line.type === 'text' && data) {
      emit({ activity: WRITING, text: tail.join(data) })
    } else if (line.type === 'tool_call') {
      const name = text(line.toolName) ?? text(line.title) ?? 'tool'
      emit({ activity: workflowToolActivity(name, record(line.rawInput), root) })
    } else if (line.type === 'tool_call_update' && line.status === 'completed') {
      emit({ activity: THINKING })
    } else if ((line.type === 'usage' || line.type === 'end') && usage) {
      const turn = {
        input:
          count(usage.input_tokens) +
          count(usage.cache_read_input_tokens) +
          count(usage.cache_creation_input_tokens),
        output: count(usage.output_tokens)
      }
      // Each usage line is one model response; the end line reports the run's own totals.
      total =
        line.type === 'end'
          ? turn
          : { input: total.input + turn.input, output: total.output + turn.output }
      emit({ tokens: total })
    }
  }
}

function geminiStream(emit: Emit, root: string | undefined): (line: Line) => void {
  const tail = paragraphs()
  return (line) => {
    const content = text(line.content)
    if (
      line.type === 'tool_use' ||
      line.type === 'tool_result' ||
      (line.type === 'message' && line.delta !== true)
    ) {
      // Deltas continue the current message; a tool event or a whole message starts a new one.
      tail.next()
    }
    if (line.type === 'init' || line.type === 'tool_result') {
      emit({ activity: THINKING })
    } else if (line.type === 'tool_use') {
      const name = text(line.tool_name) ?? 'tool'
      emit({ activity: workflowToolActivity(name, record(line.parameters), root) })
    } else if (line.type === 'message' && line.role === 'assistant' && content) {
      emit({ activity: WRITING, text: tail.join(content) })
    } else if (line.type === 'result') {
      const stats = record(line.stats)
      emit({ tokens: { input: count(stats?.input_tokens), output: count(stats?.output_tokens) } })
    }
  }
}

/** Drops updates that only repeat the current activity line. */
function withoutRepeats(emit: Emit): Emit {
  let activity: string | undefined
  return (update) => {
    if (update.text === undefined && update.tokens === undefined && update.activity === activity) {
      return
    }
    activity = update.activity ?? activity
    emit(update)
  }
}

/**
 * Parses one provider's streamed stdout, line by line, into live updates: what the agent is
 * doing, the text it is writing and the tokens so far. Advisory only; anything that is not a JSON
 * object (for example a legacy pretty-printed envelope) is ignored.
 */
export function createWorkflowLiveStream(
  route: LocalWorkflowRoute,
  emit: Emit,
  options: { root?: string } = {}
): (line: string) => void {
  const once = withoutRepeats(emit)
  const handle =
    route === 'openrouter' || route === 'ollama'
      ? (line: Line) => {
          if (line.type === 'init') {
            once({ activity: THINKING })
          }
          if (line.type === 'tool') {
            once({ activity: clip(text(line.name) ?? 'Reading workspace') })
          }
          if (line.type === 'result') {
            const usage = record(line.usage) ?? {}
            once({
              activity: WRITING,
              text: text(line.text),
              tokens: { input: count(usage.input_tokens), output: count(usage.output_tokens) }
            })
          }
        }
      : route === 'claude'
        ? claudeStream(once, options.root)
        : route === 'codex'
          ? codexStream(once)
          : route === 'grok'
            ? grokStream(once, options.root)
            : geminiStream(once, options.root)
  return (line) => {
    if (!line.trimStart().startsWith('{')) {
      return
    }
    let parsed: Line | undefined
    try {
      parsed = record(JSON.parse(line))
    } catch {
      return
    }
    if (parsed) {
      handle(parsed)
    }
  }
}
