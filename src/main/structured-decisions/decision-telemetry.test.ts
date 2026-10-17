import { describe, expect, it, vi } from 'vitest'
import type { DecisionRequest, DecisionResult } from '../../shared/structured-decisions'
import { decisionChoices, DecisionTelemetry } from './decision-telemetry'
import type { DecisionComparison, DecisionTelemetryEvent } from './decision-telemetry'

function event(timestamp = 1): DecisionTelemetryEvent {
  return {
    timestamp,
    capability: 'orchestration.route',
    routineId: 'routine:one',
    mode: 'shadow',
    status: 'success',
    provider: 'typesafe',
    model: 'jev-1.13.0',
    requestId: 'request-1',
    elapsedMs: 25,
    attempts: 1,
    usage: { inputTokens: 40, outputTokens: 5 },
    choices: { route: { value: 'inspect', confidence: 0.8, matches: false } }
  }
}

describe('DecisionTelemetry', () => {
  it.each([
    { capacity: undefined, retained: 128 },
    { capacity: 0, retained: 1 },
    { capacity: -10, retained: 1 },
    { capacity: Number.NaN, retained: 128 },
    { capacity: 2.9, retained: 2 },
    { capacity: 600, retained: 512 },
    { capacity: Number.POSITIVE_INFINITY, retained: 128 },
    { capacity: Number.NEGATIVE_INFINITY, retained: 128 }
  ])('retains only the newest events within its bounded capacity: %j', ({ capacity, retained }) => {
    const telemetry = new DecisionTelemetry({ capacity })
    for (let timestamp = 0; timestamp < 520; timestamp += 1) {
      telemetry.record(event(timestamp))
    }
    expect(telemetry.snapshot().map((entry) => entry.timestamp)).toEqual(
      Array.from({ length: retained }, (_, index) => 520 - retained + index)
    )
  })

  it('allowlists persisted metadata and never stores raw state, instructions, or provider errors', () => {
    const append = vi
      .fn<(entry: Readonly<DecisionTelemetryEvent>) => Promise<void>>()
      .mockResolvedValue(undefined)
    const telemetry = new DecisionTelemetry({ append })
    const unsafe = {
      ...event(),
      state: { text: 'private-user-state' },
      instructions: 'private-instructions',
      error: { message: 'private-provider-error', body: 'private-provider-body' },
      authorization: 'Bearer private-api-key',
      usage: { inputTokens: 40, outputTokens: 5, body: 'private-usage-body' },
      choices: {
        route: { value: 'inspect', confidence: 0.8, matches: false, state: 'private-choice-state' }
      }
    }
    telemetry.record(unsafe)

    expect(telemetry.snapshot()).toEqual([event()])
    expect(append).toHaveBeenCalledExactlyOnceWith(event())
    expect(JSON.stringify([telemetry.snapshot(), append.mock.calls])).not.toContain('private-')
  })

  it('redacts unsafe identifier fields and choice strings while preserving numeric observations', () => {
    const telemetry = new DecisionTelemetry()
    telemetry.record({
      ...event(),
      capability: '/private/project',
      routineId: 'routine with spaces',
      provider: 'provider\nerror',
      model: 'x'.repeat(97),
      requestId: 'Bearer secret',
      reason: 'network',
      choices: {
        'private question': { value: 'private result', confidence: 0, matches: false },
        score: { value: 0.25, confidence: 0.4 },
        safe: { value: 'repo:inspect.v1' }
      }
    })

    expect(telemetry.snapshot()[0]).toMatchObject({
      capability: 'redacted',
      routineId: 'redacted',
      provider: 'redacted',
      model: 'redacted',
      requestId: 'redacted',
      reason: 'network',
      choices: {
        redacted: { value: 'redacted', confidence: 0, matches: false },
        score: { value: 0.25, confidence: 0.4 },
        safe: { value: 'repo:inspect.v1' }
      }
    })
  })

  it('bounds the number of recorded choices independently of ring capacity', () => {
    const telemetry = new DecisionTelemetry()
    telemetry.record({
      ...event(),
      choices: Object.fromEntries(
        Array.from({ length: 100 }, (_, index) => [`q${index}`, { value: index }])
      )
    })
    const choices = telemetry.snapshot()[0].choices!
    expect(Object.keys(choices)).toHaveLength(64)
    expect(choices.q63).toEqual({ value: 63 })
    expect(choices).not.toHaveProperty('q64')
  })

  it('copies caller data and isolates returned snapshots from the retained ring', () => {
    const telemetry = new DecisionTelemetry()
    const input = event()
    telemetry.record(input)
    input.usage!.inputTokens = 999
    input.choices!.route.value = 'mutated'
    const snapshot = telemetry.snapshot()
    snapshot[0].usage!.outputTokens = 999
    snapshot[0].choices!.route.confidence = 0
    snapshot.push(event(2))

    expect(telemetry.snapshot()).toEqual([event()])
  })

  it('isolates the retained event from mutations by the append sink', () => {
    const append = vi.fn(async (entry: Readonly<DecisionTelemetryEvent>) => {
      entry.usage!.inputTokens = 999
      entry.choices!.route.value = 'mutated-by-sink'
    })
    const telemetry = new DecisionTelemetry({ append })
    telemetry.record(event())

    expect(append).toHaveBeenCalledTimes(1)
    expect(telemetry.snapshot()).toEqual([event()])
  })

  it('serializes append work and bounds the waiting queue when its sink is blocked', async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const append = vi
      .fn<(entry: Readonly<DecisionTelemetryEvent>) => Promise<void>>()
      .mockReturnValueOnce(blocked)
      .mockResolvedValue(undefined)
    const telemetry = new DecisionTelemetry({ capacity: 2, append })
    for (let timestamp = 1; timestamp <= 5; timestamp += 1) {
      telemetry.record(event(timestamp))
    }

    expect(append).toHaveBeenCalledTimes(1)
    expect(telemetry.snapshot().map((entry) => entry.timestamp)).toEqual([4, 5])
    release()
    await vi.waitFor(() => expect(append).toHaveBeenCalledTimes(3))
    expect(append.mock.calls.map(([entry]) => entry.timestamp)).toEqual([1, 2, 3])

    telemetry.record(event(6))
    await vi.waitFor(() => expect(append).toHaveBeenCalledTimes(4))
    expect(append.mock.calls.map(([entry]) => entry.timestamp)).toEqual([1, 2, 3, 6])
  })

  it('contains synchronous and asynchronous append failures and keeps draining later events', async () => {
    const append = vi
      .fn<(entry: Readonly<DecisionTelemetryEvent>) => Promise<void>>()
      .mockImplementationOnce(() => {
        throw new Error('private-sync-sink-error')
      })
      .mockRejectedValueOnce(new Error('private-async-sink-error'))
      .mockResolvedValue(undefined)
    const telemetry = new DecisionTelemetry({ append })
    expect(() => {
      telemetry.record(event(1))
      telemetry.record(event(2))
      telemetry.record(event(3))
    }).not.toThrow()

    await vi.waitFor(() => expect(append).toHaveBeenCalledTimes(3))
    telemetry.record(event(4))
    await vi.waitFor(() => expect(append).toHaveBeenCalledTimes(4))
    expect(telemetry.snapshot()).toEqual([event(1), event(2), event(3), event(4)])
    expect(JSON.stringify(telemetry.snapshot())).not.toContain('sink-error')
  })
})

