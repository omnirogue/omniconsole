import { WORKFLOW_WEB_MAX_STEP_URLS } from './workflow-graph-web'
import { workflowWebPageCheck } from './workflow-web-pages'

// Up to the first character no address contains (brackets only around an IPv6 host).
const CANDIDATE = /https?:\/\/(?:\[[0-9a-f:.]+\])?[^\s<>"'`{}|\\^[\]]*/gi
const TRAILING = /[.,;:!?\]}*_~]+$/

function trimmed(candidate: string): string {
  let url = candidate.replace(TRAILING, '')
  // A closing bracket belongs to the address only when the address opened one.
  while (url.endsWith(')') && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) {
    url = url.slice(0, -1).replace(TRAILING, '')
  }
  return url
}

/**
 * The http(s) addresses a request names, in order, each once, that pass the shared policy (a
 * private address or a refused scheme or port is left out). Nothing is fetched here.
 */
export function workflowWebAddresses(...texts: (string | undefined)[]): string[] {
  const found: string[] = []
  for (const text of texts) {
    for (const match of (text ?? '').matchAll(CANDIDATE)) {
      if (found.length >= WORKFLOW_WEB_MAX_STEP_URLS) {
        return found
      }
      const check = workflowWebPageCheck(trimmed(match[0]), found)
      if (check.ok) {
        found.push(check.url)
      }
    }
  }
  return found
}
