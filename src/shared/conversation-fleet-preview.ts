import type { ConversationFleetWorkflow } from './conversation-fleet-workflow'
import { CONVERSATION_PERSON_HANDOFF_ACTOR } from './console-conversation-person-handoff'
import type {
  ConsoleWorkflowJson,
  ConsoleWorkflowNode,
  ConsoleWorkflowPreview,
  ConsoleWorkflowStep
} from './console-workflow-types'

function matchesActor(step: ConsoleWorkflowStep, node: ConsoleWorkflowNode): boolean {
  if (step.person_handoff) {
    return (
      node.actor_type === 'mechanical' &&
      node.actor_id === CONVERSATION_PERSON_HANDOFF_ACTOR &&
      node.action === 'notify' &&
      node.provider == null &&
      node.model == null &&
      node.effort == null &&
      node.repo == null &&
      node.base_branch == null &&
      node.base_sha == null &&
      node.machine == null &&
      node.workspace == null
    )
  }
  const actor = step.actor_id ?? ''
  const separator = actor.indexOf(':')
  const provider = separator === -1 ? actor : actor.slice(0, separator)
  const model = separator === -1 ? null : actor.slice(separator + 1)
  if (node.actor_type !== 'ai' || node.provider !== provider) {
    return false
  }
  return model
    ? node.actor_id === actor && node.model === model
    : node.actor_id === provider || node.actor_id.startsWith(`${provider}:`)
}

function matchesHandoff(
  step: ConsoleWorkflowStep,
  node: ConsoleWorkflowNode,
  owner: string
): boolean {
  if (!step.person_handoff) {
    return node.person_handoff === undefined
  }
  const frozen = node.person_handoff
  if (
    !frozen ||
    frozen.participants.director.employee_id !== owner ||
    frozen.participants.recipient.employee_id !== step.person_handoff.recipient_employee_id
  ) {
    return false
  }
  const { participants: _participants, ...delivery } = frozen
  return (
    canonicalJson(delivery as ConsoleWorkflowJson) ===
    canonicalJson({
      ...step.person_handoff,
      source_files: step.person_handoff.source_files ?? []
    } as ConsoleWorkflowJson)
  )
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    [...left].sort().every((key, index) => key === [...right].sort()[index])
  )
}

function canonicalJson(value: ConsoleWorkflowJson): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function matchesBrief(step: ConsoleWorkflowStep, brief: string, taskPrompt: string): boolean {
  const instruction = (step.brief || step.prompt || step.detail || step.title).trim()
  const files = step.files?.length
    ? `\n\nFile context (not additional authorization):\n${step.files.join('\n')}`
    : ''
  const prefix = `Action: ${step.action || 'execute'}\n\n${instruction}${files}`
  const suffix = `\n\nOriginal task:\n${taskPrompt}`
  if (!step.engineering || Object.keys(step.engineering).length === 0) {
    return brief === `${prefix}${suffix}`
  }
  const engineeringPrefix = `${prefix}\n\nDeclared engineering contract:\n`
  if (!brief.startsWith(engineeringPrefix) || !brief.endsWith(suffix)) {
    return false
  }
  try {
    // Compare the entire wrapped instruction; only Python's JSON formatting is normalized.
    const engineering = JSON.parse(brief.slice(engineeringPrefix.length, -suffix.length))
    return canonicalJson(engineering) === canonicalJson(step.engineering)
  } catch {
    return false
  }
}

/** A successful preview must preserve the work selected before any admission can follow. */
export function assertConversationFleetPreview(
  expected: Pick<ConversationFleetWorkflow, 'classification' | 'prompt'>,
  preview: ConsoleWorkflowPreview
): void {
  const { graph } = preview
  const classification = expected.classification
  const expectedSteps = classification.steps
  const nodes = new Map(graph.nodes.map((node) => [node.key, node]))
  const columns = new Map<string, number>()
  for (const [index, column] of graph.columns.entries()) {
    for (const key of column) {
      if (columns.has(key)) {
        throw new Error('The fleet preview repeats a workflow stage.')
      }
      columns.set(key, index)
    }
  }
  if (
    preview.digest !== graph.digest ||
    preview.workflow_id !== graph.dispatch_id ||
    graph.company !== classification.company_slug ||
    graph.title !== classification.title ||
    graph.prompt !== expected.prompt ||
    graph.mode !== classification.execution_mode ||
    nodes.size !== graph.nodes.length ||
    nodes.size !== expectedSteps.length ||
    columns.size !== expectedSteps.length
  ) {
    throw new Error(
      'The fleet preview changed the conversation or workflow structure. Nothing was dispatched.'
    )
  }
  for (const step of expectedSteps) {
    const node = nodes.get(step.key ?? '')
    const column = columns.get(step.key ?? '')
    const workspace =
      step.actor_type === 'ai' ? (step.workspace ?? classification.workspace) : undefined
    if (
      !node ||
      column === undefined ||
      !matchesActor(step, node) ||
      !matchesHandoff(step, node, graph.owner) ||
      canonicalJson(node.handoff_report ?? null) !== canonicalJson(step.handoff_report ?? null) ||
      canonicalJson(node.output_artifacts ?? null) !==
        canonicalJson(step.output_artifacts ?? null) ||
      node.title !== step.title ||
      !matchesBrief(step, node.brief, expected.prompt) ||
      node.action !== step.action ||
      JSON.stringify(node.openrouter_candidates ?? null) !==
        JSON.stringify(step.openrouter_candidates ?? null) ||
      node.placement !== 'fleet' ||
      !sameKeys(node.after, step.after ?? []) ||
      (node.machine ?? null) !== (step.machine ?? null) ||
      (node.base_sha ?? null) !== (step.base_sha ?? null) ||
      canonicalJson(node.workspace ?? null) !== canonicalJson(workspace ?? null) ||
      (workspace && (node.repo != null || node.base_branch != null || node.base_sha != null)) ||
      (step.effort && node.effort !== step.effort) ||
      (step.repo && node.repo !== step.repo) ||
      (step.base_branch && node.base_branch !== step.base_branch) ||
      JSON.stringify(node.acceptance_commands) !== JSON.stringify(step.acceptance_commands) ||
      node.after.some((key) => (columns.get(key) ?? Number.POSITIVE_INFINITY) >= column)
    ) {
      throw new Error(`The fleet preview changed stage ${step.key}. Nothing was dispatched.`)
    }
  }
}
