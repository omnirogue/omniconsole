// ─── Labeled credentials in a session ───────────────────────────────────────
// The value-shaped redactor (`redactString`) recognises tokens by their shape.
// A credential with no shape — a chosen password, an opaque token — is only
// recognisable by its LABEL, and once the tool input has been rendered to
// Markdown the label is a quoted JSON key the shape rules never see. So the
// structured input is walked before serialization, and text is scanned for
// labeled assignments, and any hit refuses the whole session.
//
// Labels match by FAMILY on the normalized key (lower-case, non-alphanumerics
// stripped), so `DATABASE_PASSWORD`, `OPENAI_API_KEY` and `stripe_secret_key`
// all count, as the observability redactor's own attribute blocklist does.
// Two families the review named are deliberately absent: bare `auth` (it is
// inside `author`, on every commit tool call) and `session_id` (the very
// identifier this upload carries, and an argument of the console's MCP tools).

import type { NativeChatMessage } from '../../shared/native-chat-types'
import {
  isKnownNonSecretPair,
  isReferenceLabel,
  isTypeAnnotation,
  looksLikeCredentialValue
} from './transcript-labeled-value'

const KEY_FAMILIES =
  /password|passwd|pwd|secret|token|apikey|authorization|bearer|cookie|privatekey|credential|clientsecret|accesskey|signingkey/

/** The same families spelled as they appear in text (`_`/`-` between words). */
const FAMILY_IN_TEXT =
  'password|passwd|pwd|secret|token|api[_-]?key|authorization|bearer|cookie|private[_-]?key|credential|client[_-]?secret|access[_-]?key|signing[_-]?key'

/** Where a family occurs in text; the label around it is expanded by hand, so the
 *  scan stays linear on adversarial input (a megabyte of `-----` would make a
 *  `[\w-]*` prefix backtrack quadratically). */
const FAMILY_OCCURRENCE = new RegExp(FAMILY_IN_TEXT, 'gi')
const LABEL_CHAR = /[A-Za-z0-9_.-]/
const MAX_LABEL_CHARS = 128
const SEPARATOR = /^\s*\??\s*[:=]\s*/

const MAX_NODES = 100_000

export function isProtectedKey(key: string): boolean {
  return KEY_FAMILIES.test(key.toLowerCase().replace(/[^a-z0-9]+/g, ''))
}

function countInStructure(value: unknown): number {
  let hits = 0
  let nodes = 0
  const seen = new Set<object>()
  const walk = (node: unknown): void => {
    if (nodes++ > MAX_NODES) {
      return
    }
    if (typeof node === 'string') {
      hits += countInText(node)
      return
    }
    if (!node || typeof node !== 'object' || seen.has(node)) {
      return
    }
    seen.add(node)
    if (Array.isArray(node)) {
      for (const entry of node) {
        walk(entry)
      }
      return
    }
    for (const [key, entry] of Object.entries(node as Record<string, unknown>)) {
      if (entry && typeof entry === 'object') {
        // `{password: {value: …}}` counts the parent; a reference (`secretKeyRef`)
        // does not — but both are walked, so a nested `password` is still found.
        if (isProtectedKey(key) && !isReferenceLabel(key)) {
          hits += 1
        }
        walk(entry)
        continue
      }
      if (isProtectedKey(key) && entry !== null && entry !== undefined && entry !== '') {
        if (!isKnownNonSecretPair(key, String(entry))) {
          hits += 1
        }
        continue
      }
      walk(entry)
    }
  }
  walk(value)
  return hits
}

/** `"OPENAI_API_KEY": "sk-…"`, `DATABASE_PASSWORD=pg-…`, `Authorization: Bearer eyJ…`
 *  count; `token: string`, `secret?: string`, `apiKey: process.env.X` do not. */
function countInText(text: string): number {
  let hits = 0
  let lastLabelEnd = -1
  for (const match of text.matchAll(FAMILY_OCCURRENCE)) {
    if (match.index < lastLabelEnd) {
      continue
    }
    let start = match.index
    let end = start + match[0].length
    // Why bounded: a label is short; a longer run of label characters is prose or
    // noise, and walking it once per family occurrence would be quadratic.
    while (
      start > 0 &&
      match.index - start < MAX_LABEL_CHARS &&
      LABEL_CHAR.test(text[start - 1]!)
    ) {
      start -= 1
    }
    while (
      end < text.length &&
      end - match.index < MAX_LABEL_CHARS &&
      LABEL_CHAR.test(text[end]!)
    ) {
      end += 1
    }
    lastLabelEnd = end
    if (
      (start > 0 && LABEL_CHAR.test(text[start - 1]!)) ||
      (end < text.length && LABEL_CHAR.test(text[end]!))
    ) {
      continue
    }
    const quote = start > 0 && /["'`]/.test(text[start - 1]!) ? text[start - 1]! : ''
    let cursor = end
    // A matching close quote is consumed; a mismatch (the label inside a quoted
    // shell argument, an unbalanced quote in prose) reads as an unquoted label.
    if (quote && text[cursor] === quote) {
      cursor += 1
    }
    const separator = SEPARATOR.exec(text.slice(cursor, cursor + 16))
    if (!separator) {
      continue
    }
    const after = text.slice(cursor)
    const lineEnd = after.search(/\r?\n/)
    const line = lineEnd === -1 ? after : after.slice(0, lineEnd)
    if (isTypeAnnotation(line)) {
      continue
    }
    const rest = line.slice(separator[0].length)
    const value =
      /^(["'`])[^"'`\r\n]*\1/.exec(rest)?.[0] ?? /^[^\s"'`,;}\])]+(?:\s+\S+)?/.exec(rest)?.[0] ?? ''
    if (looksLikeCredentialValue(value, text.slice(start, end))) {
      hits += 1
    }
  }
  return hits
}

/** Sites where a labeled credential appears; 0 means none. Never returns a value. */
export function countProtectedCredentialSites(messages: readonly NativeChatMessage[]): number {
  let hits = 0
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'text') {
        hits += countInText(block.text)
      } else if (block.type === 'tool-call') {
        hits += countInStructure(block.input)
      } else if (block.type === 'tool-result') {
        hits += countInText(block.output)
      }
    }
  }
  return hits
}
