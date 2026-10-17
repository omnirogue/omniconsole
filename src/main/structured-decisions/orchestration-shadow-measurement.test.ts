import { afterEach, describe, expect, it, vi } from 'vitest'
import { planReportChain } from '../../shared/__fixtures__/work-plan/plan-report-chain'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import {
  installOrchestrationShadowObserver,
  observeOrchestrationOutcomeChange,
  observeOrchestrationToolAction,
  type OrchestrationShadowObserver
} from './orchestration-shadow'
import { OrchestrationShadowScan, ORCHESTRATION_SHADOW_LIMITS } from './orchestration-shadow-bounds'
import { orchestrationShadowMeasurementSnapshot } from './orchestration-shadow-measurement'

const PRIVATE = 'PRIVATE_MEASUREMENT_CONTENT'

function tool(overrides: Partial<AgentHookEventPayload> = {}): AgentHookEventPayload {
  return {
    paneKey: 'private-pane-identity',
    connectionId: null,
    hookEventName: 'PreToolUse',
    payload: { state: 'working', prompt: PRIVATE, toolName: 'Bash', toolInput: PRIVATE },
    ...overrides
  }
}

afterEach(async () => {
  installOrchestrationShadowObserver(null)
  await Promise.resolve()
  await Promise.resolve()
})

