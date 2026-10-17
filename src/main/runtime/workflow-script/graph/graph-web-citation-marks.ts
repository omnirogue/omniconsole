import type { WorkflowWebCheck, WorkflowWebMark } from '../../../../shared/workflow-graph-web'
import type { GraphWebCheckPage } from './graph-web-types'

export type GraphWebCheck = WorkflowWebCheck
export type GraphWebMark = WorkflowWebMark

// A citation this misses is only left off the app's list, which a judge reads as unchecked.
const CITATION = /\[\s*W(\d{1,3})(?!\d)[^\]\n]{0,120}\]/g
const QUOTE =
  /^[ \t]{0,3}(?:[:\u2013\u2014-][ \t]{0,3})?(?:"([^"\n]{1,600})"|\u201c([^\u201c\u201d\n]{1,600})\u201d)/

/** Only whitespace and NFKC are forgiven: case, words and their order must all be the page's. */
const comparable = (text: string) => text.normalize('NFKC').replace(/\s+/g, ' ').trim()

// Planning runs after every settled call; a page's comparable form is worked out once.
const comparablePages = new Map<string, string>()

function comparablePage(text: string): string {
  let known = comparablePages.get(text)
  if (known === undefined) {
    known = comparable(text)
    comparablePages.set(text, known)
    if (comparablePages.size > 48) {
      comparablePages.delete(comparablePages.keys().next().value!)
    }
  }
  return known
}

function markOf(page: GraphWebCheckPage | undefined, quote: string | undefined): GraphWebMark {
  if (!page) {
    return 'unknown'
  }
  if (page.state !== 'read') {
    return page.state
  }
  const wanted = quote === undefined ? '' : comparable(quote)
  if (!wanted) {
    return 'unquoted'
  }
  if (comparablePage(page.text).includes(wanted)) {
    return 'found'
  }
  return /\.\.\.|\u2026/.test(wanted) ? 'leaves-out' : 'not-in-page'
}

/** The app's own check of each citation it recognises in model text; the text is never changed. */
export function checkWebCitations(
  text: string,
  pages: readonly GraphWebCheckPage[] | 'pending'
): GraphWebCheck[] {
  if (!text.includes('[')) {
    return []
  }
  const checks: GraphWebCheck[] = []
  for (const match of text.matchAll(CITATION)) {
    const after = match.index + match[0].length
    const quoted = QUOTE.exec(text.slice(after, after + 700))
    const quote = quoted ? (quoted[1] ?? quoted[2]) : undefined
    const id = `W${Number(match[1])}`
    const mark =
      pages === 'pending'
        ? 'pending'
        : markOf(
            pages.find((page) => page.id === id),
            quote
          )
    checks.push({ id, mark, ...(quote !== undefined ? { quote } : {}) })
  }
  return checks
}
