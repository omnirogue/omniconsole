import type { NativeChatTextBlock } from './native-chat-types'

export type NativeChatPlanEntry = {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export type NativeChatPlan = {
  entries: NativeChatPlanEntry[]
  explanation?: string
}

const MAX_PLAN_ENTRIES = 128
const MAX_PLAN_TEXT_LENGTH = 32_000

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Provider snapshots replace the whole plan, including an explicitly empty plan. */
export function readNativeChatPlan(value: unknown): NativeChatPlan | null {
  const plan = record(value)
  if (!plan || !Array.isArray(plan.entries) || plan.entries.length > MAX_PLAN_ENTRIES) {
    return null
  }
  const explanation = typeof plan.explanation === 'string' ? plan.explanation.trim() : ''
  let textLength = explanation.length
  const entries: NativeChatPlanEntry[] = []
  for (const value of plan.entries) {
    const entry = record(value)
    const content = typeof entry?.content === 'string' ? entry.content.trim() : ''
    const status = entry?.status === 'inProgress' ? 'in_progress' : entry?.status
    if (!content || (status !== 'pending' && status !== 'in_progress' && status !== 'completed')) {
      return null
    }
    textLength += content.length
    entries.push({ content, status })
  }
  if (textLength > MAX_PLAN_TEXT_LENGTH) {
    return null
  }
  return { entries, ...(explanation ? { explanation } : {}) }
}

export function readCodexNativeChatPlan(value: unknown): NativeChatPlan | null {
  const payload = record(value)
  if (!payload || !Array.isArray(payload.plan)) {
    return null
  }
  return readNativeChatPlan({
    entries: payload.plan.map((value) => {
      const entry = record(value)
      return { content: entry?.step, status: entry?.status }
    }),
    explanation: payload.explanation
  })
}

/** Terminal transcripts already retain these explicit provider plan-tool calls. */
export function readNativeChatToolPlan(name: string, input: unknown): NativeChatPlan | null {
  if (name === 'update_plan' || name === 'functions.update_plan') {
    return readCodexNativeChatPlan(input)
  }
  if (name === 'TodoWrite' || name === 'todo_write') {
    const payload = record(input)
    return payload ? readNativeChatPlan({ entries: payload.todos }) : null
  }
  return null
}

/** Existing clients display the text; newer clients additionally render the typed checklist. */
export function nativeChatPlanBlock(plan: NativeChatPlan): NativeChatTextBlock {
  const lines = plan.entries.map((entry) => {
    const content = entry.content.replace(/\s*\n\s*/g, ' ')
    return entry.status === 'completed'
      ? `- [x] ${content}`
      : `- [ ] ${content}${entry.status === 'in_progress' ? ' (in progress)' : ''}`
  })
  return {
    type: 'text',
    text: [plan.explanation, lines.length > 0 ? lines.join('\n') : 'Plan cleared.']
      .filter(Boolean)
      .join('\n\n'),
    plan
  }
}