describe('orchestration shadow measurement', () => {
  it('joins repeated structural projections with frozen fingerprints independent of private content', async () => {
    const observer = vi.fn<OrchestrationShadowObserver>()
    installOrchestrationShadowObserver(observer)
    observeOrchestrationToolAction(tool())
    observeOrchestrationToolAction(
      tool({ payload: { state: 'working', prompt: 'different private prompt', toolName: 'Bash' } })
    )
    observeOrchestrationToolAction(
      tool({ payload: { state: 'working', prompt: PRIVATE, toolName: 'Bash', failed: true } })
    )
    await Promise.resolve()
    expect(observer.mock.calls).toHaveLength(3)
    const [first, repeated, changed] = observer.mock.calls.map(([, options]) => options.measurement)
    expect(first).toMatchObject({
      eventFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      eventReference: expect.stringMatching(/^[a-f0-9]{64}$/),
      baselineSource: 'tool_name_classifier',
      evidenceScope: 'structural_metadata',
      projectionVersion: 'orchestration-structural-v2'
    })
    expect(repeated!.eventFingerprint).toBe(first!.eventFingerprint)
    expect(changed!.eventFingerprint).not.toBe(first!.eventFingerprint)
    for (const [request, options] of observer.mock.calls) {
      expect(Object.isFrozen(options)).toBe(true)
      expect(Object.isFrozen(options.measurement)).toBe(true)
      expect(Object.isFrozen(options.comparison)).toBe(true)
      expect(request.state).toHaveProperty('reference', options.measurement.eventReference)
      expect(JSON.stringify({ request, measurement: options.measurement })).not.toContain(PRIVATE)
      expect(JSON.stringify(request.state)).not.toContain('private-pane-identity')
      expect(request.state).not.toHaveProperty('comparison')
      expect(request.state).not.toHaveProperty('measurement')
      expect(request.state).not.toHaveProperty('observed')
    }
  })

  it('distinguishes uninstalled calls, missing baselines and filtered tool events', async () => {
    installOrchestrationShadowObserver(null)
    const before = orchestrationShadowMeasurementSnapshot()
    const chain = planReportChain()
    observeOrchestrationToolAction(tool())
    observeOrchestrationOutcomeChange(undefined, chain)
    const uninstalled = orchestrationShadowMeasurementSnapshot()
    expect(uninstalled.scope).toBe('process_since_start')
    expect(uninstalled.counters.uninstalledCalls - before.counters.uninstalledCalls).toBe(2)
    expect(uninstalled.counters.toolEventsSeen - before.counters.toolEventsSeen).toBe(1)
    expect(uninstalled.counters.outcomeChangesSeen - before.counters.outcomeChangesSeen).toBe(1)
    installOrchestrationShadowObserver(vi.fn())
    observeOrchestrationOutcomeChange(undefined, chain)
    observeOrchestrationToolAction(tool({ isReplay: true }))
    observeOrchestrationToolAction(tool({ hookEventName: 'Stop' }))
    const after = orchestrationShadowMeasurementSnapshot()
    expect(
      after.counters.missingBaselineChanges - uninstalled.counters.missingBaselineChanges
    ).toBe(1)
    expect(after.counters.filteredToolEvents - uninstalled.counters.filteredToolEvents).toBe(2)
    expect(after.counters.observerDeliveriesQueued).toBe(before.counters.observerDeliveriesQueued)
    expect(uninstalled.counters.uninstalledCalls).toBe(before.counters.uninstalledCalls + 2)
  })

  it('counts queue saturation before inspecting any chain source', async () => {
    const observer = vi.fn()
    installOrchestrationShadowObserver(observer)
    const before = orchestrationShadowMeasurementSnapshot()
    for (let index = 0; index < 65; index++) {
      observeOrchestrationToolAction(tool())
    }
    let sourceReads = 0
    const chain = new Proxy(planReportChain(), {
      get() {
        sourceReads++
        throw new Error('Full queue inspected a chain')
      }
    })
    observeOrchestrationOutcomeChange(chain, chain)
    const queued = orchestrationShadowMeasurementSnapshot()
    expect(sourceReads).toBe(0)
    expect(queued.counters.queueFullCalls - before.counters.queueFullCalls).toBe(2)
    expect(
      queued.counters.observerDeliveriesQueued - before.counters.observerDeliveriesQueued
    ).toBe(64)
    expect(queued.counters.sourceEntriesInspected).toBe(before.counters.sourceEntriesInspected)
    expect(queued.counters.observerDeliveriesStarted).toBe(
      before.counters.observerDeliveriesStarted
    )
    await Promise.resolve()
    const delivered = orchestrationShadowMeasurementSnapshot()
    expect(
      delivered.counters.observerDeliveriesStarted - before.counters.observerDeliveriesStarted
    ).toBe(64)
    expect(observer.mock.calls).toHaveLength(64)
  })

  it('counts suppressed deliveries separately from throwing and rejected observers', async () => {
    const first = vi.fn()
    installOrchestrationShadowObserver(first)
    const before = orchestrationShadowMeasurementSnapshot()
    observeOrchestrationToolAction(tool())
    installOrchestrationShadowObserver(() => {
      throw new Error('Synchronous observer failure')
    })
    observeOrchestrationToolAction(tool())
    await Promise.resolve()
    const sync = orchestrationShadowMeasurementSnapshot()
    expect(first).not.toHaveBeenCalled()
    expect(
      sync.counters.observerDeliveriesSuppressed - before.counters.observerDeliveriesSuppressed
    ).toBe(1)
    expect(
      sync.counters.observerDeliveriesStarted - before.counters.observerDeliveriesStarted
    ).toBe(1)
    expect(sync.counters.observerDeliveriesFailed - before.counters.observerDeliveriesFailed).toBe(
      1
    )
    installOrchestrationShadowObserver(async () => {
      throw new Error('Asynchronous observer failure')
    })
    observeOrchestrationToolAction(tool())
    await Promise.resolve()
    await Promise.resolve()
    const after = orchestrationShadowMeasurementSnapshot()
    expect(after.counters.observerDeliveriesFailed - sync.counters.observerDeliveriesFailed).toBe(1)
  })

  it('counts omitted source entries once per sample without treating them as lost events', () => {
    const before = orchestrationShadowMeasurementSnapshot()
    const source = Array.from({ length: 1_000 }, (_, index) => index)
    const scan = new OrchestrationShadowScan()
    const sample = scan.tail(source)
    expect(scan.tail(source)).toBe(sample)
    const after = orchestrationShadowMeasurementSnapshot()
    expect(after.counters.sourceArraysSampled - before.counters.sourceArraysSampled).toBe(1)
    expect(after.counters.sourceEntriesInspected - before.counters.sourceEntriesInspected).toBe(
      ORCHESTRATION_SHADOW_LIMITS.entries
    )
    expect(after.counters.sourceEntriesOmitted - before.counters.sourceEntriesOmitted).toBe(
      source.length - ORCHESTRATION_SHADOW_LIMITS.entries
    )
    expect(after.counters.sourceArraysTruncated - before.counters.sourceArraysTruncated).toBe(1)
    expect(after.counters.projectedObservations).toBe(before.counters.projectedObservations)
    expect(sample.values).toEqual(source.slice(-ORCHESTRATION_SHADOW_LIMITS.entries))
  })

  it('counts projected observations beyond the per-change limit separately from queued deliveries', async () => {
    const observer = vi.fn()
    installOrchestrationShadowObserver(observer)
    const before = planReportChain()
    const attempt = before.outcomeSet!.attempts[0]!
    before.steps = []
    before.verdicts = []
    before.outcomeSet!.outcomes = []
    before.outcomeSet!.attempts = []
    const after = structuredClone(before)
    after.outcomeSet!.attempts = Array.from({ length: 32 }, (_, index) => ({
      ...attempt,
      id: `attempt-${index}`,
      dispatchId: `dispatch-${index}`,
      failure: { code: 'provider-authentication' as const, at: 1 }
    }))
    const initial = orchestrationShadowMeasurementSnapshot()
    observeOrchestrationOutcomeChange(before, after)
    const projected = orchestrationShadowMeasurementSnapshot()
    expect(projected.counters.projectedObservations - initial.counters.projectedObservations).toBe(
      64
    )
    expect(projected.counters.perChangeLimitDropped - initial.counters.perChangeLimitDropped).toBe(
      32
    )
    expect(
      projected.counters.observerDeliveriesQueued - initial.counters.observerDeliveriesQueued
    ).toBe(32)
    expect(projected.counters.queueFullCalls).toBe(initial.counters.queueFullCalls)
    await Promise.resolve()
    expect(observer).toHaveBeenCalled()
  })

  it('counts oversized field rejection without inspecting private input', async () => {
    const observer = vi.fn()
    installOrchestrationShadowObserver(observer)
    const before = orchestrationShadowMeasurementSnapshot()
    let privateReads = 0
    observeOrchestrationToolAction(
      tool({
        payload: {
          state: 'working',
          prompt: PRIVATE,
          toolName: 'x'.repeat(ORCHESTRATION_SHADOW_LIMITS.referenceChars + 1),
          get toolInput(): string {
            privateReads++
            throw new Error('Rejected tool input was read')
          }
        }
      })
    )
    await Promise.resolve()
    const after = orchestrationShadowMeasurementSnapshot()
    expect(after.counters.oversizedIdentitySkipped - before.counters.oversizedIdentitySkipped).toBe(
      1
    )
    expect(after.counters.filteredToolEvents - before.counters.filteredToolEvents).toBe(1)
    expect(privateReads).toBe(0)
    expect(observer).not.toHaveBeenCalled()
  })

  it('counts malformed projections without propagating their errors', async () => {
    const observer = vi.fn()
    installOrchestrationShadowObserver(observer)
    const before = orchestrationShadowMeasurementSnapshot()
    let sourceReads = 0
    const malformed = tool({
      payload: {
        state: 'working',
        prompt: PRIVATE,
        get toolName(): string {
          sourceReads++
          throw new Error('Malformed event')
        }
      }
    })
    expect(() => observeOrchestrationToolAction(malformed)).not.toThrow()
    await Promise.resolve()
    expect(sourceReads).toBe(1)
    expect(observer).not.toHaveBeenCalled()
    const after = orchestrationShadowMeasurementSnapshot()
    expect(after.counters.projectionFailures - before.counters.projectionFailures).toBe(1)
    expect(after.counters.observerDeliveriesQueued).toBe(before.counters.observerDeliveriesQueued)
  })
})
