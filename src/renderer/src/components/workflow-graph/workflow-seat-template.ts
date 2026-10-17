import type { AgentTemplate } from '../../../../shared/agent-templates'
import { WORKFLOW_MAX_SYSTEM_CHARS } from '../../../../shared/workflow-graph'

// Why trimmed after the cut: the seat's normalizer trims, so a cut ending in whitespace must still match.
const seatText = (text: string): string => text.trim().slice(0, WORKFLOW_MAX_SYSTEM_CHARS).trimEnd()

/** The template a seat's system prompt came from, or null when it is empty or the person's own text. */
export function workflowSeatTemplate(
  templates: readonly AgentTemplate[],
  system: string | undefined
): AgentTemplate | null {
  const current = seatText(system ?? '')
  if (!current) {
    return null
  }
  return (
    templates.find((template) =>
      template.instructions ? seatText(template.instructions) === current : false
    ) ?? null
  )
}

/** What a seat's system prompt becomes for a template: its text, cut where the seat cuts it. */
export function workflowSeatSystemFor(template: AgentTemplate | undefined): {
  system: string
  cut: boolean
} {
  const text = template?.instructions?.trim() ?? ''
  return { system: seatText(text), cut: text.length > WORKFLOW_MAX_SYSTEM_CHARS }
}
