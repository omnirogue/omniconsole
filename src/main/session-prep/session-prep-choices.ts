import {
  CLAUDE_SESSION_OPTION_CATALOG,
  CODEX_SESSION_OPTION_CATALOG
} from '../../shared/agent-session-option-catalog-claude-codex'
import { GEMINI_SESSION_OPTION_CATALOG } from '../../shared/agent-session-option-catalog-gemini-cursor'
import { normalizePrepText } from '../../shared/session-prep-prompt'
import type {
  PlannedItem,
  PrepAgentTemplateChoice,
  SessionPrepChoices,
  SessionPrepEffort
} from '../../shared/session-prep-types'
import { isTuiAgent } from '../../shared/tui-agent-config'
import type { TuiAgent } from '../../shared/tui-agent'
import { estateRouterModelAlias } from './session-prep-router-model-alias'

/**
 * Launch choices (agent, model, effort, folder) the planner read from the request. Each one must
 * be found in the person's own words, like an item's anchor: a choice the planner invented is
 * dropped, so a session never launches on something nobody asked for.
 */

export type RawPlannedChoices = {
  agent?: string
  model?: string
  effort?: string
  folder?: string
  host?: string
  agentTemplate?: string
}

const MAX_FOLDER_SEGMENTS = 6
const MAX_FOLDER_SEGMENT_CHARS = 100
const SAVED_SESSIONS_SEGMENT = 'saved sessions'

// Why spaces for punctuation: "x-high" and "OmniRogue/Prototypes" hold words a match may start at.
export function choiceWords(value: string): string {
  return normalizePrepText(value.replace(/[^\p{L}\p{N}\s]/gu, ' '))
}

function containsWords(haystack: string, needle: string): boolean {
  return needle !== '' && ` ${haystack} `.includes(` ${needle} `)
}

const LEVEL = '(xhigh|x high|extra high|maximum|max|medium|med|high|low)'
const LEVEL_THEN_WORD = new RegExp(
  `\\b${LEVEL} (?:reasoning )?(?:effort|reasoning|thinking)\\b`,
  'g'
)
const WORD_THEN_LEVEL = new RegExp(
  `\\b(?:effort|reasoning)(?: level)?(?: (?:of|at|to|on|is|set to))? ${LEVEL}\\b`,
  'g'
)
const LEVEL_ALIASES: Record<string, SessionPrepEffort> = {
  low: 'low',
  med: 'medium',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  'x high': 'xhigh',
  'extra high': 'xhigh',
  max: 'max',
  maximum: 'max'
}

/** Effort levels the person stated ("high effort", "effort: low", "xhigh", "max effort"). */
export function statedEfforts(text: string): Set<SessionPrepEffort> {
  const words = choiceWords(text)
  const found = new Set<SessionPrepEffort>()
  for (const pattern of [LEVEL_THEN_WORD, WORD_THEN_LEVEL]) {
    for (const match of words.matchAll(pattern)) {
      const level = LEVEL_ALIASES[match[1] ?? '']
      if (level) {
        found.add(level)
      }
    }
  }
  // Why bare xhigh: it is a level name and nothing else, so "run it on xhigh" states it.
  if (containsWords(words, 'xhigh')) {
    found.add('xhigh')
  }
  return found
}

// Why aliases: people name Claude by its models ("use opus"), Codex by its models ("astra 6", "sol 6.1"), and Gemini by its models ("gemini 4 argon", "gemini 3-8-flash").
const AGENT_WORDS: Partial<Record<TuiAgent, string[]>> = {
  claude: ['claude', 'claude code', 'opus', 'sonnet', 'haiku', 'fable'],
  codex: ['codex', 'gpt', 'astra', 'sol', 'terra', 'luna'],
  gemini: ['gemini', 'argon', 'gemini 4 argon', 'gemini 3 8 flash', '3 8 flash']
}

function agentNamed(agent: TuiAgent, words: string): boolean {
  const names = AGENT_WORDS[agent] ?? [choiceWords(agent)]
  return names.some((name) => containsWords(words, name))
}

/** The agent a model id belongs to, when it is one Claude, Codex, or Gemini is known to run. */
export function modelAgentFamily(model: string): TuiAgent | null {
  const canonical = (estateRouterModelAlias(model) ?? model).trim().toLowerCase()
  if (
    CLAUDE_SESSION_OPTION_CATALOG.models.some((entry) => entry.id === canonical) ||
    /^(claude|opus|sonnet|haiku|fable)\b/.test(canonical)
  ) {
    return 'claude'
  }
  if (
    CODEX_SESSION_OPTION_CATALOG.models.some((entry) => entry.id === canonical) ||
    /^(gpt|o\d|astra|sol|terra|luna)\b/.test(canonical)
  ) {
    return 'codex'
  }
  if (
    GEMINI_SESSION_OPTION_CATALOG.models.some((entry) => entry.id === canonical) ||
    /^(gemini|argon)\b/.test(canonical)
  ) {
    return 'gemini'
  }
  return null
}

