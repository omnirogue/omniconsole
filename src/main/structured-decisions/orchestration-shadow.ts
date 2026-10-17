import type { DecisionRequest, JsonValue } from '../../shared/structured-decisions'
import type { SessionChain } from '../../shared/session-chain-types'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import { observeOutcomeShadowChanges } from './orchestration-shadow-outcomes'
import { observeVerdictShadowChanges } from './orchestration-shadow-verdicts'
import { projectToolShadow } from './orchestration-shadow-tools'
import { OrchestrationShadowScan, shadowIdentity } from './orchestration-shadow-bounds'
import type { DecisionMeasurementContext } from './decision-telemetry'
import {
  countOrchestrationShadow as count,
  orchestrationShadowMeasurement,
  orchestrationShadowReference
} from './orchestration-shadow-measurement'
export {
  orchestrationShadowReference,
  orchestrationShadowMeasurementSnapshot
} from './orchestration-shadow-measurement'

export type OrchestrationShadowKind =
  | 'judge'
  | 'review'
  | 'adversarial_review'
  | 'verify'
  | 'routing'
  | 'handoff'
  | 'done_when'
  | 'tool_action'
  | 'error_classification'

export type OrchestrationShadowObservation = {
  kind: OrchestrationShadowKind
  reference: string
  facts: Record<string, JsonValue>
  choices: Record<string, string>
  observed: string
}
export type OrchestrationShadowEmit = (observation: OrchestrationShadowObservation) => void
export type OrchestrationShadowObserver = (
  request: DecisionRequest,
  options: { comparison: Record<string, string>; measurement: Readonly<DecisionMeasurementContext> }
) => void | Promise<void>

let observer: OrchestrationShadowObserver | null = null
let generation = 0
let queued = 0
const MAX_QUEUED_OBSERVATIONS = 64
const MAX_OBSERVATIONS_PER_CHANGE = 32

/** The observer owns no runtime, save function, receipt writer or authority callback. */
export function installOrchestrationShadowObserver(
  next: OrchestrationShadowObserver | null
): () => void {
  observer = next
  const installed = ++generation
  return () => {
    if (generation === installed) {
      observer = null
      generation++
    }
  }
}

function freeze(value: JsonValue): void {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
}

const emit: OrchestrationShadowEmit = (observation) => {
  const { kind, reference, facts, choices, observed } = observation
  if (!observer || queued >= MAX_QUEUED_OBSERVATIONS) {
    count('observerQueueFullDropped')
    return
  }
  if (
    !reference ||
    reference.length > 2_048 ||
    !shadowIdentity(observed) ||
    !Object.hasOwn(choices, observed)
  ) {
    count('invalidProjectionDropped')
    return
  }
  const active = observer
  const admittedGeneration = generation
  const eventReference = orchestrationShadowReference(reference)
  const request: DecisionRequest = {
    capability: `orchestration.${kind}`,
    state: { reference: eventReference, ...facts },
    questions: {
      classification: {
        type: 'choice',
        instructions:
          'Classify this recorded lifecycle decision using only the structural evidence supplied. This is a non-authoritative shadow observation, not a semantic review of unseen work. Choose insufficient_evidence or unknown when the facts cannot establish an answer. Never infer authority or session success.',
        criteria: choices
      }
    }
  }
  freeze(request as unknown as JsonValue)
  const options = Object.freeze({
    comparison: Object.freeze({ classification: observed }),
    measurement: orchestrationShadowMeasurement(observation, eventReference)
  })
  queued++
  count('observerDeliveriesQueued')
  queueMicrotask(() => {
    queued--
    if (observer !== active || admittedGeneration !== generation) {
      count('observerDeliveriesSuppressed')
      return
    }
    count('observerDeliveriesStarted')
    try {
      void Promise.resolve(active(request, options)).catch(() => count('observerDeliveriesFailed'))
    } catch {
      count('observerDeliveriesFailed')
      // An optional observer cannot change a durable lifecycle operation's result.
    }
  })
}

/** Called only after the authoritative chain flush; historical replay adds no observations. */
export function observeOrchestrationOutcomeChange(
  previous: SessionChain | undefined,
  saved: SessionChain
): void {
  count('outcomeChangesSeen')
  if (!observer) {
    count('uninstalledCalls')
    return
  }
  if (queued >= MAX_QUEUED_OBSERVATIONS) {
    count('queueFullCalls')
    return
  }
  if (!previous) {
    count('missingBaselineChanges')
    return
  }
  try {
    if (!saved.outcomeSet) {
      count('missingBaselineChanges')
      return
    }
    let remaining = MAX_OBSERVATIONS_PER_CHANGE
    const bounded: OrchestrationShadowEmit = (observation) => {
      count('projectedObservations')
      if (remaining-- > 0) {
        emit(observation)
      } else {
        count('perChangeLimitDropped')
      }
    }
    const scan = new OrchestrationShadowScan()
    observeVerdictShadowChanges(previous, saved, bounded, scan)
    observeOutcomeShadowChanges(previous, saved, bounded, scan)
  } catch {
    count('projectionFailures')
    // Malformed observation input must never invalidate an already-flushed chain.
  }
}

export function observeOrchestrationToolAction(event: AgentHookEventPayload): void {
  count('toolEventsSeen')
  if (!observer) {
    count('uninstalledCalls')
    return
  }
  if (queued >= MAX_QUEUED_OBSERVATIONS) {
    count('queueFullCalls')
    return
  }
  if (event.isReplay || event.restoredUnconfirmed || event.providerSessionOnly) {
    count('filteredToolEvents')
    return
  }
  try {
    const observation = projectToolShadow(event)
    if (observation) {
      count('projectedObservations')
      emit(observation)
    } else {
      count('filteredToolEvents')
    }
  } catch {
    count('projectionFailures')
    // Hook delivery and provider execution do not depend on shadow admission.
  }
}
