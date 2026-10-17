/**
 * A menu the reply offers: a list, then a sentence that offers to act on some or all of it.
 *
 *   1. **A claims sheet per brand.** Prices, included settings …
 *   2. **A landing-page register.** …
 *   …
 *   I can write items 1, 2 and 4 now; they come from sources I've already checked.
 *
 * Every item becomes an option of one group (`optionGroup`), so the person can tick several and
 * send them as one message; the items the offer names ("1, 2 and 4") come pre-ticked
 * (`preselected`). Measured on Sal's Mac (2026-09-24): replies shaped like this produced no
 * next steps at all — the heading was not a next-steps heading, the list was read as prose, and
 * the offer sentence was dropped whole because a later clause said "already".
 */

import { NEXT_STEP_SUGGESTION_MAX } from './next-step-suggestions'

export type OfferedListCandidate = {
  text: string
  details: string[]
  offered: true
  preselected?: boolean
  optionGroup: string
}

type ListItem = { number: number; text: string; details: string[] }
type ParsedList = { start: number; end: number; items: ListItem[] }

const ITEM = /^(\s*)(?:([-*+•])|(\d{1,3})[.)])\s+(.*)$/
const QUOTED_OR_TABLE = /^\s*(?:>|\|)/

// Someone who would do the work: the agent offering, or asking to be asked.
const OFFER_SUBJECT =
  /\b(?:I(?:\s+can|\s+could|['’]ll|\s+will|['’]d\s+(?:start|begin|go|do|pick)|\s+would\s+(?:start|begin|go|do|pick))|(?:would you like|do you want|want) me to|should I|shall I|(?:happy|glad|ready) to)\b/i
// "items 1, 2 and 4", "options 2–3", "#1 and #3", "numbers 1 to 3".
const REFERENCE =
  /\b(?:items?|options?|numbers?|nos?\.|steps?|points?|ideas?)\s+#?(\d{1,2}(?:\s*(?:,|and|&|or|to|through|thru|[–-])\s*(?:and\s+)?#?\d{1,2})*)|#(\d{1,2}(?:\s*(?:,|and|&|or|[–-])\s*#?\d{1,2})*)/i
const WHOLE_LIST =
  /\b(?:any|all|some|each|either|both|one|more)\s+(?:of\s+)?(?:these|them|those|the above)\b/i
const ALL_OF_THEM = /\ball\s+(?:of\s+)?(?:these|them|those|the above)\b/i
// Asking the person to pick from the list: a "which of these …?" question, or "pick / tell me which".
const PICK_QUESTION =
  /\b(?:which|what)\s+(?:of\s+(?:these|them|those)|ones?|items?|options?)\b.*\?\s*$/i
const PICK_ASK = /\b(?:pick|choose|tell me which|let me know which)\b/i
const REPLY_NUMBERS =
  /^(?:please\s+)?reply\s+(?:with\s+)?\d{1,2}(?:\s*(?:,|and|or|\/)\s*(?:and\s+|or\s+)?\d{1,2})+[.!]?$/i
// A refusal in the offering clause itself; "already" elsewhere in the sentence is not one.
const REFUSAL =
  /\b(?:do not|don['’]t|should not|shouldn['’]t|never|cannot|can['’]t|(?:i|we) (?:won['’]t|will not)|not yet)\b/i

