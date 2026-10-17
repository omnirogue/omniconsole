import { join } from 'node:path'
import { vi, type Mock } from 'vitest'
import type { SessionFinishChoice } from '../../shared/session-finish-intent'
import type { SessionChain } from '../../shared/session-chain-types'
import { recordSessionOutcomeEvidence } from '../../shared/session-outcome-state'
import type { SessionOutcomeDefinition } from '../../shared/session-outcome-types'
import type { SessionAttentionAnnouncer } from './session-outcome-attention-announce'
import { sessionOutcomeVerifiedEvidence } from './session-outcome-evidence'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'
import { SessionOutcomeService } from './session-outcome-service'

export const T0 = 1_800_000_000_000

/**
 * The real outcome host on a durable profile, with the two things a completion test must control:
 * the host clock and the attention announcer. `restoreFrom` reopens the same profile, which is a
 * restart: a new runtime, a new service epoch, the state read back from disk.
 */
export function completionHarness(restoreFrom?: string) {
  const fixture = outcomeRuntimeFixture(() => ({ body: 'Worked' }), restoreFrom)
  fixture.service.dispose()
  const clock = { now: T0 }
  const announce: Mock<SessionAttentionAnnouncer> = vi.fn()
  const service = new SessionOutcomeService(fixture.runtime, undefined, {
    now: () => clock.now,
    announce
  })
  const start = service.start.bind(service)
  // Driven by hand: a test decides when the host ticks.
  vi.spyOn(service, 'start').mockImplementation(() => {})
  vi.spyOn(fixture.runtime, 'getSessionOutcomeService').mockReturnValue(service)
  const chain = (id = 'chain', sourcePaneKey = 'source'): SessionChain => ({
    id,
    workspacePath: fixture.workspace,
    worktreeId: 'folder:outcome',
    hostId: 'local',
    sourcePaneKey,
    sourceRowKey: `row:${sourcePaneKey}`,
    auto: true,
    steps: [],
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1
  })
  const definition = (file = 'result.txt', id = 'result'): SessionOutcomeDefinition => ({
    id,
    title: 'Result',
    finish: 'complete',
    dependsOn: [],
    actions: [],
    conditions: [{ id: 'file', kind: 'file', target: join(fixture.workspace, file) }]
  })
  const tick = async (): Promise<void> => {
    await service.tick()
    await service.launches.settled()
  }
  return {
    ...fixture,
    service,
    clock,
    announce,
    /** The unmocked start, for the tests that are about a ticking host. */
    start,
    chain,
    definition,
    tick,
    commit: (sessionFinish?: SessionFinishChoice) =>
      service.commit(chain(), {
        source: 'user',
        expectedRevision: 0,
        outcomes: [definition()],
        ...(sessionFinish ? { sessionFinish } : {})
      }),
    /** Commit, produce the proof, and let the host verify it: the ordinary way a run completes. */
    complete: async (sessionFinish?: SessionFinishChoice): Promise<SessionChain> => {
      await service.commit(chain(), {
        source: 'user',
        expectedRevision: 0,
        outcomes: [definition()],
        ...(sessionFinish ? { sessionFinish } : {})
      })
      fixture.write('result.txt', 'Verified result')
      // A finish binds the source turn as a second criterion, which may take a pass of its own.
      for (let pass = 0; pass < 3 && service.get('chain').state !== 'done'; pass++) {
        await tick()
      }
      return service.get('chain')
    },
    /**
     * The record a crash or an older build leaves behind: the proof is durable, the terminal write
     * is not — still `waiting`, still carrying the old diagnostic, never sealed.
     */
    seedProvenButWaiting: async (error: string): Promise<SessionChain> => {
      await service.commit(chain(), {
        source: 'user',
        expectedRevision: 0,
        outcomes: [definition()]
      })
      const committed = service.get('chain')
      const outcome = committed.outcomeSet!.outcomes[0]!
      return fixture.runtime.replaceSessionChainOutcomesAndFlush(
        {
          ...committed,
          state: 'waiting',
          error,
          outcomeSet: recordSessionOutcomeEvidence(
            committed.outcomeSet!,
            sessionOutcomeVerifiedEvidence(outcome, outcome.conditions[0]!, 'sha256:seeded', T0)
          )
        },
        1
      )
    },
    stop: async (): Promise<void> => {
      await service.suspend()
      fixture.closeDatabase()
    }
  }
}

export type CompletionHarness = ReturnType<typeof completionHarness>