const request: DecisionRequest = {
  capability: 'orchestration.route',
  state: 'private request state',
  questions: {
    route: {
      type: 'choice',
      instructions: 'Select a route',
      criteria: { inspect: 'Read', modify: 'Write' }
    },
    risk: { type: 'score', instructions: 'Estimate risk', criteria: ['Low', 'High'] },
    allowed: { type: 'noul', instructions: 'Is this allowed?' }
  }
}
const result: DecisionResult = {
  provider: 'typesafe',
  model: 'jev-1.13.0',
  usage: { inputTokens: 10, outputTokens: 5 },
  answers: {
    route: {
      type: 'choice',
      choice: 'inspect',
      probabilities: { inspect: 0.8, modify: 0.2 },
      confidence: 0.6
    },
    risk: {
      type: 'score',
      score: 0.75,
      legend: { '0': 'Low', '1': 'High' },
      probabilities: { '0': 0.25, '1': 0.75 },
      confidence: 0.4
    },
    allowed: { type: 'noul', noul: 0.25 }
  }
}

describe('decisionChoices', () => {
  it('records primitive values and supplied confidence without inventing Noul confidence', () => {
    expect(decisionChoices(result, request)).toEqual({
      route: { value: 'inspect', confidence: 0.6 },
      risk: { value: 0.75, confidence: 0.4 },
      allowed: { value: 0.25 }
    })
  })

  it('compares labels and numeric values exactly without thresholding probabilities', () => {
    expect(
      decisionChoices(result, request, { route: 'inspect', risk: 0.75, allowed: 0.25 })
    ).toEqual({
      route: { value: 'inspect', confidence: 0.6, matches: true },
      risk: { value: 0.75, confidence: 0.4, matches: true },
      allowed: { value: 0.25, matches: true }
    })
    expect(
      decisionChoices(result, request, { route: 'modify', risk: 1, allowed: 0 })
    ).toMatchObject({
      route: { matches: false },
      risk: { matches: false },
      allowed: { matches: false }
    })
  })

  it('omits unsupported boolean comparisons and string comparisons for numeric primitives', () => {
    const choices = decisionChoices(result, request, { route: true, risk: '0.75', allowed: false })
    expect(choices).toEqual(decisionChoices(result, request))
    expect(decisionChoices(result, request, { allowed: '0.25' })).toEqual(
      decisionChoices(result, request)
    )
  })

  it('does not treat inherited properties as supplied comparisons', () => {
    const comparison: DecisionComparison = Object.create({
      route: 'inspect',
      risk: 0.75,
      allowed: 0.25
    })
    expect(decisionChoices(result, request, comparison)).toEqual(decisionChoices(result, request))
  })
})
