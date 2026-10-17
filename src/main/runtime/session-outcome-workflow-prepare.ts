import { assertSessionOutcomeFolderLoopContract } from './session-outcome-workflow-folder-contract'
import { captureSessionOutcomeCurrentRoutes } from './session-outcome-workflow-current-inputs'
import { prepareSessionOutcomeAmendment } from './session-outcome-workflow-amendment'
import type { OutcomeAmendmentIntent } from '../../shared/outcome-amendment-cancellation'
import type { ConsoleWorkflowNode, ConsoleWorkflowStep } from '../../shared/console-workflow-types'
import { randomUUID } from 'node:crypto'
import type { SessionChain } from '../../shared/session-chain-types'
import type { OrcaRuntimeService } from './omni-runtime'
import {
  compileSessionOutcomeWorkflow,
  sessionOutcomeWorkflowDefinitionHash,
  type SessionOutcomePredecessor
} from './session-outcome-workflow-compile'
import { sessionOutcomeWorkflowPort } from './session-outcome-workflow-port'
import { sessionOutcomeHostRouteReason } from '../../shared/session-outcome-host-route'

function expectedNodeEffort(stage: ConsoleWorkflowStep, node: ConsoleWorkflowNode) {
  const efforts = stage.loop?.participant_efforts
  const actor = stage.loop?.participant_ids
    ? String(node.loop_stage?.participant_id ?? '')
    : `${node.provider}:${node.model}`
  // Explicit null keeps a reviewer's model default instead of inheriting producer effort.
  return (
    (node.loop_stage?.role === 'participant' && efforts && Object.hasOwn(efforts, actor)
      ? efforts[actor]
      : stage.effort) ?? null
  )
}

