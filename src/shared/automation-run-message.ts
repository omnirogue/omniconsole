import {
  locateAutomationActionsBlock,
  parseAutomationActions,
  type AutomationAction
} from './automation-actions'
import {
  hasAutomationTerminalChrome,
  stripAutomationTerminalChrome
} from './automation-terminal-chrome'

export const AUTOMATION_RUN_MESSAGE_MAX_CHARS = 24_000
const TAIL_CHARS = 6_000
const TRIM_MARKER = '\n\n[… output trimmed …]\n\n'

/** What the run's recommendation block turned out to be, for copy that never shows code. */
export type AutomationRunRecommendations =
  /** No block at all. */
  | 'none'
  /** A block whose array is empty: the agent recommends no change. */
  | 'empty'
  /** At least one action parsed. */
  | 'ready'
  /** A block was there but could not be parsed, or sat inside a terminal scrape. */
  | 'unreadable'

export type AutomationRunMessage = {
  /** The message to render: chrome stripped, block removed, head+tail trimmed. */
  text: string
  actions: AutomationAction[]
  recommendations: AutomationRunRecommendations
  /** True when the recorded output was a terminal screen scrape, not the agent's message. */
  scraped: boolean
}

function trimHeadAndTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text
  }
  const tail = text.slice(text.length - Math.min(TAIL_CHARS, maxChars - TRIM_MARKER.length))
  const head = text.slice(0, Math.max(0, maxChars - TRIM_MARKER.length - tail.length))
  return `${head.trimEnd()}${TRIM_MARKER}${tail.trimStart()}`
}

/**
 * Reads a run's recorded output the way the UI must show it. The block is located BEFORE
 * trimming so a cut can never land inside the fence, and a screen scrape is never parsed
 * for actions: the fence the TUI echoed may belong to the previous run or to the APPLY
 * prompt itself.
 */
export function readAutomationRunMessage(
  content: string,
  options: { maxChars?: number } = {}
): AutomationRunMessage {
  const maxChars = options.maxChars ?? AUTOMATION_RUN_MESSAGE_MAX_CHARS
  const lines = content.split(/\r?\n/)
  const block = locateAutomationActionsBlock(lines)
  if (hasAutomationTerminalChrome(content)) {
    return {
      text: trimHeadAndTail(stripAutomationTerminalChrome(content), maxChars),
      actions: [],
      recommendations: block ? 'unreadable' : 'none',
      scraped: true
    }
  }
  if (!block) {
    return {
      text: trimHeadAndTail(content.trim(), maxChars),
      actions: [],
      recommendations: 'none',
      scraped: false
    }
  }
  const { actions, error } = parseAutomationActions(content)
  const withoutBlock = [
    ...lines.slice(0, block.start),
    ...(block.end === null ? [] : lines.slice(block.end + 1))
  ]
    .join('\n')
    .trim()
  return {
    text: trimHeadAndTail(withoutBlock, maxChars),
    actions,
    recommendations: actions.length ? 'ready' : error ? 'unreadable' : 'empty',
    scraped: false
  }
}
