/** Sign-in links a finished turn hands the person: AirTop live views and login/OAuth pages. */

import { MAX_OPEN_QUESTIONS } from '../codex-async-question'

const AIRTOP_LIVE_URL = /^https:\/\/live\.airtop\.ai\//i
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`]+/gi
const AUTH_SHAPED_URL =
  /^https?:\/\/(?:(?:login|signin|auth|accounts?|sso|oauth|id)\.|[^?#\s]*?[/?&#=._-](?:log-?in|sign-?in|sign_in|sso|oauth2?|authori[sz]e|auth|authenticate|device|activate|verify|verification|consent|magic-?link)(?:[/?&#=._-]|$))/i
const SIGN_IN = String.raw`(?:re-?)?(?:sign|log)[\s-]?(?:in|on)`
const ASKER = String.raw`(?:please|go ahead and|need you to|you(?:'ll| will)? (?:need|have) to|you (?:need|have) to|can you|could you|you can now|you can|just)`
// Why: the agent describing its own login ("I'll sign in with…", "want me to log in?") asks nothing.
const NOT_SELF = String.raw`(?<!\b(?:I|I'll|I'm|we|we'll|me|let me|will|going|want|wants|need|needs|have|has|had|failed|unable|trying|tries|tried|attempting|attempted|able)\s(?:to\s)?)`
/** Request language aimed at the person, not prose about a login flow. */
export const AUTH_REQUEST = new RegExp(
  [
    String.raw`\b${ASKER}\s+${SIGN_IN}\b`,
    String.raw`${NOT_SELF}\b${SIGN_IN}\s+(?:at|here|there|below|above|using|with|via|through|in (?:the|that|this|both|each|your))\b`,
    String.raw`${NOT_SELF}\bto\s+${SIGN_IN}\b`,
    String.raw`\b${ASKER}\s+(?:authori[sz]e|authenticate|approve|verify|grant|connect|complete)\b`,
    String.raw`\b(?:here(?:'s| is| are)|use|open|click|tap|visit|follow)\s+(?:the\s+|this\s+|these\s+|that\s+|your\s+)?(?:sign[\s-]?in|log[\s-]?in|login|auth\w*|oauth|verification|device)\s+(?:links?|urls?|pages?)\b`,
    String.raw`\b(?:sign[\s-]?in|log[\s-]?in|login|oauth|verification)\s+(?:links?|urls?)\s*:`
  ].join('|'),
  'i'
)
/** The message hands the links over: it waits for the person rather than asking outright. */
export const HANDOFF_WAIT =
  /\b(?:(?:monitoring|watching)\s+(?:for\s+)?(?:your|the|both|all|each|these|those)?\s*(?:sign[\s-]?in|log[\s-]?in|login|auth\w*|session|window|browser)|waiting (?:for|on) you|let me know (?:when|once)|once you(?:'ve|'re| have| are)?\s+(?:sign|log|auth|complet|finish|done|ready|in\b)|when you(?:'re| are| have|'ve)? (?:done|ready|finished|signed|logged)|after you(?:'ve| have)? (?:sign|log))/i
/** A live view offered to the person ("open the live browser", "here is the live view"). */
const LIVE_VIEW_OFFER =
  /\b(?:open|click|tap|visit|use|follow|here(?:'s| is| are))\b[^.\n]{0,40}\b(?:live[\s-]?(?:view|browser|session)|browser window)\b/i
const MAX_LABEL = 80

export type SignInLink = { label: string; url: string }

/** Where a link is an example rather than a handoff: code blocks, inline code and quoted lines. */
function exampleSpans(text: string): (readonly [number, number])[] {
  const spans = [/```[\s\S]*?(?:```|$)/g, /`[^`\n]+`/g, /^[ \t]*>.*$/gm]
  return spans.flatMap((pattern) =>
    [...text.matchAll(pattern)].map(
      (found) => [found.index, found.index + found[0].length] as const
    )
  )
}

function unbalanced(url: string, open: string, close: string): boolean {
  return url.split(close).length > url.split(open).length
}

/**
 * The link as written, minus only what its surroundings show is not part of it: sentence
 * punctuation, the markup that opened right before it (`**`, `_`) and an unmatched `)`/`]`.
 * Never other bytes: base64url tokens and OAuth state params legitimately end in `_` or `-`.
 */
export function trimUrl(raw: string, before = ''): string {
  let url = raw
  let markup = /[*_]+$/.exec(before)?.[0] ?? ''
  for (let changed = true; changed;) {
    const bare = url.replace(/[.,;:!?]+$/, '')
    changed = bare !== url
    url = bare
    // Why: this module ships in the Node 18 relay bundle, which has no Array#toReversed.
    // oxlint-disable-next-line unicorn/no-array-reverse
    if (markup && url.endsWith([...markup].reverse().join(''))) {
      url = url.slice(0, -markup.length)
      markup = ''
      changed = true
    }
    for (const [open, close] of [
      ['(', ')'],
      ['[', ']']
    ] as const) {
      if (url.endsWith(close) && unbalanced(url, open, close)) {
        url = url.slice(0, -1)
        changed = true
      }
    }
  }
  return url
}

function cleanLabel(text: string): string {
  return text
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')
    .replace(/\*\*|__|[`[\]]/g, '')
    .replace(/[\s:：(—–-]+$/, '')
    .trim()
}

export function paragraphAround(text: string, index: number): string {
  const start = text.lastIndexOf('\n\n', index)
  const end = text.indexOf('\n\n', index)
  return text.slice(start === -1 ? 0 : start, end === -1 ? text.length : end)
}

/** What a link is for: the text before it on its line, else the short line above it. */
function labelFor(text: string, index: number): string {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1
  let label = cleanLabel(text.slice(lineStart, index))
  if (!label && lineStart > 0) {
    const above = text.slice(text.lastIndexOf('\n', lineStart - 2) + 1, lineStart - 1)
    label = above.length <= MAX_LABEL && !above.includes('://') ? cleanLabel(above) : ''
  }
  return label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label
}

/** Whether the turn hands this link to the person, judged by its paragraph and the final message. */
function handedOver(url: string, paragraph: string, finalWaits: boolean): boolean {
  if (AUTH_REQUEST.test(paragraph)) {
    return true
  }
  if (AIRTOP_LIVE_URL.test(url)) {
    return finalWaits || HANDOFF_WAIT.test(paragraph) || LIVE_VIEW_OFFER.test(paragraph)
  }
  return finalWaits && AUTH_SHAPED_URL.test(url)
}

/** AirTop live views and sign-in URLs outside examples that the turn asks or waits on. */
export function signInLinks(turnText: string, finalWaits: boolean): SignInLink[] {
  const examples = exampleSpans(turnText)
  const links: SignInLink[] = []
  for (const match of turnText.matchAll(URL_IN_TEXT)) {
    if (examples.some(([start, end]) => match.index >= start && match.index < end)) {
      continue
    }
    const url = trimUrl(match[0], turnText.slice(Math.max(0, match.index - 3), match.index))
    if (
      handedOver(url, paragraphAround(turnText, match.index), finalWaits) &&
      !links.some((link) => link.url === url)
    ) {
      links.push({ label: labelFor(turnText, match.index), url })
    }
  }
  return links.slice(0, MAX_OPEN_QUESTIONS)
}

/** Whether a final message could hand over a sign-in at all (the cheap Stop-time pre-check). */
export function mayHandOverSignIn(final: string): boolean {
  return /https?:\/\//i.test(final) || AUTH_REQUEST.test(final) || HANDOFF_WAIT.test(final)
}
