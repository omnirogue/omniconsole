import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeService } from './session-outcome-service'
import { assertSessionOutcomePlanningSource } from './session-outcome-workflow-source'
import { observeSessionOutcomeSource } from './session-outcome-source'
import { captureInitialSessionOutcomeSource } from './session-outcome-initial-source'
import { prepareSessionOutcomeWorkflow } from './session-outcome-workflow-prepare'
import { materializeSessionOutcomeSourceRepairs } from './session-outcome-source-repairs'
import type { NextStepActor } from '../../shared/next-step-draft'
import { blockSessionOutcomes } from './session-outcome-hold-write'

/** Admission needs the completed source snapshot; arming a plan never finishes its source. */
export async function preparePendingSessionOutcomeWorkflow(
  service: SessionOutcomeService,
  initial: SessionChain,
  now = Date.now()
): Promise<SessionChain | undefined> {
  let chain = initial
  try {
    assertSessionOutcomePlanningSource(service.runtime, chain)
    if (!chain.outcomeSet!.continuation.initialSource) {
      const source = await observeSessionOutcomeSource(service.runtime, chain, {
        successfulOnly: true
      })
      const set = chain.outcomeSet!
      const observed = {
        ...set,
        continuation: {
          ...set.continuation,
          state: source.unverifiable ? ('unverifiable' as const) : ('owned' as const),
          sourceReady: source.ready,
          sourceVersion: source.ready ? source.version : undefined
        }
      }
      chain = service.save(
        {
          ...chain,
          // The source is read again on every tick and the plan starts the moment its turn
          // succeeds: a registered wake, never a question. Lost contact waits on the host instead.
          // A source still working often has no reason to give, and is waited on all the same.
          outcomeSet: !source.ready
            ? blockSessionOutcomes(
                observed,
                (outcome) => outcome.status !== 'satisfied',
                source.reason ?? 'The source session has not finished its turn yet.',
                source.unverifiable
                  ? { class: 'waiting', code: 'source-unverifiable', wake: 'execution host' }
                  : {
                      class: 'waiting',
                      code: source.wait?.code ?? 'source-turn',
                      wake: source.wait?.wake ?? 'source session'
                    },
                now
              )
            : {
                ...observed,
                outcomes: observed.outcomes.map((outcome) => {
                  if (outcome.status === 'satisfied') {
                    return outcome
                  }
                  const { block: _lifted, ...rest } = outcome
                  return { ...rest, status: 'pending' as const, blockedReason: undefined }
                })
              }
        },
        set.revision
      )
      if (!source.ready) {
        return
      }
      const captured = await captureInitialSessionOutcomeSource(service.runtime, chain)
      chain = service.save(captured, captured.outcomeSet!.revision)
    }
    const source = chain.outcomeSet!.continuation.initialSource!
    chain = materializeSessionOutcomeSourceRepairs(chain, {
      agent: source.producer.provider as NextStepActor['agent'],
      model: source.producer.model,
      effort: source.effort
    })
    const prepared = await prepareSessionOutcomeWorkflow(service.runtime, chain)
    if (!prepared.outcomeSet!.workflow) {
      return
    }
    return service.save(
      {
        ...prepared,
        outcomeSet: {
          ...prepared.outcomeSet!,
          outcomes: prepared.outcomeSet!.outcomes.map((outcome) => {
            if (outcome.status !== 'blocked') {
              return outcome
            }
            const { block: _lifted, ...rest } = outcome
            return { ...rest, status: 'pending', blockedReason: undefined }
          })
        }
      },
      prepared.outcomeSet!.revision
    )
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const set = chain.outcomeSet!
    // Admission is asked again on the next tick by itself; one that never clears goes stale.
    service.save(
      {
        ...chain,
        outcomeSet: blockSessionOutcomes(
          set,
          (outcome) => outcome.status !== 'satisfied',
          reason,
          { class: 'recovering', code: 'workflow-admission' },
          now
        )
      },
      set.revision
    )
    return undefined
  }
}
