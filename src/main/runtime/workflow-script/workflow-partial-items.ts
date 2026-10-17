import type { WorkflowProgramCall } from './workflow-program-context'
import { validateJsonSchema } from '../../../shared/json-schema-validate'

/** Complete list rows from an interrupted answer; never accepted as an attributable final turn. */
export function workflowPartialItems(stdout: string, call: WorkflowProgramCall): unknown[] {
  const properties = call.schema.properties
  const list = properties?.items
  if (list?.type !== 'array' || !list.items) {
    return []
  }
  const texts: string[] = []
  let streamed = ''
  for (const line of stdout.split('\n')) {
    try {
      const event = JSON.parse(line)
      if (event.type === 'stream_event' && event.event?.type === 'content_block_delta') {
        const delta = event.event.delta
        streamed +=
          delta.type === 'text_delta'
            ? (delta.text ?? '')
            : delta.type === 'input_json_delta'
              ? (delta.partial_json ?? '')
              : ''
      } else if (event.type === 'assistant') {
        for (const block of event.message?.content ?? []) {
          if (block.type === 'text') {
            texts.push(block.text)
          }
          if (block.type === 'tool_use' && block.name === 'StructuredOutput') {
            texts.push(JSON.stringify(block.input))
          }
        }
      } else if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        texts.push(event.item.text)
      } else if (event.type === 'result' && event.structured_output) {
        texts.push(JSON.stringify(event.structured_output))
      }
    } catch {
      // An incomplete provider event is not a complete item.
    }
  }
  texts.push(streamed)
  const found = new Map<string, unknown>()
  for (const text of texts) {
    const start = /"items"\s*:\s*\[/.exec(text)
    if (!start) {
      continue
    }
    let depth = 0
    let quoted = false
    let escaped = false
    let from = -1
    for (let at = start.index + start[0].length; at < text.length; at++) {
      const ch = text[at]
      if (quoted) {
        if (escaped) {
          escaped = false
        } else if (ch === '\\') {
          escaped = true
        } else if (ch === '"') {
          quoted = false
        }
        continue
      }
      if (ch === '"') {
        quoted = true
      } else if (ch === '{') {
        if (depth++ === 0) {
          from = at
        }
      } else if (ch === '}' && --depth === 0 && from !== -1) {
        try {
          const item = JSON.parse(text.slice(from, at + 1))
          if (
            !validateJsonSchema(list.items, item).length &&
            !call.validateSemantics({ items: [item] })
          ) {
            found.set(JSON.stringify(item), item)
          }
        } catch {
          // A truncated row stays out.
        }
      } else if (ch === ']' && depth === 0) {
        break
      }
    }
  }
  return [...found.values()].slice(0, typeof list.maxItems === 'number' ? list.maxItems : 64)
}
