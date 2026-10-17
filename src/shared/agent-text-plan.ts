// A task list the agent wrote as prose, for agents that plan in text instead of a todo tool
// (Claude rarely calls TodoWrite; it writes "1. …" or "- [ ] …" in its reply). Deliberately
// conservative: only a markdown checklist, a numbered run starting at 1, or bullets under a
// "Todo:"/"Plan:" heading count, and only with at least two items. Anything else is not a plan.

import {
  AGENT_TODO_MAX_ITEMS,
  AGENT_TODO_MAX_TEXT,
  type AgentTodo,
  type AgentTodoStatus
} from './agent-todo-list'
import { isTextBlock, type NativeChatMessage } from './native-chat-types'

/** Fewer items than this is a sentence with a number in it, not a plan. */
export const AGENT_TEXT_PLAN_MIN_ITEMS = 2
/** How far back to look for a written plan, matching the structured-list scan. */
export const AGENT_TEXT_PLAN_SCAN_LIMIT = 300

const FENCE_RE = /^ {0,3}(?:```|~~~)/
const CHECKLIST_RE = /^ {0,3}[-*+]\s+\[([ xX✓✔])\]\s+(.+)$/
// Why at most one leading space: deeper numbering is a sub-list of the item above, not the plan.
const NUMBERED_RE = /^ ?(\d{1,3})[.)]\s+(.+)$/
const BULLET_RE = /^ ?[-*+]\s+(.+)$/
const INDENTED_RE = /^(?: {2,}|\t)\S/
const PLAN_HEADING_RE =
  /^ {0,3}(?:#{1,6}\s+)?(?:\*\*|__)?(?:to-?\s?dos?|plan|next steps|remaining(?: work)?|tasks)(?:\*\*|__)?\s*:?\s*(?:\*\*|__)?\s*$/i
// Why two of each: a global regex keeps `lastIndex` across `.test` calls, so tests use the plain one.
const DONE_MARK_RE = /[✅✔☑]\uFE0F?/u
const DONE_MARKS_RE = /[✅✔☑]\uFE0F?/gu
const CURRENT_MARK_RE = /[🔄⏳]\uFE0F?/u
const CURRENT_MARKS_RE = /[🔄⏳]\uFE0F?/gu
const DONE_SUFFIX_RE =
  /(?:\s*\((?:done|completed?)\)|\s*\[(?:done|completed?)\]|\s+[—–-]\s*(?:done|completed?)\.?|\s*:\s*(?:done|completed?)\.?)\s*$/i
const CURRENT_SUFFIX_RE = /\s*(?:\((?:in progress|doing now|current)\)|\[(?:in progress)\])\s*$/i
const STRUCK_RE = /^~~(.+)~~[.:]?$/

type RawItem = { text: string; status: AgentTodoStatus }

function cleanText(text: string): string {
  return text
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim()
}

/** An item's status from the marks the agent put on it; the marks are dropped from the text. */
function readMarkedItem(raw: string): RawItem | null {
  let text = raw.trim()
  let status: AgentTodoStatus = 'pending'
  const struck = STRUCK_RE.exec(text)
  if (struck) {
    text = struck[1]!
    status = 'completed'
  }
  if (DONE_MARK_RE.test(text)) {
    status = 'completed'
  }
  text = text.replace(DONE_MARKS_RE, ' ')
  if (DONE_SUFFIX_RE.test(text)) {
    status = 'completed'
    text = text.replace(DONE_SUFFIX_RE, '')
  }
  if (status === 'pending' && (CURRENT_MARK_RE.test(text) || CURRENT_SUFFIX_RE.test(text))) {
    status = 'current'
  }
  text = cleanText(text.replace(CURRENT_MARKS_RE, ' ').replace(CURRENT_SUFFIX_RE, ''))
  return text ? { text, status } : null
}

function checklistItem(match: RegExpExecArray): RawItem | null {
  const item = readMarkedItem(match[2]!)
  if (!item) {
    return null
  }
  return match[1] === ' ' ? item : { ...item, status: 'completed' }
}

/** Top-level lines outside code fences; a fenced block is code, never a plan. */
function planLines(text: string): string[] {
  const lines: string[] = []
  let fenced = false
  for (const line of text.split(/\r?\n/)) {
    if (FENCE_RE.test(line)) {
      fenced = !fenced
      continue
    }
    if (!fenced) {
      lines.push(line)
    }
  }
  return lines
}

/** Every run of "1. 2. 3." numbering; blank and indented lines continue a run, prose ends it. */
function numberedRuns(lines: readonly string[]): RawItem[][] {
  const runs: RawItem[][] = []
  let run: RawItem[] = []
  let expected = 1
  const close = (): void => {
    if (run.length > 0) {
      runs.push(run)
    }
    run = []
    expected = 1
  }
  for (const line of lines) {
    const match = NUMBERED_RE.exec(line)
    if (match) {
      const number = Number(match[1])
      if (number !== expected) {
        close()
        if (number !== 1) {
          continue
        }
      }
      const item = readMarkedItem(match[2]!)
      if (item) {
        run.push(item)
      }
      expected += 1
      continue
    }
    if (line.trim() === '' || INDENTED_RE.test(line)) {
      continue
    }
    close()
  }
  close()
  return runs
}

/** Bullets directly under a "Todo:" / "Plan:" / "Next steps:" heading. */
function headedBullets(lines: readonly string[]): RawItem[] {
  for (let index = 0; index < lines.length; index += 1) {
    if (!PLAN_HEADING_RE.test(lines[index]!)) {
      continue
    }
    const items: RawItem[] = []
    for (const line of lines.slice(index + 1)) {
      const match = BULLET_RE.exec(line)
      if (match) {
        const item = readMarkedItem(match[1]!)
        if (item) {
          items.push(item)
        }
        continue
      }
      if (line.trim() === '' || INDENTED_RE.test(line)) {
        continue
      }
      break
    }
    if (items.length >= AGENT_TEXT_PLAN_MIN_ITEMS) {
      return items
    }
  }
  return []
}

function bounded(items: readonly RawItem[]): readonly AgentTodo[] {
  return items.slice(0, AGENT_TODO_MAX_ITEMS).map((item) => ({
    text: item.text.slice(0, AGENT_TODO_MAX_TEXT),
    status: item.status
  }))
}

/**
 * The plan written in one message, or `[]`. A checklist wins over numbering (it carries real
 * ticks); numbering wins over headed bullets; the longest numbered run is the plan.
 */
export function parseAgentTextPlan(text: string): readonly AgentTodo[] {
  if (!text.trim()) {
    return []
  }
  const lines = planLines(text)
  const checklist: RawItem[] = []
  for (const line of lines) {
    const match = CHECKLIST_RE.exec(line)
    const item = match ? checklistItem(match) : null
    if (item) {
      checklist.push(item)
    }
  }
  if (checklist.length >= AGENT_TEXT_PLAN_MIN_ITEMS) {
    return bounded(checklist)
  }
  let longest: RawItem[] = []
  for (const run of numberedRuns(lines)) {
    if (run.length > longest.length) {
      longest = run
    }
  }
  if (longest.length >= AGENT_TEXT_PLAN_MIN_ITEMS) {
    return bounded(longest)
  }
  return bounded(headedBullets(lines))
}

/** The plan in the newest assistant message that wrote one, or `[]`. */
export function latestAssistantTextPlan(
  messages: readonly NativeChatMessage[],
  scanLimit = AGENT_TEXT_PLAN_SCAN_LIMIT
): readonly AgentTodo[] {
  const start = Math.max(0, messages.length - scanLimit)
  for (let index = messages.length - 1; index >= start; index -= 1) {
    const message = messages[index]
    if (!message || message.role !== 'assistant') {
      continue
    }
    const text = message.blocks
      .flatMap((block) => (isTextBlock(block) ? [block.text] : []))
      .join('\n')
    const plan = parseAgentTextPlan(text)
    if (plan.length > 0) {
      return plan
    }
  }
  return []
}
