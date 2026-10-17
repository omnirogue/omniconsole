import {
  forkFinishedOutcomeSource,
  restatesSealedOutcomeSource
} from './session-outcome-source-uniqueness'
import { attachOutcomeToTask } from './session-outcome-task-ref'
import { admitSessionOutcomeCommit } from './session-outcome-commit-admission'
import { prepareOutcomePlanVersion, markSupersededPlanSteps } from './session-outcome-plan-version'
import { bindSessionFinishSource, rebindSessionFinishSource } from './session-outcome-finish-source'
import { sessionOutcomeCommitOwner } from './session-outcome-commit-owner'
import { prepareSessionOutcomeSourceRepairs } from './session-outcome-source-repair-prepare'
import { restoreSessionOutcomeSourceRepairs } from './session-outcome-source-repair-revision'
import {
  blockSessionOutcomeSourceCapture,
  prepareSessionOutcomeSourcePacket
} from './session-outcome-source-packet'
import { appendInferredSessionReviews } from './session-outcome-inferred-reviews'
import { resolveSessionOutcomeDefaultModels } from './session-outcome-default-models'
import { prepareSessionOutcomeWorkflow } from './session-outcome-workflow-prepare'
import { assertSessionOutcomeExecutionScope } from './session-outcome-host-boundary'
import {
  assertSessionOutcomeInferredConditions,
  sessionOutcomeQuotedInstruction
} from './session-outcome-inferred-authority'
import { resolveSessionOutcomeSourceReadiness } from './session-outcome-source-readiness'
import { reconcileSessionOutcomeSteps } from './session-outcome-revision'
import { expandSessionOutcomeTeamPlan } from './session-outcome-team-plan'
import { readSessionOutcomePrincipal } from './session-outcome-handoff'
import { normalizeSessionChain, type SessionChain } from '../../shared/session-chain-types'
import {
  reviseSessionOutcomeSet,
  validateSessionOutcomeDefinitions
} from '../../shared/session-outcome-state'
import type { SessionOutcomeCommit } from '../../shared/session-outcome-types'
import type { SessionOutcomeService } from './session-outcome-service'
import { sessionOutcomeParallelConsent } from './session-outcome-concurrency'
import {
  appendInferredSessionHandoffs,
  isNewInferredPersonCondition,
  readInferredSessionHandoffs
} from './session-outcome-inferred-handoff'
import { prepareInferredSessionWaits } from './session-outcome-inferred-waits'
import { assertSessionWaitAdmission } from '../session-steward/session-wait-admission'

