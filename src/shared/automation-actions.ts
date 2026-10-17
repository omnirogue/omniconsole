export type AutomationAction = {
  id: string
  kind: 'pause' | 'activate'
  label: string
  nativeId: string
  objectType?: 'adset' | 'ad' | 'campaign'
  account?: string
  name?: string
  from?: string
  to?: string
  reason?: string
  impact?: string
}

function isAction(value: unknown): value is AutomationAction {
  if (!value || typeof value !== 'object') {
    return false
  }
  const entry = value as Record<string, unknown>
  return (
    ['id', 'label', 'nativeId'].every(
      (key) => typeof entry[key] === 'string' && entry[key].trim().length > 0
    ) &&
    (entry.kind === 'pause' || entry.kind === 'activate') &&
    (entry.objectType === undefined ||
      (typeof entry.objectType === 'string' &&
        ['adset', 'ad', 'campaign'].includes(entry.objectType))) &&
    ['account', 'name', 'from', 'to', 'reason', 'impact'].every(
      (key) => entry[key] === undefined || typeof entry[key] === 'string'
    )
  )
}

/** Terminal gutter (`│`) and indentation a captured pane adds in front of every line. */
export function stripAutomationActionsGutter(line: string): string {
  return line.replace(/^[\s│]+/, '')
}

/**
 * Line span of the LAST fenced `omni-actions` block: `start` is the opening fence line,
 * `end` the closing fence, or null when the last opening fence is never closed.
 */
export function locateAutomationActionsBlock(
  lines: readonly string[]
): { start: number; end: number | null } | null {
  const stripped = lines.map(stripAutomationActionsGutter)
  const start = stripped.findLastIndex((line) => /^```omni-actions\s*$/i.test(line))
  if (start === -1) {
    return null
  }
  const end = stripped.findIndex((line, index) => index > start && /^```\s*$/.test(line))
  return { start, end: end === -1 ? null : end }
}

/**
 * A terminal soft-wraps long JSON string values at ~80 columns and indents the continuation
 * (measured 2026-09-20: `"name": "… — AS04-\n        WhoElseWantsSeedance25"`). Inside a
 * string literal a line break is a wrap, never content: join it with a space when the
 * string otherwise contains spaces (prose), with nothing when it does not (an id).
 */
function joinSoftWrappedStrings(json: string): string {
  return json.replace(/"(?:\\.|[^"\\])*"/g, (quoted) => {
    if (!/\n/.test(quoted)) {
      return quoted
    }
    const WRAP = '\u0000'
    const marked = quoted.replace(/[ \t]*\n[ \t]*/g, WRAP)
    return marked.split(WRAP).join(/[ \t]/.test(marked) ? ' ' : '')
  })
}

export function parseAutomationActions(content: string): {
  actions: AutomationAction[]
  error: string | null
} {
  const lines = content.split(/\r?\n/)
  const block = locateAutomationActionsBlock(lines)
  if (!block) {
    return { actions: [], error: null }
  }
  if (block.end === null) {
    return { actions: [], error: 'Unclosed omni-actions block.' }
  }
  const json = lines
    .slice(block.start + 1, block.end)
    .map(stripAutomationActionsGutter)
    .join('\n')
  let parsed: unknown
  try {
    try {
      parsed = JSON.parse(json)
    } catch {
      parsed = JSON.parse(joinSoftWrappedStrings(json))
    }
  } catch {
    return { actions: [], error: 'Invalid omni-actions JSON.' }
  }
  if (!Array.isArray(parsed)) {
    return { actions: [], error: 'Expected an omni-actions array.' }
  }
  const actions: AutomationAction[] = []
  const invalid: number[] = []
  const ids = new Set<string>()
  parsed.forEach((entry, index) => {
    if (!isAction(entry) || ids.has(entry.id)) {
      invalid.push(index + 1)
    } else {
      ids.add(entry.id)
      actions.push(entry)
    }
  })
  return {
    actions,
    error: invalid.length ? `Invalid omni-actions entries: ${invalid.join(', ')}.` : null
  }
}

export function buildAutomationApplyPrompt(
  actions: AutomationAction[],
  basePrompt: string
): string {
  return `APPLY:\n\`\`\`omni-actions\n${JSON.stringify(actions, null, 2)}\n\`\`\`\n\n${basePrompt}`
}
