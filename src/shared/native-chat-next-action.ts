import type { NativeChatMessage } from './native-chat-types'
import {
  NEXT_STEP_OPTION_PROMPT_LEAD,
  NEXT_STEP_PROMPT_MAX,
  NEXT_STEP_STEP_PROMPT_LEAD,
  NEXT_STEP_SUGGESTION_MAX,
  NEXT_STEP_TITLE_MAX,
  nextStepRiskOf,
  type NextStepKind,
  type NextStepSuggestion
} from './next-step-suggestions'
import { offeredListCandidates } from './next-step-offered-list'

// Earliest match in the text decides the kind.
const KINDS: readonly [NextStepKind, RegExp][] = [
  [
    'follow-up',
    /\b(?:giv\w*|hand\w*|delegat\w*|rout\w*|send\w*)\b.{0,100}\b(?:another|other|new|remote)?\s*(?:ai|agent|claude|codex)\b/i
  ],
  [
    'follow-up',
    /\b(?:giv\w*|hand\w*|send\w*|forward\w*)\b.{0,100}\b(?:person|human|uma|sal|team)\b/i
  ],
  ['ship', /\b(?:deploy(?:ing|ment)?|ship(?:ping)?|release)\b/i],
  ['fix', /\bfix(?:ing)?\b/i],
  ['continue', /\b(?:retry|try again|re-run|rerun)\b/i],
  [
    'verify',
    /\b(?:verif\w*|validat\w*|run(?:ning)? (?:the )?(?:full )?(?:tests?|test suite|suite))\b/i
  ],
  ['continue', /\bimplement(?:ing)?\b/i],
  ['review', /\b(?:review(?:ing)?|approv(?:e|ing|al))\b/i],
  ['follow-up', /\bsend(?:ing)?\b/i],
  ['continue', /\b(?:continu(?:e|ing)|proceed|carry on)\b/i]
]

// Codex's usual closing offer: "If you want, I can …", "Next, I can …", "I can also …".
const OFFER_OPENER =
  "(?:(?:if\\s+(?:you(?:['’]d|\\s+would)?\\s+(?:like|want|prefer)|(?:it['’]?s\\s+|that['’]?s\\s+)?(?:helpful|useful)|it\\s+helps|that\\s+helps)|next|from\\s+here)\\s*,?\\s*I\\s+can(?:\\s+also)?|I\\s+can\\s+also)"
const HEADING_WORDS = `(?:(?:recommended|suggested|proposed|possible)\\s+)?(?:next\\s+(?:steps?|actions?)|follow[- ]?ups?)|recommended(?:\\s+(?:steps?|actions?))?|what['’]s\\s+next|options|${OFFER_OPENER}`
const HEADING = new RegExp(
  `^\\s*(?:#{1,6}\\s+)?(?:\\*\\*|__)?\\s*(?:${HEADING_WORDS})\\s*(?:\\([^)]*\\))?\\s*(?:\\*\\*|__)?\\s*(:)?\\s*(?:\\*\\*|__)?\\s*(.*)$`,
  'i'
)
const OPENER_OFFER = new RegExp(`^${OFFER_OPENER}\\s+(.+)$`, 'i')
const ANY_HEADING = /^\s*(?:#{1,6}\s+\S|(?:\*\*|__)[^*_]+(?:\*\*|__)\s*:?\s*$)/
const ITEM = /^(\s*)(?:[-*+•]|\d{1,3}[.)])\s+(.*)$/
// "not" only counts when it negates the proposal itself, never in a trailing clause.
const NEGATION =
  /\b(?:do not|don['’]t|should not|shouldn['’]t|never|not yet|cannot|can['’]t|(?:i|we) (?:won['’]t|will not)|already|(?:recommend|suggest)(?:ing)?(?: that)?(?: we| you)? not)\b/i
// Match the whole statement so a trailing action still reaches the approval gates.
const NO_ACTION =
  /^(?:none(?: (?:needed|required|remaining))?|no (?:(?:further|additional|next) )?(?:steps?|actions?|follow[- ]?ups?|changes|work)(?: (?:needed|required|remaining))?|nothing (?:(?:else|more|further) )?(?:needed|required|to do))$/i
const LEADING_CONDITION = /^(?:if|unless|once|when|assuming|provided)\b/i
// Any wording here is a proposal on its own; the weak ones below must also name an action.
const STRONG_TRIGGER =
  /\b(?:I (?:recommend|suggest)|we should|next (?:step|action)|recommended|recommendation|(?:the )?(?:durable |recommended )?solution is to)\b/i
const WEAK_TRIGGER = /\b(?:I (?:can|should|could)|this needs)\b/i
const OFFER =
  /^(?:.*?\b)?(?:would you like me to|do you want me to|want me to|shall I|should I)\s+(.+?)\s*\?+$/i
// "My recommendation: …", "I recommend …", "…, I'd suggest that we …": only what follows is the step.
const RECOMMEND_LEAD =
  /^(?:(?:so|overall|then|now|here|instead)\s*,?\s+)?(?:(?:my|our|the)\s+recommendation(?:\s+(?:is|would be))?|what\s+I(?:['’]d|\s+would)?\s+(?:recommend|suggest)\s+is|I(?:['’]d|\s+would)?\s+(?:recommend|suggest))\s*[:,—–-]?\s*(?:that\s+)?(?:(?:we|you)\s+(?:should\s+)?)?(?:to\s+)?(\S.*)$/i