export async function prepareSessionOutcomeWorkflow(
  runtime: OrcaRuntimeService,
  chain: SessionChain,
  previous?: SessionChain
): Promise<SessionChain> {
  const set = chain.outcomeSet!
  if (
    !set.continuation.taskId ||
    (!previous?.outcomeSet?.workflow &&
      chain.steps.length === 0 &&
      set.outcomes.every(
        (outcome) =>
          outcome.actions.length === 0 &&
          outcome.conditions.every((condition) => condition.kind === 'session')
      ))
  ) {
    return chain
  }
  const prior = previous?.outcomeSet?.workflow
  const definitionSha256 = sessionOutcomeWorkflowDefinitionHash(chain)
  if (
    (previous?.outcomeSet?.planDefinitionSha256 ?? prior?.definitionSha256) === definitionSha256
  ) {
    return {
      ...chain,
      outcomeSet: {
        ...set,
        workflow: prior,
        planDefinitionSha256: definitionSha256,
        amendment: previous?.outcomeSet?.amendment,
        workflowHistory: previous?.outcomeSet?.workflowHistory
      }
    }
  }
  if (previous?.outcomeSet?.amendment && previous.outcomeSet.amendment.state !== 'ready') {
    throw new Error('The previous saved amendment must finish cancellation before another edit.')
  }
  let compileChain = chain
  let history = previous?.outcomeSet?.workflowHistory ?? []
  let prerequisites: string[] = []
  let sources = new Map<string, SessionOutcomePredecessor>()
  let amendment: OutcomeAmendmentIntent | undefined
  if (prior && prior.phase !== 'prepared') {
    const delta = await prepareSessionOutcomeAmendment(runtime, chain, previous!)
    compileChain = delta.compileChain
    history = delta.history
    prerequisites = delta.prerequisites
    sources = delta.sources
    amendment = delta.intent
    if (history.length > 32) {
      throw new Error('The retained workflow generation limit was reached.')
    }
    const executable =
      compileChain.steps.some((step) => step.kind !== 'handoff') ||
      compileChain.outcomeSet!.outcomes.some((outcome) => outcome.actions.length)
    if (!executable) {
      return {
        ...chain,
        outcomeSet: {
          ...set,
          workflow: prior,
          workflowHistory: previous!.outcomeSet!.workflowHistory,
          planDefinitionSha256: definitionSha256,
          amendment
        }
      }
    }
  }
  // The hub contract cannot name a finished local session as a review source; run it here.
  const hostRoute = prior ? null : sessionOutcomeHostRouteReason(compileChain)
  if (hostRoute) {
    console.info(`[session-outcome] ${chain.id} stays on the host executor: ${hostRoute}`)
    return chain
  }
  if (!set.continuation.principal) {
    throw new Error('Sign in before saving an admitted task plan.')
  }
  if (!prior && previous?.outcomeSet?.attempts.length) {
    throw new Error(
      'An already executing single-job continuation cannot be re-admitted as a different stage plan.'
    )
  }
  const currentRoutes = await captureSessionOutcomeCurrentRoutes(runtime, compileChain, previous)
  const compiled = compileSessionOutcomeWorkflow(compileChain, sources, currentRoutes)
  const operationId = randomUUID()
  const preview = await sessionOutcomeWorkflowPort().preview(runtime, {
    taskId: set.continuation.taskId,
    operationId,
    principal: set.continuation.principal,
    worktree: `id:${chain.worktreeId}`,
    stages: compiled.stages,
    currentInputs: compiled.currentInputs,
    predecessorReceipts: compiled.predecessorReceipts
  })
  for (const stage of compiled.stages) {
    const locator = compiled.predecessorReceipts.find((entry) => entry.stage_key === stage.key)
    const currentInput = compiled.currentInputs.find((entry) => entry.stage_key === stage.key)
    const reviewSource = locator?.mode === 'review-source' || currentInput?.mode === 'review-source'
    const node = preview.graph.nodes.find((entry) =>
      reviewSource
        ? entry.loop_stage?.stage_key === stage.key && entry.loop_stage?.role === 'participant'
        : entry.key === stage.key
    )
    if (
      !node ||
      node.actor_type !== 'ai' ||
      node.action !== (reviewSource ? 'review' : 'execute') ||
      (!reviewSource && `${node.provider}:${node.model}` !== stage.actor) ||
      (node.effort ?? null) !== expectedNodeEffort(stage, node) ||
      (!reviewSource && !node.brief.includes(stage.prompt!))
    ) {
      throw new Error('The reviewed graph changed the selected stage or exact producer model.')
    }
    if (currentInput) {
      assertSessionOutcomeFolderLoopContract(preview.graph, stage, currentInput)
      const current = node.current_source
      if (
        !current ||
        current.root_task_id !== set.continuation.taskId ||
        current.stage_key !== stage.key ||
        current.mode !== currentInput.mode ||
        (currentInput.producer &&
          JSON.stringify(current.producer) !== JSON.stringify(currentInput.producer)) ||
        JSON.stringify(current.git) !== JSON.stringify(currentInput.git) ||
        JSON.stringify(
          current.files.map((entry) => ({ ...entry.file, target_path: entry.target_path }))
        ) !== JSON.stringify(currentInput.files)
      ) {
        throw new Error(
          'The reviewed source snapshot changed its completed producer, Git state, or exact input files.'
        )
      }
    }
    if (locator) {
      const ext = node.external_predecessor
      if (
        !ext ||
        ext.job_id !== locator.job_id ||
        ext.receipt_event_id !== locator.receipt_event_id ||
        ext.fingerprint !== locator.fingerprint ||
        ext.mode !== locator.mode
      ) {
        throw new Error('The preview changed its authenticated predecessor receipt.')
      }
    }
    if (stage.loop) {
      const participants = preview.graph.nodes.filter(
        (entry) =>
          entry.loop_stage?.stage_key === stage.key && entry.loop_stage?.role === 'participant'
      )
      const routes = stage.loop.participants.slice(1)
      const identities = stage.loop.participant_ids
      if (identities) {
        const expected = identities
          .slice(1)
          .map((id, index) => `${id}:${routes[index]}`)
          .sort()
        for (let round = 1; round <= stage.loop.max_rounds; round++) {
          const actual = participants
            .filter((entry) => entry.loop_stage?.round === round)
            .map(
              (entry) =>
                `${String(entry.loop_stage?.participant_id)}:${entry.provider}:${entry.model}`
            )
            .sort()
          if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new Error(
              'The reviewed graph did not preserve independent reviewer identities. Update the execution hub before saving this review.'
            )
          }
        }
        if (
          preview.graph.nodes
            .filter((entry) => entry.key === stage.key || entry.loop_stage?.stage_key === stage.key)
            .some(
              (entry) =>
                entry.loop_stage?.producer_participant_id !== identities[0] ||
                (['producer', 'repair'].includes(String(entry.loop_stage?.role)) &&
                  entry.loop_stage?.participant_id !== identities[0])
            )
        ) {
          throw new Error('The reviewed graph changed the producer or repair identity.')
        }
      }
      for (let round = 1; round <= stage.loop.max_rounds; round++) {
        const actual = participants
          .filter((entry) => entry.loop_stage?.round === round)
          .map((entry) => `${entry.provider}:${entry.model}`)
          .sort()
        if (JSON.stringify(actual) !== JSON.stringify([...routes].sort())) {
          throw new Error('The graph changed a round’s exact reviewer roster.')
        }
      }
      if (
        participants.length !== routes.length * stage.loop.max_rounds ||
        participants.some((entry) => !routes.includes(`${entry.provider}:${entry.model}`))
      ) {
        throw new Error('The reviewed graph changed the exact reviewer set or bounded rounds.')
      }
    }
  }
  for (const node of preview.graph.nodes.filter((entry) => entry.actor_type === 'ai')) {
    const stage = compiled.stages.find(
      (entry) => entry.key === node.key || entry.key === node.loop_stage?.stage_key
    )
    if (
      !stage ||
      (node.action === 'repair' && `${node.provider}:${node.model}` !== stage.actor) ||
      (node.effort ?? null) !== expectedNodeEffort(stage, node) ||
      JSON.stringify(node.openrouter_candidates) !== JSON.stringify(stage.openrouter_candidates)
    ) {
      throw new Error('The preview added an unrequested execution route or preference.')
    }
  }
  return {
    ...chain,
    outcomeSet: {
      ...set,
      planDefinitionSha256: definitionSha256,
      amendment,
      workflow: {
        operationId,
        currentInputs: compiled.currentInputs,
        predecessorReceipts: compiled.predecessorReceipts,
        definitionSha256,
        preview,
        phase: 'prepared',
        stages: compiled.bindings,
        activations: [],
        prerequisiteOutcomeIds: prerequisites
      },
      workflowHistory: history
    }
  }
}
