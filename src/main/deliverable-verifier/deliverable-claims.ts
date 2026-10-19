/**
 * Reads deliverables out of plain words, conservatively: a false alarm here becomes a prompt the
 * agent did not need. Only a path or link in an output sentence counts — paths in fenced code,
 * command examples, or negated, conditional or future sentences never do.
 */

import type { DeliverableClaim, DeliverableKind } from '../../shared/deliverable-verification-types'

export type ExtractedDeliverable = {
  target: string
  kind: DeliverableKind
  claim: DeliverableClaim
  /** The reply's own words declining it, clipped. */
  declined?: string
}

const MAX_TEXT = 64_000
const MAX_ITEMS = 24
const DECLINE_TEXT_MAX = 200

const FENCE = /^\s*(```|~~~)[\s\S]*?^\s*\1[^\n]*$/gm
const COMMAND_LINE = /^\s*(?:\$|>|PS [A-Z]:\\[^>]*>)\s.*$/gm
const BACKTICK = /`([^`\n]{1,400})`/g
const MARKDOWN_LINK = /\[[^\]\n]{0,200}\]\(([^()\s]{1,400})\)/g
const URL = /\bhttps?:\/\/[^\s<>()`'"\]]{1,400}/g
const ABSOLUTE =
  /(?:^|[\s(:"'])((?:~|\/)(?:[\w.@+~-]+\/)*[\w.@+~-]+\/?|[A-Za-z]:\\(?:[\w.@+~ -]+\\)*[\w.@+~-]+)/g
const RELATIVE =
  /(?:^|[\s(:"'])((?:\.{1,2}\/)?[\w.@+-]+(?:\/[\w.@+-]+)+\.[A-Za-z0-9]{1,8})(?=$|[\s),.;:!?"'])/g

const OUTPUT_VERB =
  /\b(?:save|write|create|put|store|output|export|draft|design|produce|generate|publish|record|place)\b/i
const OUTPUT_PREPOSITION =
  /\b(?:save|saved|write|written|create|put|store|output|export|draft|design|produce|generate|record|place)\b[^.!?\n]{0,160}?\b(?:to|at|in|into|as|under)\s*[`"'([]*$/i
const OUTPUT_OBJECT =
  /\b(?:create|write|save|export|produce|generate|draft)\s+(?:a\s+|an\s+|the\s+|new\s+)*(?:file\s+)?[`"'([]*$/i
const CLAIM_VERB =
  /\b(saved|wrote|written|created|added|updated|edited|changed|modified|generated|exported|stored|published|shared|uploaded|deployed|posted)\b/i
// A claim verb in "will be created", "should be updated", "needs to be written" is not a claim.
const MODAL_BEFORE_VERB =
  /\b(?:will|would|could|should|shall|might|may|can|must|needs?\s+to|going\s+to|have\s+to|to)\s+(?:not\s+)?(?:be|have(?:\s+been)?|get)\s+(?:\w+\s+)?$/i
const CONDITIONAL_LEAD =
  /^(?:(?:[-*+]|\d+[.)])\s+)?(?:if|once|when|unless|after|before|next|then)\b/i
const DECLINE =
  /\b(?:couldn'?t|could not|can'?t|cannot|unable to|did not|didn'?t|was not able|wasn'?t able|not able to|failed to|skipped|not (?:yet )?(?:created|written|saved|published|done))\b/i
const PUBLISH_VERB = /\b(?:published|shared|uploaded|deployed|posted)\b/i
const UPDATE_VERB = /\b(?:updated|edited|changed|modified)\b/i

function withoutCode(text: string): string {
  return text.slice(0, MAX_TEXT).replace(FENCE, '\n').replace(COMMAND_LINE, '')
}

/** A backticked span that names one path, not a command or a snippet. */
function backtickPath(span: string): string | null {
  const value = span.trim().replace(/:\d+(?::\d+)?$/, '')
  if (!value || /[*?<>|&;$=]|\.\.\.|^-|\s-/.test(value)) {
    return null
  }
  const absolute = /^(?:~?\/|[A-Za-z]:[\\/])/.test(value)
  if (/\s/.test(value) && !absolute) {
    return null
  }
  if (absolute || /[\\/]/.test(value)) {
    return value
  }
  return /^[\w.@+-]+\.[A-Za-z0-9]{1,8}$/.test(value) ? value : null
}

function trimUrl(url: string): string {
  return url.replace(/[).,;:!?]+$/, '')
}

function kindOf(target: string): DeliverableKind {
  if (/^https?:\/\//i.test(target)) {
    return /\/a\/[A-Za-z0-9_-]{6,}/.test(target) ? 'artifact' : 'url'
  }
  return /[\\/]$/.test(target) ? 'directory' : 'file'
}

type Found = { target: string; index: number }

/** Every path or link in one sentence, in order, each once. */
function targetsIn(sentence: string): Found[] {
  const found: Found[] = []
  const taken: [number, number][] = []
  // A code span or link is read whole or not at all: a rejected one is never re-scanned for paths.
  const add = (target: string | null, index: number, length: number): void => {
    if (taken.some(([start, end]) => index < end && index + length > start)) {
      return
    }
    taken.push([index, index + length])
    if (target) {
      found.push({ target, index })
    }
  }
  for (const match of sentence.matchAll(MARKDOWN_LINK)) {
    const raw = match[1]!
    add(/^https?:/i.test(raw) ? trimUrl(raw) : backtickPath(raw), match.index!, match[0].length)
  }
  for (const match of sentence.matchAll(BACKTICK)) {
    const raw = match[1]!.trim()
    add(/^https?:/i.test(raw) ? trimUrl(raw) : backtickPath(raw), match.index!, match[0].length)
  }
  for (const match of sentence.matchAll(URL)) {
    add(trimUrl(match[0]), match.index!, match[0].length)
  }
  for (const pattern of [ABSOLUTE, RELATIVE]) {
    for (const match of sentence.matchAll(pattern)) {
      const start = match.index! + match[0].indexOf(match[1]!)
      add(match[1]!.replace(/[.,;:!?]+$/, ''), start, match[1]!.length)
    }
  }
  return found.sort((a, b) => a.index - b.index)
}

/** The sentence with its code spans, links and paths blanked, so a verb is read from the words. */
function wordsOnly(sentence: string): string {
  return sentence
    .replace(MARKDOWN_LINK, ' LINK ')
    .replace(BACKTICK, ' CODE ')
    .replace(URL, ' LINK ')
    .replace(ABSOLUTE, ' PATH ')
    .replace(RELATIVE, ' PATH ')
}

/** Sentences, keeping list items whole; a "verb ...:" lead-in carries into its list. */
function sentences(text: string): { text: string; lead: string }[] {
  const out: { text: string; lead: string }[] = []
  let lead = ''
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) {
      lead = ''
      continue
    }
    const listItem = /^(?:[-*+]|\d+[.)])\s+/.test(trimmed)
    if (!listItem) {
      lead = /:\s*$/.test(trimmed) ? trimmed : ''
    }
    for (const part of trimmed.split(/(?<=[.!?])\s+(?=[A-Z`[(])/)) {
      out.push({ text: part, lead: listItem ? lead : '' })
    }
  }
  return out
}

