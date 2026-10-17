import {
  routeSessionOutcomeDefaultModel,
  type SessionOutcomeModelRouter,
  type OutcomeRoutingActor
} from './session-outcome-model-router'
import { checkAgentLaunchPreferences } from '../../shared/agent-launch-preference-check'
import type { CommitMessageModelCapability } from '../../shared/commit-message-agent-spec'
import type { SessionChain, SessionChainAgentStep } from '../../shared/session-chain-types'
import type { SessionOutcomeCommit } from '../../shared/session-outcome-types'
import type { OrcaRuntimeService } from './omni-runtime'
import { sessionOutcomeAmendmentSources } from './session-outcome-workflow-sources'
import type { SessionOutcomePredecessor } from './session-outcome-workflow-compile'
import { NEXT_STEP_MAX_REVIEWERS } from '../../shared/next-step-draft'

type Actor = OutcomeRoutingActor
type Slot = Actor[]
type ModelDiscovery = Pick<OrcaRuntimeService, 'discoverRuntimeCommitMessageModels'> &
  SessionOutcomeModelRouter

function explicitModel(slot: Slot): string | undefined {
  if (
    slot.some(
      (actor) =>
        JSON.stringify(actor.openrouterCandidates) !== JSON.stringify(slot[0]!.openrouterCandidates)
    )
  ) {
    throw new Error(
      'A reviewer must retain its exact ordered OpenRouter route across review rounds.'
    )
  }
  const models = new Set(slot.map((actor) => actor.model).filter(Boolean))
  if (models.size > 1 || slot.some((actor) => actor.agent !== slot[0]!.agent)) {
    throw new Error('A reviewer must retain the same agent and model across its review rounds.')
  }
  return models.values().next().value
}

function supportsModel(actor: Actor, model: CommitMessageModelCapability): boolean {
  return (
    checkAgentLaunchPreferences(actor.agent, { model: model.id, effort: actor.effort }).ok &&
    (!actor.effort || Boolean(model.thinkingLevels?.some((level) => level.id === actor.effort)))
  )
}

/** Pin optional choices on the owning host before revision identities and admission are computed. */
export async function resolveSessionOutcomeDefaultModels(
  runtime: ModelDiscovery,
  originalChain: SessionChain,
  originalInput: SessionOutcomeCommit,
  previous?: SessionChain
): Promise<{ chain: SessionChain; input: SessionOutcomeCommit }> {
  const chain = structuredClone(originalChain)
  const input = structuredClone(originalInput)
  const steps = chain.steps.filter((step): step is SessionChainAgentStep => step.kind !== 'handoff')
  const actions = input.outcomes.flatMap((outcome) => outcome.actions)
  if ([...steps, ...actions].every((actor) => actor.model)) {
    return { chain, input }
  }
  const prior = previous?.outcomeSet
  const sources = prior?.workflow
    ? sessionOutcomeAmendmentSources(
        {
          ...chain,
          outcomeSet: {
            ...prior,
            // Source selection reads draft ownership; execution evidence still comes from prior receipts.
            outcomes: input.outcomes.map((outcome) => ({
              ...outcome,
              revision: 1,
              status: 'pending',
              evidence: []
            }))
          }
        },
        chain.steps,
        [...(prior.workflowHistory ?? []), prior.workflow]
      )
    : new Map<string, SessionOutcomePredecessor>()
  const probes = new Map<Actor['agent'], Promise<CommitMessageModelCapability[]>>()
  const discover = (agent: Actor['agent']) => {
    let probe = probes.get(agent)
    if (!probe) {
      probe = runtime
        .discoverRuntimeCommitMessageModels(`id:${chain.worktreeId}`, agent)
        .then((result) => {
          if (!result.success || result.catalogOrigin !== 'probe' || !result.models.length) {
            throw new Error(`The execution host could not discover available ${agent} models.`)
          }
          const preferred =
            result.models.find((model) => model.isDefault)?.id ?? result.defaultModelId
          return result.models.toSorted(
            (a, b) => Number(b.id === preferred) - Number(a.id === preferred)
          )
        })
      probes.set(agent, probe)
    }
    return probe
  }
  const resolve = async (slots: Slot[], allowRouting = false) => {
    const choices = await Promise.all(
      slots.map(async (slot) => {
        const fixed = explicitModel(slot)
        if (fixed) {
          return [fixed]
        }
        const first = slot[0]!
        if (!['codex', 'claude', 'grok', 'omp'].includes(first.agent) || first.accountChoiceId) {
          throw new Error('This task plan requires a supported agent without an account override.')
        }
        const models = await discover(first.agent)
        const routed = allowRouting
          ? await routeSessionOutcomeDefaultModel(runtime, chain, first, models)
          : undefined
        if (routed) {
          return [routed]
        }
        return [
          ...new Set(
            models
              .filter((model) => slot.every((actor) => supportsModel(actor, model)))
              .map((model) => model.id)
          )
        ]
      })
    )
    const selected = choices.map((models) => models[0])
    if (selected.some((model) => !model)) {
      throw new Error(
        'The execution host has no available model compatible with the selected agent and effort.'
      )
    }
    slots.forEach((slot, index) => {
      for (const actor of slot) {
        actor.model ??= selected[index]
      }
    })
  }
  const assigned = new Set<Actor>()
  for (const first of steps) {
    if (!first.review || assigned.has(first)) {
      continue
    }
    const group = steps.filter((step) => step.review?.groupId === first.review!.groupId)
    const reviewers = new Map<string, Slot>()
    for (const reviewer of group) {
      const id = reviewer.review!.reviewerId
      reviewers.set(id, [...(reviewers.get(id) ?? []), reviewer])
    }
    if (reviewers.size > NEXT_STEP_MAX_REVIEWERS) {
      throw new Error('Canonical reviews support up to five reviewers.')
    }
    const preceding = steps[steps.indexOf(first) - 1]
    const producer =
      preceding &&
      !preceding.review &&
      !preceding.reviewRepair &&
      input.outcomes.some(
        (outcome) => outcome.stepIds?.includes(first.id) && outcome.stepIds.includes(preceding.id)
      )
        ? preceding
        : undefined
    const source = sources.get(first.id)
    const sourceActor: Actor | undefined = source
      ? {
          agent: source.receipt.provider as Actor['agent'],
          model: source.receipt.model,
          effort: source.effort
        }
      : undefined
    const builder = producer ?? sourceActor
    const repairs = steps.filter(
      (step) =>
        step.reviewRepair?.groupId === first.review!.groupId &&
        !step.model &&
        step.agent === builder?.agent
    )
    const slots = [...(builder ? [[builder, ...repairs]] : []), ...reviewers.values()]
    await resolve(slots)
    for (const repair of repairs) {
      repair.effort ??= builder?.effort
    }
    slots.flat().forEach((actor) => assigned.add(actor))
  }
  const remaining: Actor[] = [...steps.filter((step) => !assigned.has(step)), ...actions]
  const ordinary = new Set<Actor>([
    ...steps.filter((step) => !step.review && !step.reviewRepair),
    ...actions
  ])
  await Promise.all(remaining.map((actor) => resolve([[actor]], ordinary.has(actor))))
  return { chain, input }
}