export async function commitSessionOutcomeSet(
  service: SessionOutcomeService,
  base: SessionChain,
  input: SessionOutcomeCommit,
  authorityInstruction?: string,
  refreshAuthority?: () => string | undefined
): Promise<SessionChain> {
  input = admitSessionOutcomeCommit(input, authorityInstruction, refreshAuthority)
  const restated = restatesSealedOutcomeSource(service.runtime.listSessionChains(), base, input)
  if (restated) {
    // Success already proven is not run twice; only the filing, which a seal allows, is applied.
    return fileSessionOutcomeCommit(service, restated, input)
  }
  ;({ base, input } = forkFinishedOutcomeSource(service.runtime.listSessionChains(), base, input))
  const old = service.runtime.listSessionChains().find((entry) => entry.id === base.id)
  ;({ base, input } = await expandSessionOutcomeTeamPlan({
    base,
    input,
    authorityInstruction,
    discover: (selector, agent) =>
      service.runtime.discoverRuntimeCommitMessageModels(selector, agent),
    now: Date.now()
  }))
  if (base.steps.length && input.outcomes.length === 1 && !input.outcomes[0]!.stepIds) {
    input = {
      ...input,
      outcomes: [{ ...input.outcomes[0]!, stepIds: base.steps.map((step) => step.id) }]
    }
  }
  ;({ base, input } = prepareOutcomePlanVersion(base, old, input))
  validateSessionOutcomeDefinitions(input.outcomes)
  const stepIds = input.outcomes.flatMap((outcome) => outcome.stepIds ?? [])
  if (
    new Set(stepIds).size !== stepIds.length ||
    stepIds.some((id) => !base.steps.some((step) => step.id === id)) ||
    base.steps.some((step) => !stepIds.includes(step.id))
  ) {
    throw new Error('Every Next step must belong to exactly one outcome.')
  }
  if (
    input.expectedExecutionRuntimeId &&
    input.expectedExecutionRuntimeId !== service.runtime.getRuntimeId()
  ) {
    throw new Error('Execution runtime changed before durable commit.')
  }
  await assertSessionOutcomeExecutionScope(service.runtime, base)
  if (
    old &&
    ['workspacePath', 'worktreeId', 'hostId', 'sourcePaneKey', 'sourceWorktreeId'].some(
      (key) => old[key as keyof SessionChain] !== base[key as keyof SessionChain]
    )
  ) {
    throw new Error('An outcome revision cannot change its execution identity.')
  }
  const inferredHandoffs =
    input.source === 'ai' &&
    input.outcomes.some((outcome) =>
      outcome.conditions.some((condition) =>
        isNewInferredPersonCondition(condition, outcome.id, old)
      )
    )
      ? await readInferredSessionHandoffs(authorityInstruction ?? '')
      : { handoffs: [], unresolvedRecipients: [], principal: undefined }
  const inferredWaits = await prepareInferredSessionWaits(input, old, authorityInstruction)
  input = inferredWaits.input
  assertSessionOutcomeInferredConditions(
    input,
    old,
    authorityInstruction,
    inferredHandoffs.handoffs,
    inferredWaits.waits
  )
  assertSessionWaitAdmission(service.runtime, base, input, old)
  if (
    input.source === 'ai' &&
    input.outcomes.some((outcome) =>
      outcome.actions.some(
        (action) =>
          !old?.outcomeSet?.outcomes.some((prior) =>
            prior.actions.some((allowed) => allowed.instruction === action.instruction)
          ) &&
          !old?.steps.some(
            (step) => step.kind !== 'handoff' && step.prompt === action.instruction
          ) &&
          !sessionOutcomeQuotedInstruction(action.instruction, authorityInstruction)
      )
    )
  ) {
    throw new Error(
      'AI-inferred actions need existing user-authorized chain instructions; inference cannot grant new authority. Quote the person\'s own words exactly (12+ characters), e.g. copy "tell me the current time" from their message, rather than rewording it.'
    )
  }
  input = bindSessionFinishSource(input, base)
  const principal = await readSessionOutcomePrincipal()
  if (
    (inferredHandoffs.principal && inferredHandoffs.principal !== principal) ||
    (inferredWaits.principal && inferredWaits.principal !== principal)
  ) {
    throw new Error('The signed person changed while resolving the handoff recipient.')
  }
  if (
    old?.outcomeSet?.continuation.principal &&
    old.outcomeSet.continuation.principal !== principal
  ) {
    throw new Error('Restore the original signed company/person before editing these outcomes.')
  }
  if (base.steps.some((step) => step.kind === 'handoff') && !principal) {
    throw new Error('Sign in before committing a person handoff.')
  }
  const owner = await sessionOutcomeCommitOwner(
    service.runtime,
    base,
    old,
    input,
    principal,
    service.epoch
  )
  const restored = restoreSessionOutcomeSourceRepairs(base, old, input)
  base = restored.chain
  input = restored.input
  if (owner.planningSource) {
    const resolved = await resolveSessionOutcomeDefaultModels(service.runtime, base, input, old)
    base = resolved.chain
    input = resolved.input
  }
  let reconciled = reconcileSessionOutcomeSteps(base, old, input, authorityInstruction)
  if (input.source === 'ai' && inferredHandoffs.handoffs.length) {
    const expanded = appendInferredSessionHandoffs({
      chain: { ...base, steps: reconciled.steps },
      input: reconciled.input,
      old,
      prompt: authorityInstruction!,
      handoffs: inferredHandoffs.handoffs,
      ...(inferredHandoffs.handoffs.some((request) => request.includeTranscript)
        ? { transcriptSource: service.runtime.getSessionOutcomeTranscriptSource(base) }
        : {})
    })
    base = expanded.chain
    reconciled = { steps: base.steps, input: expanded.input }
  }
  if (input.reviewPlans?.length) {
    const expanded = appendInferredSessionReviews({
      chain: { ...base, steps: reconciled.steps },
      input: reconciled.input,
      previous: old,
      authorityInstruction
    })
    base = expanded.chain
    reconciled = { steps: base.steps, input: expanded.input }
  }
  input = reconciled.input
  let outcomeSet = reviseSessionOutcomeSet(
    old?.outcomeSet,
    { ...input, taskRef: undefined },
    owner,
    Date.now()
  )
  // An explicit finish submission invalidates the stored source receipt so it must be rebound to
  // the current turn. That also disqualifies it as the readiness fallback below: a receipt this
  // commit just discarded cannot be what stands in for an unverifiable observation.
  outcomeSet = rebindSessionFinishSource(outcomeSet, input)
  outcomeSet = (await prepareSessionOutcomeSourcePacket(service.runtime, { ...base, outcomeSet }))
    .outcomeSet!
  const priorReadiness =
    old?.outcomeSet?.continuation.sourceReady && !input.sessionFinish
      ? {
          sourceReady: true,
          ...(old.outcomeSet.continuation.sourceVersion
            ? { sourceVersion: old.outcomeSet.continuation.sourceVersion }
            : {})
        }
      : {}
  const source = await resolveSessionOutcomeSourceReadiness(
    service.runtime,
    {
      ...base,
      outcomeSet: {
        ...outcomeSet,
        continuation: { ...outcomeSet.continuation, ...priorReadiness }
      }
    },
    // With a planning source, only a successful completion counts: a terminal that merely
    // exited is not a finished source. Threaded through the readiness resolver so #289's
    // always-fresh observation cannot quietly drop this refusal.
    owner.planningSource ? { successfulOnly: true } : undefined
  )
  outcomeSet = {
    ...outcomeSet,
    continuation: {
      ...outcomeSet.continuation,
      ...(source.ready
        ? { sourceReady: true, ...(source.version ? { sourceVersion: source.version } : {}) }
        : {})
    }
  }
  const completedSteps = outcomeSet.completedSteps ?? []
  const nextIndex = reconciled.steps.findIndex((step) => !completedSteps.includes(step.id))
  let chain = normalizeSessionChain({
    ...(old ?? base),
    ...(input.supersede
      ? { planVersion: base.planVersion, planVersions: base.planVersions, end: base.end }
      : {}),
    // How the chain ends is part of the plan this commit submits, not only of a superseding
    // one: a stage APPENDED with "end this session on success" moves the finish, and a chain
    // that kept the old disposition would hand the work back instead of closing.
    ...(!input.supersede && base.end !== undefined && base.end !== old?.end
      ? { end: base.end }
      : {}),
    steps: reconciled.steps,
    currentIndex: nextIndex === -1 ? reconciled.steps.length : nextIndex,
    outcomeSet,
    // Why: consent provenance comes only from this host's expansion or its own record, never the caller's chain.
    teamPlanning: input.teamPlanning ?? old?.teamPlanning,
    // Never taken from the caller's chain: consent to run outcomes side by side is a person's commit.
    parallelOutcomeIds: sessionOutcomeParallelConsent(input, old)
  })
  if (
    !chain ||
    chain.steps.length !== reconciled.steps.length ||
    new Set(chain.steps.map((step) => step.id)).size !== chain.steps.length
  ) {
    throw new Error('Invalid session chain; the last committed set was preserved.')
  }
  if (input.supersede && old) {
    chain = markSupersededPlanSteps(chain, old, input.drawsSteps)
  }
  // #284 (720690b3e) holds EVERY first admission for the tick: a card-attached plan is admissible
  // only once its own planning source has successfully completed and been captured into
  // continuation.initialSource, which only preparePendingSessionOutcomeWorkflow can do — a save
  // cannot finish the session that authored it. What is re-prepared here is an already admitted
  // generation, because reviseSessionOutcomeSet rebuilds the set without its workflow and the
  // saved graph would otherwise be dropped by the edit. 5681b13f4 widened this to every plan the
  // host route does not claim, which admitted a first save before any source capture.
  if (owner.planningSource && old?.outcomeSet?.workflow) {
    chain = await prepareSessionOutcomeWorkflow(service.runtime, chain, old)
  }
  try {
    chain = await prepareSessionOutcomeSourcePacket(service.runtime, chain)
    chain = await prepareSessionOutcomeSourceRepairs(service.runtime, chain)
  } catch (error) {
    chain = blockSessionOutcomeSourceCapture(chain, error, service.now())
  }
  if (input.source === 'ai' && refreshAuthority && refreshAuthority() !== authorityInstruction) {
    throw new Error('Source authority changed before durable commit. Read outcome context again.')
  }
  if (
    inferredHandoffs.principal &&
    (await readSessionOutcomePrincipal()) !== inferredHandoffs.principal
  ) {
    throw new Error('The signed person changed before the handoff was committed.')
  }
  let saved = service.save(chain, input.expectedRevision)
  if (input.taskRef) {
    saved = await fileSessionOutcomeCommit(service, saved, input)
  }
  service.start()
  return saved
}

async function fileSessionOutcomeCommit(
  service: SessionOutcomeService,
  saved: SessionChain,
  input: SessionOutcomeCommit
): Promise<SessionChain> {
  if (!input.taskRef) {
    return saved
  }
  const access = await service.taskAttachment(service.runtime, saved)
  for (const outcome of input.outcomes) {
    saved = await attachOutcomeToTask(
      { ...access, taskRef: input.taskRef },
      saved.id,
      outcome.id,
      input.taskRef.taskId
    )
  }
  return saved
}
