import {
  WORKFLOW_KIND_LABELS,
  WORKFLOW_MAX_STEPS,
  type WorkflowRepeat,
  type WorkflowRoute,
  type WorkflowSpec,
  type WorkflowStep,
  type WorkflowStepKind
} from './workflow-graph'
import { normalizeWorkflowSpec, workflowStepSlug } from './workflow-graph-normalize'
import { workflowDescendants, workflowTopology } from './workflow-graph-topology'

/**
 * Edits the visual editor makes. Each returns a new normalized spec, and the only inputs it ever
 * offers a step are steps that do not already depend on it, so the editor cannot draw a cycle.
 */
function uniqueId(spec: WorkflowSpec, base: string): string {
  const ids = new Set(spec.steps.map((step) => step.id))
  let id = workflowStepSlug(base) || 'step'
  for (let n = 2; ids.has(id); n++) {
    id = `${workflowStepSlug(base).slice(0, 28)}-${n}`
  }
  return id
}

/** Steps `stepId` may take as input: any step that is not itself and does not depend on it. */
export function workflowAllowedInputs(spec: WorkflowSpec, stepId: string): WorkflowStep[] {
  const after = workflowDescendants(spec, stepId)
  return spec.steps.filter((step) => step.id !== stepId && !after.has(step.id))
}

/**
 * Adds a step of `kind` after `afterId` (or after the final step). The new step reads `afterId`;
 * when `afterId` was the final step, the new step becomes the final one.
 */
export function workflowAddStep(
  spec: WorkflowSpec,
  kind: WorkflowStepKind,
  available: readonly WorkflowRoute[],
  afterId?: string
): WorkflowSpec {
  if (spec.steps.length >= WORKFLOW_MAX_STEPS) {
    return spec
  }
  const { sinks } = workflowTopology(spec)
  const after = afterId ?? (sinks.length === 1 ? sinks[0] : spec.steps.at(-1)?.id)
  const title = WORKFLOW_KIND_LABELS[kind]
  const step = {
    id: uniqueId(spec, kind === 'synthesize' ? 'final' : title),
    kind,
    title,
    instruction: '',
    agents: kind === 'do' || kind === 'synthesize' ? [{}] : [{}, {}],
    inputs: after ? [after] : []
  }
  return normalizeWorkflowSpec({ ...spec, steps: [...spec.steps, step] }, available)
}

export function workflowRemoveStep(
  spec: WorkflowSpec,
  stepId: string,
  available: readonly WorkflowRoute[]
): WorkflowSpec {
  const removed = spec.steps.find((step) => step.id === stepId)
  if (!removed) {
    return spec
  }
  const steps = spec.steps
    .filter((step) => step.id !== stepId)
    .map((step) => {
      if (!step.inputs.includes(stepId)) {
        return step
      }
      // A step that read the removed one reads its inputs instead, so the chain stays connected.
      const inputs = [
        ...new Set(step.inputs.flatMap((input) => (input === stepId ? removed.inputs : [input])))
      ]
      const { forEach: _forEach, ...rest } = step
      return step.forEach?.step === stepId ? { ...rest, inputs } : { ...step, inputs }
    })
  const repeat =
    spec.repeat && spec.repeat.do !== stepId && spec.repeat.review !== stepId
      ? spec.repeat
      : undefined
  const { repeat: _repeat, ...rest } = spec
  return normalizeWorkflowSpec({ ...rest, steps, ...(repeat ? { repeat } : {}) }, available)
}

export function workflowUpdateStep(
  spec: WorkflowSpec,
  stepId: string,
  patch: Partial<Omit<WorkflowStep, 'id'>>,
  available: readonly WorkflowRoute[]
): WorkflowSpec {
  const steps = spec.steps.map((step) => {
    if (step.id !== stepId) {
      return step
    }
    const next: Record<string, unknown> = { ...step, ...patch }
    // Only a Do step lists; only an input can be a for-each source.
    if (next.kind !== 'do') {
      delete next.list
    }
    const inputs = (next.inputs as string[]) ?? []
    const forEach = next.forEach as WorkflowStep['forEach'] | undefined
    if (forEach && !inputs.includes(forEach.step)) {
      delete next.forEach
    }
    return next
  })
  return normalizeWorkflowSpec({ ...spec, steps }, available)
}

/**
 * A text edit (title, instruction, an agent's angle) as typed: no normalization, so a space at
 * the end of a word survives. Structural edits go through `workflowUpdateStep`.
 */
export function workflowPatchStep(
  spec: WorkflowSpec,
  stepId: string,
  patch: Partial<Pick<WorkflowStep, 'title' | 'instruction' | 'agents'>>
): WorkflowSpec {
  return {
    ...spec,
    steps: spec.steps.map((step) => (step.id === stepId ? { ...step, ...patch } : step))
  }
}

export function workflowSetRepeat(
  spec: WorkflowSpec,
  repeat: WorkflowRepeat | undefined,
  available: readonly WorkflowRoute[]
): WorkflowSpec {
  const { repeat: _repeat, ...rest } = spec
  return normalizeWorkflowSpec({ ...rest, ...(repeat ? { repeat } : {}) }, available)
}

/**
 * The pairs a repeat can loop: a Review that reads a Do (until approved or nothing new), or a
 * Rank that reads a Do (improve until it stops getting better).
 */
export function workflowRepeatCandidates(
  spec: WorkflowSpec
): { do: WorkflowStep; review: WorkflowStep }[] {
  return spec.steps.flatMap((review) =>
    review.kind === 'review' || review.kind === 'rank'
      ? review.inputs.flatMap((input) => {
          const doStep = spec.steps.find((step) => step.id === input && step.kind === 'do')
          return doStep ? [{ do: doStep, review }] : []
        })
      : []
  )
}
