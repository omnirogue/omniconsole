import { checkWebPageAddress } from './web-page-address'
import { workflowStepReadsWeb, type WorkflowSpec } from './workflow-graph'
import { workflowTopology } from './workflow-graph-topology'

/** Every page is read before its readers start, so a run bounds how many it waits for. */
export const WORKFLOW_WEB_MAX_STEP_URLS = 12
export const WORKFLOW_WEB_MAX_URLS = 24
/** Refused rather than cut: a cut address names another page. */
export const WORKFLOW_WEB_MAX_URL_CHARS = 2_000

/** What the app found for one citation it recognised: its own check, never the model's claim. */
export type WorkflowWebMark =
  | 'found'
  | 'not-in-page'
  | 'leaves-out'
  | 'unreadable'
  | 'unknown'
  | 'unquoted'
  | 'pending'
export type WorkflowWebCheck = { id: string; mark: WorkflowWebMark; quote?: string }

/** One page of a run: its citation id, its normalised address and the steps that read it. */
export type WorkflowWebSource = { id: string; url: string; readers: string[] }

/** The address as a run keys it: normalised without its fragment, or as typed when invalid. */
export function workflowWebAddress(raw: string): string {
  const check = checkWebPageAddress(raw)
  return check.ok ? check.address.href : raw
}

/** Only a person's list: trimmed, normalised, each page once; validation judges the rest. */
export function normalizeWorkflowWeb(raw: unknown): { web?: { urls: string[] } } {
  const list = raw && typeof raw === 'object' ? (raw as { urls?: unknown }).urls : undefined
  const urls = [
    ...new Set(
      (Array.isArray(list) ? list : [])
        .filter((url): url is string => typeof url === 'string')
        .map((url) => workflowWebAddress(url.trim()))
        .filter(Boolean)
    )
  ].slice(0, WORKFLOW_WEB_MAX_STEP_URLS * 2)
  return urls.length ? { web: { urls } } : {}
}

/** Whether a run reads pages at all; only such a run is admitted under web rules. */
export function workflowReadsWeb(spec: Pick<WorkflowSpec, 'steps'>): boolean {
  return spec.steps.some(workflowStepReadsWeb)
}

/** W1…Wn over the whole run: readers in topological order, each reader's pages in its order. */
export function workflowWebSources(
  spec: Pick<WorkflowSpec, 'steps' | 'oneAnswer'>
): WorkflowWebSource[] {
  const byId = new Map(spec.steps.map((step) => [step.id, step]))
  const sources: WorkflowWebSource[] = []
  for (const id of workflowTopology(spec).order ?? spec.steps.map((step) => step.id)) {
    const step = byId.get(id)!
    if (!workflowStepReadsWeb(step)) {
      continue
    }
    for (const url of step.web!.urls.map(workflowWebAddress)) {
      const known = sources.find((source) => source.url === url)
      if (!known) {
        sources.push({ id: `W${sources.length + 1}`, url, readers: [id] })
      } else if (!known.readers.includes(id)) {
        known.readers.push(id)
      }
    }
  }
  return sources
}

/** Every step page text can reach: from each reader through inputs, lists, rubrics, loops and checks. */
export function workflowWebReach(
  spec: Pick<WorkflowSpec, 'steps' | 'repeat' | 'finalCheck'>
): Set<string> {
  const next = new Map<string, string[]>()
  const link = (from: string | undefined, to: string | undefined) => {
    if (from && to) {
      next.set(from, [...(next.get(from) ?? []), to])
    }
  }
  for (const step of spec.steps) {
    for (const from of [
      ...step.inputs,
      step.forEach?.step,
      step.forEach?.screen?.rubricFrom,
      step.byCriterion?.rubricFrom
    ]) {
      link(from, step.id)
    }
  }
  // A loop hands its review's (or Improve's judges') answers back to the step it repeats.
  link(spec.repeat?.review, spec.repeat?.do)
  // A final check weighs the chair's answer and the skeptic's frame against the rank, and back.
  link(spec.finalCheck?.chair, spec.finalCheck?.rank)
  link(spec.finalCheck?.skeptic, spec.finalCheck?.rank)
  link(spec.finalCheck?.rank, spec.finalCheck?.chair)
  const reached = new Set(spec.steps.filter(workflowStepReadsWeb).map((step) => step.id))
  const queue = [...reached]
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    for (const to of next.get(id) ?? []) {
      if (!reached.has(to)) {
        reached.add(to)
        queue.push(to)
      }
    }
  }
  return reached
}

/** Host and path only: never the query, which may carry a key, nor anything a page wrote. */
export function workflowWebShortAddress(url: string): string {
  try {
    const parsed = new URL(url)
    const short = `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`
    return short.length > 120 ? `${short.slice(0, 119)}…` : short
  } catch {
    return 'an address that is not a web address'
  }
}

/** Model text the app writes into Markdown: every control character literal, so nothing can open. */
export function workflowInertMarkdown(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(
      /[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu,
      (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`
    )
    .replace(/[\\`*_{}[\]()#+\-.!|~:]/g, (character) => `\\${character}`)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** One document for save, copy and follow-ups: the app's part first, so no model text can hide it. */
export function workflowResultDocument(result: { markdown: string; appendix?: string }): string {
  return result.appendix ? `${result.appendix}\n\n---\n\n${result.markdown}` : result.markdown
}
