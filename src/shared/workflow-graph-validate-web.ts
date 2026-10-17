import { checkWebPageAddress } from './web-page-address'
import { webPageReasonText } from './web-page-reason'
import type { WorkflowSpec } from './workflow-graph'
import {
  WORKFLOW_WEB_MAX_STEP_URLS,
  WORKFLOW_WEB_MAX_URL_CHARS,
  WORKFLOW_WEB_MAX_URLS,
  workflowWebSources
} from './workflow-graph-web'

const typed = (url: string) => JSON.stringify(url.length > 80 ? `${url.slice(0, 79)}…` : url)

/** Page text reaches only the Do step that asked: never a judge, an Improve version or a rubric. */
export function validateWeb(
  spec: WorkflowSpec,
  problem: (message: string, stepId?: string) => void
): void {
  const readers = spec.steps.filter((step) => step.web)
  if (!readers.length) {
    return
  }
  // A provider may browse on its side with page-steered queries, outside the app's sources.
  const browsing = spec.steps.find((step) =>
    step.agents.some((agent) => agent.route === 'openrouter')
  )
  if (browsing) {
    problem("Reading web pages isn't available with OpenRouter models yet.", browsing.id)
  }
  // Not measured with local models: page text is fenced as evidence only where that was tested.
  const local = spec.steps.find((step) => step.agents.some((agent) => agent.route === 'ollama'))
  if (local) {
    problem("Reading web pages isn't available with Ollama models yet.", local.id)
  }
  // A rubric is read as instructions, never fenced as evidence: here only the person writes one.
  const byId = new Map(spec.steps.map((step) => [step.id, step]))
  const titleOf = (id: string) => byId.get(id)?.title || id
  for (const step of spec.steps) {
    const from = step.forEach?.screen?.rubricFrom ?? step.byCriterion?.rubricFrom
    if (from) {
      problem(
        `${step.title || step.id} takes the rubric JEV and the judges score by from ${titleOf(from)}'s answer. A run that reads web pages scores only by a rubric you write.`,
        step.id
      )
    }
  }
  if (spec.finalCheck?.skeptic !== undefined) {
    problem(
      `The skeptic checks the recommendation against ${titleOf(spec.finalCheck.skeptic)}'s answer. A run that reads web pages cannot have its checks written by a model.`,
      spec.finalCheck.skeptic
    )
  }
  for (const step of readers) {
    const name = step.title || step.id
    if (step.kind !== 'do') {
      problem(
        `${name}: only a Do step can read web pages; reviews, rankings and syntheses see only what readers wrote.`,
        step.id
      )
    }
    if (spec.find) {
      problem(`${name}: Find the best cannot read web pages.`, step.id)
    }
    if (spec.repeat?.until === 'plateau' && spec.repeat.do === step.id) {
      problem(
        `${name} makes the versions the judges compare, so it cannot read web pages. Read them in a Do step before it.`,
        step.id
      )
    }
    const urls = step.web!.urls
    if (urls.length > WORKFLOW_WEB_MAX_STEP_URLS) {
      problem(`${name}: read at most ${WORKFLOW_WEB_MAX_STEP_URLS} web pages in one step.`, step.id)
    }
    for (const url of urls) {
      const check = url.length > WORKFLOW_WEB_MAX_URL_CHARS ? undefined : checkWebPageAddress(url)
      if (!check?.ok) {
        const why = check ? webPageReasonText(check.reason) : 'the address is too long'
        problem(`${name}: ${typed(url)} cannot be read: ${why}.`, step.id)
      }
    }
  }
  const total = workflowWebSources(spec).length
  if (total > WORKFLOW_WEB_MAX_URLS) {
    problem(`This workflow reads ${total} web pages; the limit is ${WORKFLOW_WEB_MAX_URLS}.`)
  }
}
