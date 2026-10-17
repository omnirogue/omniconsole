import type { AdvertisingDecisionEnvelope } from '../../shared/typesafe-advertising'
import type { RoutineStructuredResult } from '../../shared/routine-structured-result'
import { evaluateAdvertisingRoutine } from '../automations/typesafe-advertising-evaluation'
import type { Store } from '../persistence'
import type { DecisionService } from './decision-service'
import type { DecisionRecords } from './decision-records'
import { classifyRoutineOutput } from './routine-classification'
import { prepareLocalMetaReadPublication } from '../automations/local-meta-read-authority'
import {
  hasUnresolvedAdvertisingAction,
  readRoutineDecisionSource,
  storedAdvertising,
  storedClassification
} from './routine-decision-records'

export type RoutineDecisionPerson = { principal: string; isCurrent(): boolean }
type RoutineAdvertisingEvaluation = { envelope: AdvertisingDecisionEnvelope; source: string | null }
export type RoutineDecisionEvaluationContext = {
  store: Store
  service: DecisionService
  records: DecisionRecords
  notify: (routineId: string) => void
  active: () => boolean
  enabled: (routineId: string, capability: string) => Promise<boolean>
  current: (routineId: string, runId: string, source: string) => boolean
}

function assertPerson(context: RoutineDecisionEvaluationContext, person: RoutineDecisionPerson) {
  if (!context.active() || !person.isCurrent()) {
    throw new Error('The signed-in person changed or structured decisions were disabled.')
  }
}

/** Called synchronously after each awaited authority read and immediately before publication. */
function assertCurrent(
  context: RoutineDecisionEvaluationContext,
  routineId: string,
  runId: string,
  source: string,
  enabled: boolean,
  person?: RoutineDecisionPerson
) {
  if (!enabled || !context.current(routineId, runId, source) || (person && !person.isCurrent())) {
    throw new Error('The routine changed or structured decisions were disabled during evaluation.')
  }
}

/** Resolve asynchronous gates, then revalidate the private grant synchronously before publishing. */
export async function publishRoutineAdvertising<T>(
  context: RoutineDecisionEvaluationContext,
  routineId: string,
  runId: string,
  person: RoutineDecisionPerson,
  result: RoutineAdvertisingEvaluation,
  publish: () => T
): Promise<T> {
  const { envelope, source } = result
  const scope = {
    routineId,
    runId,
    isCurrent: () =>
      context.active() &&
      person.isCurrent() &&
      (source === null || context.current(routineId, runId, source))
  }
  const assertPublication = (enabled: boolean) => {
    assertPerson(context, person)
    if (envelope.principal !== person.principal) {
      throw new Error('The signed-in person changed during evaluation.')
    }
    if (source !== null) {
      assertCurrent(context, routineId, runId, source, enabled, person)
    }
  }
  assertPublication(true)
  let assertPrivateGrant: (() => void) | undefined
  // Submitted signed-action recovery does not depend on local read authority or live mode.
  if (
    source !== null &&
    envelope.decisions.some((decision) => decision.evidence.source === 'local.meta.graph')
  ) {
    assertPrivateGrant = await prepareLocalMetaReadPublication(scope, envelope.policy)
  }
  const enabled = source === null || (await context.enabled(routineId, 'advertising.routine'))
  // Neither gate's asynchronous work can invalidate the other without this final sync fence.
  assertPrivateGrant?.()
  assertPublication(enabled)
  return publish()
}

/** Caller holds the shared run lock through both inference and durable publication. */
export async function evaluateRoutineAdvertising(
  context: RoutineDecisionEvaluationContext,
  routineId: string,
  runId: string,
  person: RoutineDecisionPerson
): Promise<RoutineAdvertisingEvaluation> {
  assertPerson(context, person)
  const saved = await context.records.read(
    'result',
    `${routineId}:${runId}:advertising`,
    storedAdvertising
  )
  assertPerson(context, person)
  const prior = saved?.envelope
  if (
    prior &&
    (prior.routineId !== routineId || prior.runId !== runId || prior.principal !== person.principal)
  ) {
    throw new Error('Sign in as the person whose source evidence produced this recommendation.')
  }
  // Retain submitted writes for readback even when the routine or its live mode changes.
  if (prior && (await hasUnresolvedAdvertisingAction(context.records, prior))) {
    assertPerson(context, person)
    return { envelope: prior, source: null }
  }
  const input = readRoutineDecisionSource(context.store, routineId, runId)
  if (input.settings.contract !== 'advertising.v1') {
    throw new Error('Advertising structured decisions are disabled.')
  }
  assertCurrent(
    context,
    routineId,
    runId,
    input.source,
    await context.enabled(routineId, 'advertising.routine'),
    person
  )
  const scope = {
    routineId,
    runId,
    isCurrent: () =>
      context.active() && person.isCurrent() && context.current(routineId, runId, input.source)
  }
  if (
    prior?.status === 'ready' &&
    saved?.source === input.source &&
    Date.now() - prior.evaluatedAt < input.settings.advertising.maxEvidenceAgeSeconds * 1000
  ) {
    const result = { envelope: prior, source: input.source }
    return publishRoutineAdvertising(context, routineId, runId, person, result, () => result)
  }
  if (input.run.outputSnapshot!.truncated) {
    throw new Error('A complete advertising report is required.')
  }
  const envelope = await evaluateAdvertisingRoutine(
    {
      routineId,
      runId,
      content: input.run.outputSnapshot!.content,
      policy: input.settings.advertising,
      scope
    },
    (request) => context.service.evaluate(request)
  )
  const result = { envelope, source: input.source }
  await publishRoutineAdvertising(context, routineId, runId, person, result, () =>
    context.records.write('result', `${routineId}:${runId}:advertising`, result, storedAdvertising)
  )
  return publishRoutineAdvertising(context, routineId, runId, person, result, () => {
    context.notify(routineId)
    return result
  })
}

export async function evaluateRoutineClassification(
  context: RoutineDecisionEvaluationContext,
  routineId: string,
  runId: string
): Promise<RoutineStructuredResult> {
  const input = readRoutineDecisionSource(context.store, routineId, runId)
  if (input.settings.contract !== 'classification.v1') {
    throw new Error('Routine structured decisions are disabled.')
  }
  assertCurrent(
    context,
    routineId,
    runId,
    input.source,
    await context.enabled(routineId, 'routine.structured')
  )
  const previous = await context.records.read(
    'result',
    `${routineId}:${runId}:classification`,
    storedClassification
  )
  assertCurrent(
    context,
    routineId,
    runId,
    input.source,
    await context.enabled(routineId, 'routine.structured')
  )
  if (previous?.source === input.source && previous.result.status === 'ready') {
    return previous.result
  }
  const result = await classifyRoutineOutput(
    {
      routineId,
      runId,
      sourceRevision: input.source,
      content: input.run.outputSnapshot!.content,
      truncated: input.run.outputSnapshot!.truncated
    },
    (request) => context.service.evaluate(request)
  )
  assertCurrent(
    context,
    routineId,
    runId,
    input.source,
    await context.enabled(routineId, 'routine.structured')
  )
  await context.records.write(
    'result',
    `${routineId}:${runId}:classification`,
    { source: input.source, result },
    storedClassification
  )
  assertCurrent(
    context,
    routineId,
    runId,
    input.source,
    await context.enabled(routineId, 'routine.structured')
  )
  context.notify(routineId)
  return result
}