const RECOMMEND_AFTER_CLAUSE = /[,;:—–]\s*(I(?:['’]d|\s+would)?\s+(?:recommend|suggest)\b.*)$/i
const RECOMMEND_ANY = /\b(?:I(?:['’]d|\s+would)?\s+(?:recommend|suggest)|recommendation)\b/i
// A markdown table row or separator is data, never a step.
const TABLE_LINE = /^\s*\|/
const HASH_HEADING = /^\s*#{1,6}\s/
// A heading under which every item is the agent's own offer or option.
const OFFER_HEADING = new RegExp(
  `^\\s*(?:#{1,6}\\s+)?(?:\\*\\*|__)?\\s*(?:${OFFER_OPENER}|options)\\b`,
  'i'
)

function cleanMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__/g, '')
    .replace(/(^|\s)[*_]([^*_\s][^*_]*)[*_](?=\s|[.,;:!?]|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function kindOf(text: string): NextStepKind | null {
  return (
    KINDS.map(([kind, pattern]) => ({ kind, index: text.search(pattern) }))
      .filter((match) => match.index >= 0)
      .sort((a, b) => a.index - b.index)[0]?.kind ?? null
  )
}

/**
 * `offered`: the agent asked or offered it ("Should I …?", "If you want, I can …").
 * `optionGroup`/`preselected`: an item of a list the reply offered as a menu (next-step-offered-list).
 */
type Candidate = {
  text: string
  details: string[]
  offered?: boolean
  preselected?: boolean
  optionGroup?: string
}
type Proposal = { text: string; offered?: boolean }

const asOffers = (steps: string[]): Proposal[] => steps.map((text) => ({ text, offered: true }))

/** Alternatives joined by "or" / ";" become separate steps when each reads as a step. */
function offeredSteps(offer: string): string[] {
  const step = offer.replace(/[?.!\s]+$/, '')
  const parts = step.split(/\s*;\s*|,?\s+or\s+/i).map((part) => part.trim())
  const split = parts.length > 1 && parts.every((part) => part.split(/\s+/).length >= 2)
  return (split ? parts : [step]).map(capitalized)
}

/**
 * The step a recommendation names: undefined when the text recommends nothing, null when it only
 * mentions a recommendation ("So the rule I recommend is: …") rather than offering a step.
 */
function recommendedStep(source: string): string | null | undefined {
  if (!RECOMMEND_ANY.test(source)) {
    return undefined
  }
  const lead =
    RECOMMEND_LEAD.exec(source) ??
    RECOMMEND_LEAD.exec(RECOMMEND_AFTER_CLAUSE.exec(source)?.[1] ?? '')
  const step = lead?.[1]?.replace(/[.!\s]+$/, '').trim()
  return step && !/^is\b/i.test(step) ? capitalized(step) : null
}

/** The proposals in one prose sentence; none when it is not one. */
function sentenceCandidates(sentence: string): Proposal[] {
  const source = cleanMarkdown(sentence.replace(/^[\s#*\-\d.)]+/, ''))
  if (!source || NEGATION.test(source)) {
    return []
  }
  const opener = OPENER_OFFER.exec(source)
  if (opener) {
    return asOffers(offeredSteps(opener[1]!))
  }
  if (LEADING_CONDITION.test(source)) {
    return []
  }
  const offer = OFFER.exec(source)
  if (offer) {
    return asOffers(offeredSteps(offer[1]!))
  }
  const recommended = recommendedStep(source)
  if (recommended !== undefined) {
    return recommended ? [{ text: recommended }] : []
  }
  if (STRONG_TRIGGER.test(source) || (WEAK_TRIGGER.test(source) && kindOf(source))) {
    return [{ text: source }]
  }
  return []
}

/** A list item is a step unless it opens with a real condition; an offer opener is unwrapped. */
function itemSteps(text: string, offered = false): Proposal[] {
  const source = cleanMarkdown(text)
  const opener = OPENER_OFFER.exec(source)
  if (opener) {
    return asOffers(offeredSteps(opener[1]!))
  }
  if (LEADING_CONDITION.test(source)) {
    return []
  }
  // An item is a step already; a leading recommendation is only unwrapped.
  const lead = RECOMMEND_LEAD.exec(source)?.[1]
    ?.replace(/[.!\s]+$/, '')
    .trim()
  return [{ text: lead ? capitalized(lead) : text, ...(offered ? { offered } : {}) }]
}

function proseCandidates(line: string): Proposal[] {
  return line.split(/(?<=[.!?])\s+/).flatMap(sentenceCandidates)
}

/** Every proposal in document order: list items under a next-steps heading, then prose. */
function candidatesFromText(text: string): Candidate[] {
  const lines = text
    .slice(-24000)
    .replace(/```[\s\S]*?(?:```|$)/g, '\n\n')
    .replace(/`([^`]*)`/g, '$1')
    .split('\n')
  const found: Candidate[] = []
  // `indent` is set while inside a list that follows a next-steps heading.
  let list: { indent: number | null; current: Candidate | null; offered: boolean } | null = null
  for (const line of lines) {
    const tooLong = line.length > 600
    const quoted = /^\s*>/.test(line)
    if (list) {
      if (!line.trim()) {
        continue
      }
      const item = ITEM.exec(line)
      const indent = line.length - line.trimStart().length
      if (item && !quoted && (list.indent === null || item[1]!.length <= list.indent)) {
        list.indent ??= item[1]!.length
        const steps: Candidate[] = tooLong
          ? []
          : itemSteps(item[2]!, list.offered).map((step) => ({ ...step, details: [] }))
        found.push(...steps)
        // A dropped item's sub-bullets are dropped with it.
        list.current = steps.at(-1) ?? null
        continue
      }
      if (list.indent !== null && indent > list.indent && !quoted) {
        // Sub-bullets and indented continuation lines belong to the item above.
        list.current?.details.push(cleanMarkdown(line.replace(/^\s*(?:[-*+•]|\d{1,3}[.)])\s+/, '')))
        continue
      }
      list = null
    }
    if (quoted || tooLong || TABLE_LINE.test(line)) {
      continue
    }
    const heading = HEADING.exec(line)
    if (heading && !heading[2]!.trim()) {
      list = { indent: null, current: null, offered: OFFER_HEADING.test(line) }
      continue
    }
    // A markdown heading only ever opens a list; its own text is never a step.
    if (HASH_HEADING.test(line)) {
      continue
    }
    if (heading?.[1]) {
      found.push(
        ...itemSteps(heading[2]!, OFFER_HEADING.test(line)).map((step) => ({
          ...step,
          details: []
        }))
      )
      continue
    }
    if (ANY_HEADING.test(line)) {
      continue
    }
    found.push(...proseCandidates(line).map((candidate) => ({ ...candidate, details: [] })))
  }
  return found
}

function bounded(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

function normalized(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!?:;,\s]+$/, '')
    .trim()
}

/**
 * The agent's own proposed next steps in `text`, in document order. Reads only the assistant's
 * prose; never tool output or code. Text-based so the host can reuse it on a hook's last message.
 */
export function parsedNextStepSuggestionsFromText(
  text: string,
  messageId = ''
): NextStepSuggestion[] {
  const seen = new Map<string, NextStepSuggestion>()
  const suggestions: NextStepSuggestion[] = []
  // A list the reply offered as a menu ("I can write items 1, 2 and 4") IS the turn's set: its
  // items are the options, in the reply's order, and nothing else in the reply is read as a step.
  const menu = offeredListCandidates(text)
  for (const candidate of menu.length ? menu : candidatesFromText(text)) {
    const cleaned = capitalized(cleanMarkdown(candidate.text))
    const key = normalized(cleaned)
    const noAction = NO_ACTION.test(key) && candidate.details.every((detail) => !detail.trim())
    const earlier = seen.get(key)
    if (earlier && candidate.offered) {
      // The same step listed and then offered ("Want me to …?") is one step the agent asked about.
      earlier.offered = true
    }
    // A menu item is an option the agent offered by name; a negation word in it is not a refusal.
    if (!key || earlier || (!candidate.optionGroup && (NEGATION.test(cleaned) || noAction))) {
      continue
    }
    const title = bounded(cleaned, NEXT_STEP_TITLE_MAX)
    const details = candidate.details.filter(Boolean).map((detail) => `- ${detail}`)
    const lead = candidate.optionGroup ? NEXT_STEP_OPTION_PROMPT_LEAD : NEXT_STEP_STEP_PROMPT_LEAD
    const suggestion: NextStepSuggestion = {
      id: `${messageId}:${suggestions.length}`,
      title,
      prompt: bounded([`${lead}${cleaned}`, ...details].join('\n'), NEXT_STEP_PROMPT_MAX),
      risk: nextStepRiskOf([cleaned, ...candidate.details].join(' ')),
      kind: kindOf(cleaned) ?? 'other',
      ...(candidate.offered ? { offered: true as const } : {}),
      ...(candidate.preselected ? { preselected: true as const } : {}),
      ...(candidate.optionGroup ? { optionGroup: candidate.optionGroup } : {})
    }
    seen.set(key, suggestion)
    suggestions.push(suggestion)
    if (suggestions.length === NEXT_STEP_SUGGESTION_MAX) {
      break
    }
  }
  return suggestions
}

/** The latest assistant reply's suggestions; a later user message expires them. */
export function currentParsedNextStepSuggestions(
  messages: readonly NativeChatMessage[]
): { messageId: string; suggestions: NextStepSuggestion[] } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role === 'user') {
      return null
    }
    if (message.role !== 'assistant') {
      continue
    }
    const text = message.blocks
      .filter((block) => block.type === 'text' && !block.providerFrame)
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n')
    if (text.trim()) {
      const suggestions = parsedNextStepSuggestionsFromText(text, message.id)
      return suggestions.length ? { messageId: message.id, suggestions } : null
    }
  }
  return null
}