function plainText(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__/g, '')
    .replace(/(^|\s)[*_]([^*_\s][^*_]*)[*_](?=\s|[.,;:!?]|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
}

function linesOf(text: string): string[] {
  return text
    .slice(-24000)
    .replace(/```[\s\S]*?(?:```|$)/g, '\n\n')
    .replace(/`([^`]*)`/g, '$1')
    .split('\n')
}

/** Top-level lists with their numbering; sub-bullets and indented lines join the item above. */
function listsOf(lines: readonly string[]): ParsedList[] {
  const lists: ParsedList[] = []
  let current: (ParsedList & { indent: number }) | null = null
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) {
      continue
    }
    const item = QUOTED_OR_TABLE.test(line) ? null : ITEM.exec(line)
    const indent = line.length - line.trimStart().length
    if (item && (!current || item[1]!.length <= current.indent)) {
      current ??= { start: index, end: index, items: [], indent: item[1]!.length }
      if (!lists.includes(current)) {
        lists.push(current)
      }
      const number = item[3] ? Number(item[3]) : current.items.length + 1
      current.items.push({ number, text: item[4]!, details: [] })
      current.end = index
      continue
    }
    if (current && indent > current.indent && !QUOTED_OR_TABLE.test(line)) {
      current.items
        .at(-1)
        ?.details.push(plainText(line.replace(/^\s*(?:[-*+•]|\d{1,3}[.)])\s+/, '')))
      current.end = index
      continue
    }
    current = null
  }
  return lists.filter((list) => list.items.length >= 2)
}

/** "1, 2 and 4" → [1, 2, 4]; "2–4" → [2, 3, 4]. */
export function referencedNumbers(reference: string): number[] {
  const numbers = new Set<number>()
  const parts = reference.split(/\s*(?:,|\band\b|&|\bor\b)\s*/i)
  for (const part of parts) {
    const range = /#?(\d{1,2})\s*(?:to|through|thru|[–-])\s*#?(\d{1,2})/i.exec(part)
    if (range) {
      const [from, to] = [Number(range[1]), Number(range[2])]
      for (let n = Math.min(from, to); n <= Math.max(from, to) && numbers.size < 50; n++) {
        numbers.add(n)
      }
      continue
    }
    const single = /#?(\d{1,2})/.exec(part)
    if (single) {
      numbers.add(Number(single[1]))
    }
  }
  return [...numbers]
}

type Offer = { numbers: number[]; all: boolean }

/** The offer one sentence makes about a list, judged clause by clause; null when it makes none. */
export function listOfferOf(sentence: string): Offer | null {
  if (REPLY_NUMBERS.test(plainText(sentence))) {
    return { numbers: [], all: false }
  }
  const clauses = plainText(sentence).split(/\s*(?:;|\s[—–]\s|:\s)\s*/)
  for (const clause of clauses) {
    if (REFUSAL.test(clause)) {
      continue
    }
    const reference = REFERENCE.exec(clause)
    const subject = OFFER_SUBJECT.test(clause)
    if (reference && (subject || /\?\s*$/.test(clause))) {
      return { numbers: referencedNumbers(reference[1] ?? reference[2] ?? ''), all: false }
    }
    if (
      (subject && WHOLE_LIST.test(clause)) ||
      PICK_QUESTION.test(clause) ||
      PICK_ASK.test(clause)
    ) {
      return { numbers: [], all: subject && ALL_OF_THEM.test(clause) }
    }
  }
  return null
}

/** A bold lead ("**A landing-page register.** Which URL …") is the title; the rest is detail. */
function titled(item: ListItem): { title: string; details: string[] } {
  const bold = /^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*[:.—–-]?\s*(.*)$/.exec(item.text)
  if (bold) {
    const rest = plainText(bold[2]!)
    return {
      title: plainText(bold[1]!).replace(/[.:\s]+$/, ''),
      details: [rest, ...item.details].filter(Boolean)
    }
  }
  const text = plainText(item.text)
  const sentence = /^(.{12,120}?[.!?])\s+(\S.*)$/.exec(text)
  return sentence
    ? { title: sentence[1]!.replace(/\.$/, ''), details: [sentence[2]!, ...item.details] }
    : { title: text, details: item.details }
}

/**
 * The options of the last list the reply offered as a menu; empty when no sentence after a list
 * offers to act on it. Only prose after the list's end, before any later list, can offer it.
 */
export function offeredListCandidates(text: string): OfferedListCandidate[] {
  const lines = linesOf(text)
  const lists = listsOf(lines)
  for (let at = lists.length - 1; at >= 0; at--) {
    const list = lists[at]!
    const stop = lists[at + 1]?.start ?? lines.length
    const prose = lines
      .slice(list.end + 1, stop)
      .filter((line) => line.trim() && !QUOTED_OR_TABLE.test(line) && !ITEM.test(line))
      .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    const offer = prose.map(listOfferOf).find(Boolean)
    if (!offer) {
      continue
    }
    const group = `list-${list.start}`
    return list.items.slice(0, NEXT_STEP_SUGGESTION_MAX).map((item) => {
      const { title, details } = titled(item)
      const preselected = offer.all || offer.numbers.includes(item.number)
      return {
        text: title,
        details,
        offered: true as const,
        ...(preselected ? { preselected } : {}),
        optionGroup: group
      }
    })
  }
  return []
}
