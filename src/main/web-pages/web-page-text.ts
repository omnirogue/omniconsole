import { fromHtml } from 'hast-util-from-html'
import { toText } from 'hast-util-to-text'
import { IGNORABLE } from '../../shared/invisible-characters'
import { removeInstructionLines } from './web-page-instructions'

// Derived from the parser so no types package has to be declared beside it.
type Root = ReturnType<typeof fromHtml>
type Element = Extract<Root['children'][number], { type: 'element' }>
type Child = Root['children'][number] | Element['children'][number]

export const WEB_PAGE_TEXT_LIMIT = 60_000
const TITLE_LIMIT = 300

export type WebPageText = {
  text: string
  title: string
  removedLines: number
  truncated: boolean
}

const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml'])

const REMOVED_ELEMENTS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'canvas',
  'head',
  'meta',
  'link'
])

// Declarations with no spaces, lowercased: each hides its element from a person looking at the page.
const HIDING_STYLE =
  /(?:^|;)(?:display:none|visibility:(?:hidden|collapse)|opacity:(?:0*\.?0+)%?(?=;|!|$)|font-size:0*\.?0+[a-z%]*(?=;|!|$)|color:transparent|text-indent:-|clip:rect\(0|clip-path:inset\((?:50|100)%|content-visibility:hidden|transform:scale\(0\))/

const LINE_BREAKS = /\r\n?|[\u2028\u2029\u0085\v\f]/g
// Control characters other than newline and tab: terminal escapes and NULs carry no page text.
const CONTROLS = /\p{Cc}/gu
const keepLineControls = (control: string) => (control === '\n' || control === '\t' ? control : '')

function hiddenElement(element: Element): boolean {
  if (REMOVED_ELEMENTS.has(element.tagName)) {
    return true
  }
  const properties = element.properties
  if (element.tagName === 'input' && String(properties.type).toLowerCase() === 'hidden') {
    return true
  }
  if (
    properties.hidden !== undefined &&
    properties.hidden !== null &&
    properties.hidden !== false
  ) {
    return true
  }
  if (String(properties.ariaHidden).toLowerCase() === 'true') {
    return true
  }
  const style = typeof properties.style === 'string' ? properties.style : ''
  return HIDING_STYLE.test(style.replace(/\s+/g, '').toLowerCase())
}

const removed = (node: Child) =>
  node.type === 'comment' ||
  node.type === 'doctype' ||
  (node.type === 'element' && hiddenElement(node))

// Iterative, so a deeply nested page cannot exhaust the stack here.
function prune(tree: Root): void {
  const pending: (Root | Element)[] = [tree]
  for (let parent = pending.pop(); parent; parent = pending.pop()) {
    for (let index = parent.children.length - 1; index >= 0; index -= 1) {
      const child = parent.children[index]!
      if (removed(child)) {
        parent.children.splice(index, 1)
      } else if (child.type === 'element') {
        pending.push(child)
      }
    }
  }
}

function titleOf(tree: Root): string {
  const html = tree.children.find(
    (node): node is Element => node.type === 'element' && node.tagName === 'html'
  )
  const head = html?.children.find(
    (node): node is Element => node.type === 'element' && node.tagName === 'head'
  )
  const title = head?.children.find(
    (node): node is Element => node.type === 'element' && node.tagName === 'title'
  )
  return title?.children.map((node) => (node.type === 'text' ? node.value : '')).join('') ?? ''
}

function metaCharset(body: Uint8Array): string | null {
  const start = Buffer.from(body.subarray(0, 1024)).toString('latin1')
  return /<meta[^>]{0,200}?charset\s*=\s*["']?\s*([a-z0-9_:.+-]{1,40})/i.exec(start)?.[1] ?? null
}

function decode(body: Uint8Array, label: string | null): string {
  try {
    return new TextDecoder(label ?? 'utf-8', { fatal: false }).decode(body)
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(body)
  }
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

// The fences around page text use <<< and >>>; a page must never be able to write either.
const neutralizeFences = (text: string) =>
  text.replace(/<<</g, '\u2039\u2039\u2039').replace(/>>>/g, '\u203a\u203a\u203a')

// Leading indentation stays: it carries the structure of code, JSON and markdown.
function collapseWhitespace(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/(?<=\S)[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function cap(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) {
    return { text, truncated: false }
  }
  const end = /[\uD800-\uDBFF]/.test(text[limit - 1]!) ? limit - 1 : limit
  return { text: text.slice(0, end), truncated: true }
}

/** Invisible characters, NFKC, fences, instruction lines, whitespace, then the length cap, in that order. */
export function cleanWebText(
  raw: string,
  limit: number = WEB_PAGE_TEXT_LIMIT
): { text: string; removedLines: number; truncated: boolean } {
  const visible = raw
    .replace(LINE_BREAKS, '\n')
    .replace(IGNORABLE, '')
    .normalize('NFKC')
    .replace(IGNORABLE, '')
    .replace(CONTROLS, keepLineControls)
  const stripped = removeInstructionLines(neutralizeFences(visible))
  return { ...cap(collapseWhitespace(stripped.text), limit), removedLines: stripped.removedLines }
}

function htmlText(source: string): { body: string; title: string } | null {
  try {
    const tree = fromHtml(source)
    const title = titleOf(tree)
    prune(tree)
    return { body: toText(tree), title }
  } catch {
    // A page nested deeply enough to exhaust the parser's stack has no text we can vouch for.
    return null
  }
}

/** The readable text of a fetched page. Hidden markup never reaches the text; an empty text means unreadable. */
export function webPageText(body: Uint8Array, type: string, charset: string | null): WebPageText {
  const html = HTML_TYPES.has(type)
  const source = decode(body, charset ?? (html ? metaCharset(body) : null))
  if (!html) {
    const page = cleanWebText(type === 'application/json' ? prettyJson(source) : source)
    return { ...page, title: '' }
  }
  const parsed = htmlText(source)
  if (!parsed) {
    return { text: '', title: '', removedLines: 0, truncated: false }
  }
  const page = cleanWebText(parsed.body)
  const title = cleanWebText(parsed.title.replace(/\s+/g, ' '), TITLE_LIMIT)
  return {
    text: page.text,
    title: title.text.replace(/\s+/g, ' '),
    removedLines: page.removedLines + title.removedLines,
    truncated: page.truncated
  }
}