// Why the label and last segment: "use sol 6.1" names gpt-6.1-sol and "gemini 4 argon" names gemini-4-argon; the launch needs the canonical id.
function modelNamed(model: string, words: string): boolean {
  const rawId = model.trim().toLowerCase()
  const id = (estateRouterModelAlias(rawId) ?? rawId).trim().toLowerCase()
  const catalogued = [
    ...CLAUDE_SESSION_OPTION_CATALOG.models,
    ...CODEX_SESSION_OPTION_CATALOG.models,
    ...GEMINI_SESSION_OPTION_CATALOG.models
  ]
    .filter((entry) => entry.id === id || entry.id === rawId)
    .map((entry) => entry.label)
  const lastSegment = id.includes('-') ? (id.split('-').at(-1) ?? '') : ''
  const extraAliases = [
    id === 'opus' ? ['opus 5 5', 'claude opus 5 5'] : [],
    id === 'gpt-6-astra' ? ['astra', 'astra 6', 'gpt 6 astra'] : [],
    id === 'gpt-6.1-sol' ? ['sol', 'sol 6 1', 'gpt 6 1 sol'] : [],
    id === 'gpt-6-luna' ? ['luna', 'luna 6', 'gpt 6 luna'] : [],
    id === 'gemini-4-argon' ? ['argon', 'gemini 4 argon', 'argon 4'] : [],
    id === 'gemini-3.8-flash' ? ['gemini 3 8 flash', '3 8 flash', 'gemini flash'] : []
  ].flat()
  return [
    rawId,
    id,
    ...catalogued,
    ...extraAliases,
    ...(lastSegment.length >= 3 ? [lastSegment] : [])
  ].some((name) => containsWords(words, choiceWords(name)))
}

/** "OmniRogue / Prototypes" from any spacing; null when a segment is missing from their words. */
function statedFolder(folder: string, words: string): string | null {
  const segments = folder
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
  if (
    segments.length === 0 ||
    segments.length > MAX_FOLDER_SEGMENTS ||
    segments.some((segment) => segment.length > MAX_FOLDER_SEGMENT_CHARS)
  ) {
    return null
  }
  const named = segments.every(
    (segment) =>
      choiceWords(segment) === SAVED_SESSIONS_SEGMENT || containsWords(words, choiceWords(segment))
  )
  return named ? segments.join(' / ') : null
}

/** The template's id when the planner named one that exists and whose name the person said. */
function statedAgentTemplate(
  raw: string | undefined,
  words: string,
  templates: readonly PrepAgentTemplateChoice[]
): string | null {
  const wanted = raw?.trim().toLowerCase()
  if (!wanted) {
    return null
  }
  const template = templates.find(
    (entry) => entry.id === wanted || entry.name.trim().toLowerCase() === wanted
  )
  if (!template) {
    return null
  }
  // Why: "Reviewer" and "Researcher" are ordinary words; only a name used as a template counts
  // ("the Reviewer template", "Reviewer instructions", "as Reviewer"), never "have a reviewer look".
  const name = choiceWords(template.name)
  const phrases = [
    `${name} template`,
    `${name} instructions`,
    `${name} agent instructions`,
    `${name} role`,
    `template ${name}`,
    `as ${name}`,
    `as the ${name}`,
    `as a ${name}`,
    `as ${name}s`,
    `${name} agent`,
    `${name} agents`,
    `${name} mode`,
    `${name} persona`,
    `using the ${name}`,
    `use the ${name}`
  ]
  return phrases.some((phrase) => containsWords(words, phrase)) ? template.id : null
}

/** Keeps each planner choice the person's words contain; anything else is dropped. */
export function sanitizePlannedChoices(
  raw: RawPlannedChoices | undefined,
  personText: string,
  agentTemplates: readonly PrepAgentTemplateChoice[] = []
): SessionPrepChoices | undefined {
  if (!raw) {
    return undefined
  }
  const words = choiceWords(personText)
  const choices: SessionPrepChoices = {}
  const agent = raw.agent?.trim().toLowerCase()
  if (agent && isTuiAgent(agent) && agentNamed(agent, words)) {
    choices.agent = agent
  }
  const model = raw.model?.trim()
  if (model && model.length <= 100 && modelNamed(model, words)) {
    const family = modelAgentFamily(model)
    // Why: "codex with opus" names two agents; launching either with the other's model fails.
    if (!choices.agent || !family || family === choices.agent) {
      choices.model = estateRouterModelAlias(model, family ?? choices.agent) ?? model
      if (!choices.agent && family) {
        choices.agent = family
      }
    }
  }
  const effort = LEVEL_ALIASES[choiceWords(raw.effort ?? '')]
  if (effort && statedEfforts(personText).has(effort)) {
    choices.effort = effort
  }
  const host = raw.host?.trim()
  if (host && host.length <= 200 && containsWords(words, choiceWords(host))) {
    choices.host = host
  }
  const folder = raw.folder ? statedFolder(raw.folder, words) : null
  if (folder) {
    choices.folder = folder
  }
  const template = statedAgentTemplate(raw.agentTemplate, words, agentTemplates)
  if (template) {
    choices.agentTemplate = template
  }
  return Object.keys(choices).length > 0 ? choices : undefined
}

/**
 * One effort named once in the request ("…, all on high effort") applies to every item when the
 * planner attached it to none. Why only then: an effort the planner placed is per item.
 */
export function withStatedBatchEffort(items: PlannedItem[], request: string): PlannedItem[] {
  if (items.some((item) => item.choices?.effort)) {
    return items
  }
  const stated = [...statedEfforts(request)]
  if (stated.length !== 1) {
    return items
  }
  const effort = stated[0]!
  return items.map((item) =>
    item.choices?.agent === 'gemini' ? item : { ...item, choices: { ...item.choices, effort } }
  )
}

/** Folded parts run as one session: the first part's choices win, the rest fill gaps. */
export function mergePlannedChoices(parts: PlannedItem[]): SessionPrepChoices | undefined {
  const merged: SessionPrepChoices = {}
  for (const part of parts.toReversed()) {
    Object.assign(merged, part.choices)
  }
  return Object.keys(merged).length > 0 ? merged : undefined
}
