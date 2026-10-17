import { describe, expect, it } from 'vitest'
import type { ResolvedLocalWorkflowSeat } from '../../../../shared/local-workflow-seats'
import type { LocalWorkflowSeatCapacity } from '../../../../shared/local-workflow-seat-capacity'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import { createWorkflowProgramContext, type WorkflowProgramCall } from '../workflow-program-context'
import { WorkflowCallLaunchError } from '../workflow-launch-failure'
import { runWorkflowGraphProgram } from './graph-program'
import { configFor, task, text } from './graph-program-test-harness'
import type { GraphConfig } from './graph-plan-types'
import { createGraphSeatSubstitute, SEAT_RULES } from './graph-seat-substitution'

const spec = normalizeWorkflowSpec({
  title: 'Seats',
  steps: [
    {
      id: 'find',
      kind: 'do',
      title: 'Find',
      agents: [{ route: 'codex' }, { route: 'claude' }]
    },
    {
      id: 'final',
      kind: 'synthesize',
      title: 'Final',
      agents: [{ route: 'claude' }],
      inputs: ['find']
    }
  ]
})

const USAGE_LIMIT =
  "Workflow call exhausted its attempts: workflow process did not complete successfully (exit 1): You've hit your usage limit."

type Capacities = Record<string, LocalWorkflowSeatCapacity>

/** The run's config under seat rules, with one spare Codex account frozen at admission. */
function seatConfig(capacities: Capacities, recorded: string[] = []): GraphConfig {
  const base = configFor(spec)
  const codex = base.seats.find((seat) => seat.id === 'seat-codex')!
  const spare: ResolvedLocalWorkflowSeat = {
    ...codex,
    id: 'seat-codex@managed:m1',
    accountId: 'managed:m1'
  }
  const config = { ...base, seatRules: SEAT_RULES, spareSeats: [spare], seatNotes: [] }
  return {
    ...config,
    substitute: createGraphSeatSubstitute({
      config,
      recorded: () => recorded,
      capacity: async () => (seat) => capacities[seat.id] ?? { state: 'unknown' }
    })
  }
}

/** A durable port whose `fail` decides, per call, what error the call ends with. */
function context(fail: (call: WorkflowProgramCall) => Error | undefined) {
  const calls: WorkflowProgramCall[] = []
  const port = createWorkflowProgramContext({
    agent: async (call) => {
      calls.push(call)
      await Promise.resolve()
      const error = fail(call)
      if (error) {
        throw error
      }
      return text(`${call.seatId} answered`)
    },
    phase: () => {},
    log: () => {},
    guard: () => {},
    isFatal: () => false
  })
  return { port, calls }
}

const exhaustedCodex = (call: WorkflowProgramCall) =>
  call.seatId === 'seat-codex' ? new WorkflowCallLaunchError(USAGE_LIMIT) : undefined