function unique(items: ExtractedDeliverable[]): ExtractedDeliverable[] {
  const seen = new Set<string>()
  return items
    .filter((item) => {
      // Exact spelling: whether case matters is the host's to say (`deliverable-contract.ts`).
      const key = item.target
      if (seen.has(key)) {
        return false
      }
      seen.add(key)
      return true
    })
    .slice(0, MAX_ITEMS)
}

/** Files the person asks to be written somewhere: a path with an extension after an output verb. */
export function extractRequestedOutputs(prompt: string): ExtractedDeliverable[] {
  const items: ExtractedDeliverable[] = []
  for (const { text } of sentences(withoutCode(prompt))) {
    const words = wordsOnly(text)
    if (!OUTPUT_VERB.test(words) || /\b(?:don'?t|do not|never|no need to)\b/i.test(words)) {
      continue
    }
    for (const { target, index } of targetsIn(text)) {
      const before = text.slice(Math.max(0, index - 200), index)
      const looksLikeFile = /\.[A-Za-z0-9]{1,8}$/.test(target)
      if (
        kindOf(target) === 'file' &&
        looksLikeFile &&
        (OUTPUT_PREPOSITION.test(before) || OUTPUT_OBJECT.test(before))
      ) {
        items.push({ target, kind: 'file', claim: 'named' })
      }
    }
  }
  return unique(items)
}

/** A statement that it happened: not a question, a condition, or a future or passive-modal verb. */
function isAsserted(sentence: string): boolean {
  if (/\?\s*$/.test(sentence) || CONDITIONAL_LEAD.test(sentence)) {
    return false
  }
  const verb = CLAIM_VERB.exec(sentence)
  return Boolean(verb) && !MODAL_BEFORE_VERB.test(sentence.slice(0, verb!.index))
}

/** Paths and links the reply says it produced, and the ones it says it could not. */
export function extractReplyClaims(reply: string): ExtractedDeliverable[] {
  const items: ExtractedDeliverable[] = []
  for (const { text, lead } of sentences(withoutCode(reply))) {
    const words = wordsOnly(text)
    const own = CLAIM_VERB.test(words) || DECLINE.test(words)
    const context = own ? words : wordsOnly(lead)
    if (!context || (!CLAIM_VERB.test(context) && !DECLINE.test(context))) {
      continue
    }
    const declined = DECLINE.test(context)
    if (!declined && !isAsserted(context)) {
      continue
    }
    const claim: DeliverableClaim = PUBLISH_VERB.test(context)
      ? 'published'
      : UPDATE_VERB.test(context)
        ? 'updated'
        : 'created'
    for (const { target } of targetsIn(text)) {
      items.push({
        target,
        kind: kindOf(target),
        claim,
        ...(declined ? { declined: (own ? text : lead).slice(0, DECLINE_TEXT_MAX) } : {})
      })
    }
  }
  return unique(items)
}

/** Path items in a prepared prompt's "Done when" list. */
export function extractDoneWhenOutputs(prompt: string): ExtractedDeliverable[] {
  const section =
    /^\s*(?:#{1,4}\s*)?\**done when\**:?\s*$([\s\S]*?)(?=^\s*(?:#{1,4}\s|\**[A-Z][\w ]{2,40}\**:\s*$)|(?![\s\S]))/im.exec(
      withoutCode(prompt)
    )
  if (!section) {
    return []
  }
  const items: ExtractedDeliverable[] = []
  for (const line of section[1]!.split('\n')) {
    if (!/^\s*(?:[-*+]|\d+[.)])\s+/.test(line) || DECLINE.test(line)) {
      continue
    }
    for (const { target } of targetsIn(line)) {
      if (kindOf(target) === 'file' && /\.[A-Za-z0-9]{1,8}$/.test(target)) {
        items.push({ target, kind: 'file', claim: 'named' })
      }
    }
  }
  return unique(items)
}

/** Path items named in mission deliverable text (already stripped of Markdown). */
export function extractMissionOutputs(texts: readonly string[]): ExtractedDeliverable[] {
  const items: ExtractedDeliverable[] = []
  for (const text of texts) {
    for (const { target } of targetsIn(text)) {
      if (kindOf(target) === 'file' && /\.[A-Za-z0-9]{1,8}$/.test(target)) {
        items.push({ target, kind: 'file', claim: 'named' })
      }
    }
  }
  return unique(items)
}

/** The reply ends by asking the person something: theirs to answer, not ours to push past. */
export function replyAsksPerson(reply: string): boolean {
  const tail = withoutCode(reply).trim().slice(-400)
  return (
    /\?\s*$/.test(tail) ||
    /\b(?:should I|shall I|do you want|would you like|want me to|let me know (?:if|whether|which)|which (?:option|one) do you)\b/i.test(
      tail
    )
  )
}
