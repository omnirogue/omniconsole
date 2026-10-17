import { checkWebPageAddress } from './web-page-address'
import { webPageLiteralIpIsPrivate } from './web-page-literal-ip'
import type { WebPageReason } from './web-page-reason'
import type { WorkflowSpec } from './workflow-graph'
import {
  normalizeWorkflowWeb,
  WORKFLOW_WEB_MAX_STEP_URLS,
  WORKFLOW_WEB_MAX_URL_CHARS,
  WORKFLOW_WEB_MAX_URLS,
  workflowWebAddress
} from './workflow-graph-web'

/** Why a step may not read pages: the refusals of validateWeb, known before Start. */
export type WorkflowWebRefusal =
  | { code: 'judge' | 'find' | 'plateau' | 'openrouter' | 'ollama' }
  | { code: 'rubric'; step: string; from: string }
  | { code: 'skeptic'; from: string }

/** The plain reason `stepId` cannot read pages in `spec`, or undefined when it can. */
export function workflowWebRefusal(
  spec: WorkflowSpec,
  stepId: string,
  options: { ignoreRubric?: boolean } = {}
): WorkflowWebRefusal | undefined {
  const step = spec.steps.find((entry) => entry.id === stepId)
  if (!step || step.kind !== 'do') {
    return { code: 'judge' }
  }
  if (spec.find) {
    return { code: 'find' }
  }
  if (spec.repeat?.until === 'plateau' && spec.repeat.do === step.id) {
    return { code: 'plateau' }
  }
  if (spec.steps.some((entry) => entry.agents.some((agent) => agent.route === 'openrouter'))) {
    return { code: 'openrouter' }
  }
  if (spec.steps.some((entry) => entry.agents.some((agent) => agent.route === 'ollama'))) {
    return { code: 'ollama' }
  }
  const titleOf = (id: string) => spec.steps.find((entry) => entry.id === id)?.title || id
  const scorer = options.ignoreRubric
    ? undefined
    : spec.steps.find((entry) => entry.forEach?.screen?.rubricFrom ?? entry.byCriterion?.rubricFrom)
  if (scorer) {
    const from = scorer.forEach?.screen?.rubricFrom ?? scorer.byCriterion!.rubricFrom
    return { code: 'rubric', step: scorer.title || scorer.id, from: titleOf(from) }
  }
  const skeptic = spec.finalCheck?.skeptic
  return skeptic !== undefined ? { code: 'skeptic', from: titleOf(skeptic) } : undefined
}

/** `stepId` reading exactly `urls` (normalised, each once); an empty list stops it reading pages. */
export function withWebPages(
  spec: WorkflowSpec,
  stepId: string,
  urls: readonly string[]
): WorkflowSpec {
  return {
    ...spec,
    steps: spec.steps.map((step) => {
      if (step.id !== stepId) {
        return step
      }
      const { web: _web, ...rest } = step
      return { ...rest, ...normalizeWorkflowWeb({ urls }) }
    })
  }
}

/** Why one more address cannot join a step's list; `others` are the run's pages in other steps. */
export type WorkflowWebPageProblem =
  | { code: 'address'; reason: WebPageReason }
  | { code: 'too-long' | 'listed' | 'step-limit' | 'run-limit' }

/** The shared syntactic policy and the run's limits, before a page is ever fetched. */
export function workflowWebPageCheck(
  raw: string,
  listed: readonly string[],
  others: readonly string[] = []
): { ok: true; url: string } | { ok: false; problem: WorkflowWebPageProblem } {
  if (raw.length > WORKFLOW_WEB_MAX_URL_CHARS) {
    return { ok: false, problem: { code: 'too-long' } }
  }
  const check = checkWebPageAddress(raw)
  if (!check.ok) {
    return { ok: false, problem: { code: 'address', reason: check.reason } }
  }
  if (check.address.ip !== null && webPageLiteralIpIsPrivate(check.address.ip)) {
    return { ok: false, problem: { code: 'address', reason: { code: 'private-address' } } }
  }
  const url = check.address.href
  if (listed.map(workflowWebAddress).includes(url)) {
    return { ok: false, problem: { code: 'listed' } }
  }
  if (listed.length >= WORKFLOW_WEB_MAX_STEP_URLS) {
    return { ok: false, problem: { code: 'step-limit' } }
  }
  const run = new Set([...others, ...listed].map(workflowWebAddress))
  if (!run.has(url) && run.size >= WORKFLOW_WEB_MAX_URLS) {
    return { ok: false, problem: { code: 'run-limit' } }
  }
  return { ok: true, url }
}