describe('moving a call that failed at launch', () => {
  it('uses another family on dispatched runs even with a fresh local spare', async () => {
    const config = seatConfig({})
    const substitute = createGraphSeatSubstitute({
      config,
      dispatched: true,
      capacity: async () => () => ({ state: 'fresh', remainingPercent: 99 })
    })
    expect(
      await substitute(
        { id: 'find/a0', stepId: 'find', seatId: 'seat-codex' } as Parameters<typeof substitute>[0],
        USAGE_LIMIT
      )
    ).toMatchObject({ seatId: 'seat-claude' })
  })

  it('runs it once more on a fresh account of the same family, and names the move', async () => {
    const { port, calls } = context(exhaustedCodex)
    const result = await runWorkflowGraphProgram(
      port,
      seatConfig({ 'seat-codex@managed:m1': { state: 'fresh', remainingPercent: 94 } }),
      task
    )
    expect(calls.map((call) => [call.id, call.seatId])).toContainEqual([
      'find/a0~seat-codex@managed:m1',
      'seat-codex@managed:m1'
    ])
    const final = calls.find((call) => call.id.startsWith('final'))!
    expect(final.prompt).toContain('seat-codex@managed:m1 answered')
    expect(result.gaps).toContain(
      "Find: 1 call could not start on Codex (workflow process did not complete successfully (exit 1): You've hit your usage limit.) and ran on another Codex account instead."
    )
    expect(result.degraded).toBeUndefined()
  })

  it('moves it to another family the step uses when no account of its own has capacity', async () => {
    const { port, calls } = context(exhaustedCodex)
    const result = await runWorkflowGraphProgram(
      port,
      seatConfig({ 'seat-codex@managed:m1': { state: 'limited' } }),
      task
    )
    expect(calls.filter((call) => call.id.startsWith('find/a0')).map((call) => call.id)).toEqual([
      'find/a0',
      'find/a0~seat-claude'
    ])
    expect(result.gaps.some((gap) => gap.includes('and ran on Claude instead'))).toBe(true)
    expect(result.degraded).toBeUndefined()
  })

  it('never moves a call that ran and failed on its answer', async () => {
    const { port, calls } = context((call) =>
      call.seatId === 'seat-codex'
        ? new Error('Workflow call exhausted its attempts: the answer is not valid JSON')
        : undefined
    )
    const result = await runWorkflowGraphProgram(
      port,
      seatConfig({ 'seat-codex@managed:m1': { state: 'fresh', remainingPercent: 94 } }),
      task
    )
    expect(calls.some((call) => call.id.includes('~'))).toBe(false)
    expect(result.gaps.some((gap) => gap.includes('lost'))).toBe(false)
    expect(result.degraded).toBeUndefined()
  })

  it('moves a call once only: a substitute that fails too leaves it lost, and the run degraded', async () => {
    const { port, calls } = context((call) =>
      call.id.startsWith('find/a0') ? new WorkflowCallLaunchError(USAGE_LIMIT) : undefined
    )
    const result = await runWorkflowGraphProgram(
      port,
      seatConfig({ 'seat-codex@managed:m1': { state: 'fresh', remainingPercent: 94 } }),
      task
    )
    expect(calls.filter((call) => call.id.startsWith('find/a0')).map((call) => call.id)).toEqual([
      'find/a0',
      'find/a0~seat-codex@managed:m1'
    ])
    expect(result.degraded).toEqual({ lostCalls: 1, steps: ['Find'] })
    expect(result.gaps).toContain(
      "Find: 1 call lost. It could not start (workflow process did not complete successfully (exit 1): You've hit your usage limit.), and no other account or model family could take it."
    )
  })

  it('marks the run degraded when no seat can take the call', async () => {
    const { port, calls } = context(exhaustedCodex)
    const capacities: Capacities = {
      'seat-codex@managed:m1': { state: 'stale' },
      'seat-claude': { state: 'limited' },
      'seat-grok': { state: 'signed-out' },
      'seat-gemini': { state: 'signed-out' }
    }
    const result = await runWorkflowGraphProgram(port, seatConfig(capacities), task)
    expect(calls.some((call) => call.id.includes('~'))).toBe(false)
    expect(result.degraded).toEqual({ lostCalls: 1, steps: ['Find'] })
    // The final step still ran on what Find had: completed, but not plainly.
    expect(result.final.markdown).toBe('seat-claude answered')
  })

  it('replays a recorded substitute the same way, without asking for capacity', async () => {
    const { port, calls } = context((call) =>
      call.seatId === 'seat-codex' ? new Error('Workflow admission is stopped') : undefined
    )
    const config = seatConfig({}, ['find/a0', 'find/a0~seat-codex@managed:m1'])
    const result = await runWorkflowGraphProgram(port, config, task)
    expect(calls.map((call) => call.id)).toContain('find/a0~seat-codex@managed:m1')
    expect(result.degraded).toBeUndefined()
  })

  it('leaves runs admitted before seat rules as they ran', async () => {
    const { port, calls } = context(exhaustedCodex)
    const result = await runWorkflowGraphProgram(port, configFor(spec), task)
    expect(calls.some((call) => call.id.includes('~'))).toBe(false)
    expect(result.degraded).toBeUndefined()
    expect(result.gaps.some((gap) => gap.includes('lost'))).toBe(false)
  })
})
