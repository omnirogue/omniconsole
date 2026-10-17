import type { WorkflowSpec, WorkflowStep } from './workflow-graph'
import { workflowWebAddresses } from './workflow-web-addresses'
import { withWebPages, workflowWebPageCheck, workflowWebRefusal } from './workflow-web-pages'

/** How a screen scores before review: the brief's rubric (model-written), the generic one, or the person's. */
export type WorkflowWebRubric = 'model' | 'generic' | { text: string }

/** What setup offers for pages: the step that reads them, or why this workflow cannot yet. */
export type WorkflowWebSetup =
  | { kind: 'reads'; stepId: string; screenStepId?: string }
  | { kind: 'decide' }

const doStep = (spec: WorkflowSpec, id: string) =>
  spec.steps.some((step) => step.id === id && step.kind === 'do') ? id : undefined

// A review screen scored by a rubric: under web rules a model may not write it.
const screenStep = (spec: WorkflowSpec): WorkflowStep | undefined =>
  spec.steps.find((step) => step.kind === 'review' && step.forEach?.screen)

/** Discover reads on `find`, Investigate on its investigators and the Research panel on `research`. */
export function workflowWebSetup(spec: WorkflowSpec): WorkflowWebSetup | undefined {
  const reader =
    spec.template === 'discover'
      ? doStep(spec, 'find')
      : spec.template === 'investigate'
        ? doStep(spec, 'investigate')
        : spec.template === 'custom' && spec.title === 'Research panel'
          ? doStep(spec, 'research')
          : undefined
  if (spec.template === 'decide') {
    return { kind: 'decide' }
  }
  const screen = screenStep(spec)
  return reader
    ? { kind: 'reads', stepId: reader, ...(screen ? { screenStepId: screen.id } : {}) }
    : undefined
}

/** The screen's rubric as the spec now has it; undefined when the workflow has no screen. */
export function workflowWebScreenRubric(spec: WorkflowSpec): WorkflowWebRubric | undefined {
  const screen = screenStep(spec)?.forEach?.screen
  if (!screen) {
    return undefined
  }
  return screen.rubric?.trim() ? { text: screen.rubric } : screen.rubricFrom ? 'model' : 'generic'
}

/** Sets the screen's rubric; back to `model` only where the step reads a brief to take it from. */
export function withWebScreenRubric(spec: WorkflowSpec, rubric: WorkflowWebRubric): WorkflowSpec {
  const target = screenStep(spec)
  if (!target) {
    return spec
  }
  // An empty text never becomes the generic rubric unasked: it falls back to the model's.
  const choice = typeof rubric === 'object' && !rubric.text.trim() ? 'model' : rubric
  const brief = target.inputs.includes('brief') ? 'brief' : undefined
  if (choice === 'model' && !brief) {
    return spec
  }
  return {
    ...spec,
    steps: spec.steps.map((step) => {
      if (step.id !== target.id) {
        return step
      }
      const { rubric: _rubric, rubricFrom: _from, ...rest } = step.forEach!.screen!
      const screen =
        choice === 'model'
          ? { ...rest, rubricFrom: brief! }
          : choice === 'generic'
            ? rest
            : { ...rest, rubric: choice.text }
      return { ...step, forEach: { ...step.forEach!, screen } }
    })
  }
}

/** The reader's pages; with none left, a generic rubric chosen only for pages goes back to the brief's. */
export function withSetupPages(
  spec: WorkflowSpec,
  stepId: string,
  urls: readonly string[]
): WorkflowSpec {
  const next = withWebPages(spec, stepId, urls)
  return !urls.length && workflowWebScreenRubric(next) === 'generic'
    ? withWebScreenRubric(next, 'model')
    : next
}

/** Addresses the request names that the reader does not list yet and the person has not removed. */
export function workflowWebRequestPages(
  spec: WorkflowSpec,
  prompt: string,
  dismissed: ReadonlySet<string>
): string[] {
  const setup = workflowWebSetup(spec)
  if (setup?.kind !== 'reads' || workflowWebRefusal(spec, setup.stepId, { ignoreRubric: true })) {
    return []
  }
  const listed = spec.steps.find((step) => step.id === setup.stepId)?.web?.urls ?? []
  const others = spec.steps.flatMap((step) =>
    step.id === setup.stepId ? [] : (step.web?.urls ?? [])
  )
  const added: string[] = []
  for (const url of workflowWebAddresses(prompt)) {
    if (!dismissed.has(url) && workflowWebPageCheck(url, [...listed, ...added], others).ok) {
      added.push(url)
    }
  }
  return added
}

/** The request's addresses added to the reader's pages, or undefined when there are none new. */
export function workflowWebPrefill(
  spec: WorkflowSpec,
  prompt: string,
  dismissed: ReadonlySet<string>
): WorkflowSpec | undefined {
  const setup = workflowWebSetup(spec)
  const added = workflowWebRequestPages(spec, prompt, dismissed)
  if (setup?.kind !== 'reads' || !added.length) {
    return undefined
  }
  const listed = spec.steps.find((step) => step.id === setup.stepId)?.web?.urls ?? []
  return withSetupPages(spec, setup.stepId, [...listed, ...added])
}
