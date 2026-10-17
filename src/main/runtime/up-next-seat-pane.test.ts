/**
 * The pane a HOST-launched seat is running in, on the step itself.
 *
 * Three readers join a pane to the step it is by `launchedPaneKey` — the session-activity row,
 * the team summary and the chain registry — and only the renderer launcher ever wrote it. A
 * seat the host launched carries a Dispatch instead, so those readers had nothing to join for
 * every outcome-bound seat. The tick's own whole-chain save writes it once, from the Dispatch
 * the host already reads, and never over a pane the launcher named.
 */
import { expect, it } from 'vitest'
import { sessionOutcomeStepActionId } from '../../shared/session-outcome-identity'
import type { SessionChain, SessionChainAgentStep } from '../../shared/session-chain-types'
import type { SessionOutcomeAttempt } from '../../shared/session-outcome-types'
import type { OrcaRuntimeService } from './omni-runtime'
import { upNextStampedSeatPanes } from './up-next-stage-seat'

const seat = (over: Partial<SessionChainAgentStep> = {}): SessionChainAgentStep =>
  ({
    id: 's1',
    agent: 'claude',
    prompt: 'Work.',
    status: 'launched',
    ...over
  }) as SessionChainAgentStep

const attempt = (over: Partial<SessionOutcomeAttempt> = {}): SessionOutcomeAttempt =>
  ({
    id: 'a1',
    outcomeId: 'o1',
    actionId: sessionOutcomeStepActionId('s1'),
    actionKey: 'k1',
    outcomeRevision: 1,
    state: 'running',
    dispatchId: 'dsp_1',
    startedAt: 1,
    updatedAt: 2,
    ...over
  }) as SessionOutcomeAttempt

function chainOf(steps: SessionChainAgentStep[], attempts: SessionOutcomeAttempt[]): SessionChain {
  return {
    id: 'source_1',
    workspacePath: '/w',
    worktreeId: 'wt',
    hostId: 'local',
    sourcePaneKey: 'tab-1:leaf-1',
    sourceRowKey: JSON.stringify(['local', 'wt', 'tab-1:leaf-1']),
    auto: true,
    steps,
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 2,
    outcomeSet: {
      schemaVersion: 1,
      revision: 1,
      outcomes: [],
      removals: [],
      attempts,
      continuation: { owner: 'execution-host', hostId: 'local', epoch: 'e1', state: 'owned' },
      updatedAt: 2
    }
  } as unknown as SessionChain
}

/** The orchestration db as the host reads it: the Dispatch row names the assignee's pane. */
const runtime = (paneKey: string | null): OrcaRuntimeService =>
  ({
    getOrchestrationDb: () => ({
      getDispatchContextById: () => (paneKey ? { assignee_pane_key: paneKey } : null),
      getDispatchContext: () => (paneKey ? { assignee_pane_key: paneKey } : null)
    })
  }) as unknown as OrcaRuntimeService

it('writes the pane the Dispatch was assigned', () => {
  const stamped = upNextStampedSeatPanes(runtime('tab-9:leaf-1'), chainOf([seat()], [attempt()]))
  expect(stamped.steps[0]).toMatchObject({ id: 's1', launchedPaneKey: 'tab-9:leaf-1' })
})

it('never overwrites the pane the launcher named', () => {
  const chain = chainOf([seat({ launchedPaneKey: 'tab-1:leaf-2' })], [attempt()])
  expect(upNextStampedSeatPanes(runtime('tab-9:leaf-1'), chain)).toBe(chain)
})

it('writes nothing when the Dispatch has no pane yet, and asks again next tick', () => {
  const chain = chainOf([seat()], [attempt()])
  expect(upNextStampedSeatPanes(runtime(null), chain)).toBe(chain)
  expect(upNextStampedSeatPanes(runtime('tab-9:leaf-1'), chain).steps[0]).toMatchObject({
    launchedPaneKey: 'tab-9:leaf-1'
  })
})

it('writes nothing for a seat the host has not launched', () => {
  const chain = chainOf([seat({ status: 'queued' })], [])
  expect(upNextStampedSeatPanes(runtime('tab-9:leaf-1'), chain)).toBe(chain)
})

it('never claims a pane from an attempt a newer plan version retired', () => {
  const chain = chainOf([seat()], [attempt({ state: 'superseded' })])
  expect(upNextStampedSeatPanes(runtime('tab-9:leaf-1'), chain)).toBe(chain)
})

it('is not an error on a host with no orchestration database', () => {
  const chain = chainOf([seat()], [attempt()])
  expect(upNextStampedSeatPanes({} as OrcaRuntimeService, chain)).toBe(chain)
})
