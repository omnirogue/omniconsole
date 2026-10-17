import {
  AGENT_TEMPLATE_DEFAULT_ID,
  resolveAgentTemplates,
  type AgentTemplateSettings
} from './agent-templates'

/**
 * How dispatch paths carry a chosen agent template: resolved to its name and text, and joined to
 * the path's own prompt as one message with the task first.
 */

/** A chosen template as a dispatch path delivers it: its display name and its text. */
export type AgentTemplateText = { name: string; instructions: string }

/**
 * What a chosen template adds to a launch: `null` for Default, an id no longer in settings,
 * or a template left empty. An unknown id never falls back to another template's text.
 */
export function agentTemplateInstructions(
  settings: AgentTemplateSettings | undefined,
  id: string | null | undefined
): AgentTemplateText | null {
  if (!id || id === AGENT_TEMPLATE_DEFAULT_ID) {
    return null
  }
  const template = resolveAgentTemplates(settings).find((entry) => entry.id === id)
  const instructions = template?.instructions?.trim()
  return template && instructions ? { name: template.name, instructions } : null
}

const AGENT_TEMPLATE_DIVIDER = '\n\n---\n\n'
const AGENT_TEMPLATE_LEAD = 'Standing instructions for this session (agent template "'
/** The hook preview is cut at 200 characters; a cut lead line can only end a prompt this long. */
const HOOK_PREVIEW_MIN_CUT_LENGTH = 190
const TRUNCATED_LEAD_MIN_CHARS = 12

/**
 * The one message every dispatch path sends: the task first (hooks, names and previews read the
 * start of a prompt), then the template. Nothing typed sends the template's plain text alone.
 */
export function withAgentTemplateInstructions(
  prompt: string,
  template: AgentTemplateText | null
): string {
  const text = template?.instructions.trim()
  if (!template || !text) {
    return prompt
  }
  if (!prompt.trim()) {
    return text
  }
  return `${prompt}${AGENT_TEMPLATE_DIVIDER}${AGENT_TEMPLATE_LEAD}${template.name}"; follow them throughout):\n${text}`
}

/**
 * The task alone, for anything that reads a dispatched prompt as the person's words (naming).
 * Also handles the hook preview, which collapses whitespace and cuts at 200 characters, so the
 * block may arrive as ` --- Standing instr…` with its lead line itself truncated.
 */
export function withoutAgentTemplateInstructions(prompt: string): string {
  // Why the lead line and the last match: a `---` or a quoted block may sit in the task itself.
  const exact = prompt.lastIndexOf(`${AGENT_TEMPLATE_DIVIDER}${AGENT_TEMPLATE_LEAD}`)
  if (exact !== -1) {
    return prompt.slice(0, exact)
  }
  let cut = -1
  for (const match of prompt.matchAll(/\s+---\s+/g)) {
    const rest = prompt.slice(match.index + match[0].length)
    // Why the length checks: a lead cut mid-way only happens at the preview's 200-character end,
    // and a short tail like " --- S" is the person's own text, not a template block.
    const truncatedLead =
      prompt.length >= HOOK_PREVIEW_MIN_CUT_LENGTH &&
      rest.length >= TRUNCATED_LEAD_MIN_CHARS &&
      AGENT_TEMPLATE_LEAD.startsWith(rest)
    if (rest.startsWith(AGENT_TEMPLATE_LEAD) || truncatedLead) {
      cut = match.index
    }
  }
  return cut === -1 ? prompt : prompt.slice(0, cut)
}
