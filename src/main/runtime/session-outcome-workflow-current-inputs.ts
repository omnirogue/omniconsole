import type { SessionChain, SessionChainAgentStep } from '../../shared/session-chain-types'
import type { OrcaRuntimeService } from './omni-runtime'
import type {
  SessionOutcomeCurrentInputFile,
  SessionOutcomeCurrentGit
} from '../../shared/session-outcome-current-inputs'
import { sessionOutcomeWorkflowPort } from './session-outcome-workflow-port'
export type SessionOutcomeCurrentRoute = {
  provider: string
  model: string
  effort?: string
  files: SessionOutcomeCurrentInputFile[]
  producer?: { provider: string; model: string }
  git?: SessionOutcomeCurrentGit
}
/** Current folder bytes come from explicit saved file targets, not old execution reports. */
export async function captureSessionOutcomeCurrentRoutes(
  runtime: OrcaRuntimeService,
  chain: SessionChain,
  previous?: SessionChain
): Promise<Map<string, SessionOutcomeCurrentRoute>> {
  const routes = new Map<string, SessionOutcomeCurrentRoute>()
  const history = [
    ...(previous?.outcomeSet?.workflowHistory ?? []),
    ...(previous?.outcomeSet?.workflow ? [previous.outcomeSet.workflow] : [])
  ]
  const set = chain.outcomeSet!
  const initial = set.continuation.initialSource
  if (initial && !history.some((workflow) => workflow.phase !== 'prepared')) {
    // Only graph roots receive the original snapshot. Later stages consume their actual predecessors.
    for (const outcome of set.outcomes.filter((entry) => entry.dependsOn.length === 0)) {
      const first = chain.steps.find(
        (step) => step.kind !== 'handoff' && outcome.stepIds?.includes(step.id)
      )
      const action = !first ? outcome.actions[0] : undefined
      const id = first?.id ?? (action && sessionOutcomeCurrentActionKey(outcome.id, action.id))
      if (id) {
        routes.set(id, {
          ...initial.producer,
          producer: initial.producer,
          effort: initial.effort,
          files: initial.files,
          git: initial.git
        })
      }
    }
    return routes
  }
  if (
    !history.some((workflow) =>
      workflow.preview.graph.nodes.some((node) => node.workspace?.kind === 'folder')
    )
  ) {
    return routes
  }
  const captured = new Map<string, SessionOutcomeCurrentInputFile[]>()
  const items: SessionChainAgentStep[] = [
    ...chain.steps.filter((step): step is SessionChainAgentStep => step.kind !== 'handoff'),
    ...set.outcomes.flatMap((outcome) =>
      outcome.actions.map((action) => ({
        id: sessionOutcomeCurrentActionKey(outcome.id, action.id),
        agent: action.agent,
        model: action.model,
        effort: action.effort,
        prompt: action.instruction,
        status: 'queued' as const,
        outcomeId: outcome.id
      }))
    )
  ]
  for (const step of items) {
    const owning = set.outcomes.find(
      (outcome) => outcome.stepIds?.includes(step.id) || outcome.id === step.outcomeId
    )
    if (!owning) {
      continue
    }
    const definitions = new Map(
      [...previous!.outcomeSet!.outcomes, ...set.outcomes].map((outcome) => [outcome.id, outcome])
    )
    const scope = new Set([owning.id])
    for (const id of scope) {
      for (const dependency of definitions.get(id)?.dependsOn ?? []) {
        scope.add(dependency)
      }
    }
    const priorOutcomes = previous!.outcomeSet!.outcomes.filter((outcome) => scope.has(outcome.id))
    const paths = [
      ...new Set(
        priorOutcomes.flatMap((outcome) =>
          outcome.conditions
            .filter((condition) => condition.kind === 'file')
            .map((condition) => condition.target)
        )
      )
    ]
    for (const prior of previous!.steps) {
      if (
        prior.kind === 'handoff' &&
        priorOutcomes.some((outcome) => outcome.stepIds?.includes(prior.id)) &&
        prior.handoff.deliverables.kind === 'files'
      ) {
        for (const path of prior.handoff.deliverables.paths) {
          if (!paths.includes(path)) {
            paths.push(path)
          }
        }
      }
    }
    if (!paths.length) {
      throw new Error(
        'Choose explicit current folder files before continuing or reviewing this saved outcome.'
      )
    }
    const producer = history
      .flatMap((workflow) =>
        workflow.stages
          .filter((stage) => stage.outcomeIds.some((id) => scope.has(id)))
          .flatMap((stage) =>
            workflow.preview.graph.nodes.filter(
              (node) =>
                (node.key === stage.key || node.loop_stage?.stage_key === stage.key) &&
                node.actor_type === 'ai' &&
                (node.action === 'execute' || node.action === 'repair') &&
                node.provider &&
                node.model
            )
          )
      )
      .at(-1)
    if (step.review && !producer) {
      throw new Error('Choose the original producer model before reviewing current folder files.')
    }
    const capture = sessionOutcomeWorkflowPort().captureCurrentInputs
    if (!capture) {
      throw new Error('This execution host cannot capture current folder inputs.')
    }
    const key = JSON.stringify([...paths].sort())
    let files = captured.get(key)
    if (!files) {
      files = await capture(runtime, {
        taskId: set.continuation.taskId!,
        principal: set.continuation.principal!,
        worktree: `id:${chain.worktreeId}`,
        selectedSourcePaths: paths
      })
      captured.set(key, files)
    }
    routes.set(step.id, {
      provider: step.review ? producer!.provider! : step.agent,
      model: step.review ? producer!.model! : step.model!,
      effort: step.review ? (producer!.effort ?? undefined) : step.effort,
      files
    })
  }
  return routes
}

export function sessionOutcomeCurrentActionKey(outcomeId: string, actionId: string) {
  return `action:${outcomeId}:${actionId}`
}
