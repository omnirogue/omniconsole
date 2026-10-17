import { expect } from 'vitest'
import { validateJsonSchema } from '../../../../shared/json-schema-validate'
import type { ResolvedLocalWorkflowSeat } from '../../../../shared/local-workflow-seats'
import { createWorkflowProgramContext, type WorkflowProgramCall } from '../workflow-program-context'
import type { DiscoverV7Config } from './discover-v7'
import type { DiscoverV7Batch, DiscoverV7RawFinding, DiscoverV7Vote } from './discover-v7-plan'

export function seat(
  id: string,
  agent: ResolvedLocalWorkflowSeat['agent'],
  lineage: ResolvedLocalWorkflowSeat['lineage']
): ResolvedLocalWorkflowSeat {
  return {
    id,
    agent,
    accountId: `${id}-account`,
    model: `${id}-model`,
    effort: null,
    lineage,
    policyRevision: 'fixture-v1'
  }
}
export const seats = [
  seat('claude', 'claude', 'anthropic'),
  seat('codex', 'codex', 'openai'),
  seat('grok', 'grok', 'xai'),
  seat('gemini', 'gemini', 'google')
]
export function config(overrides: Partial<DiscoverV7Config> = {}): DiscoverV7Config {
  return {
    seats,
    finderIds: ['codex', 'grok', 'gemini'],
    rankerId: 'claude',
    lensIds: ['correctness', 'security'],
    depth: 'quick',
    focus: ['src'],
    maxAgents: 160,
    access: 'workspace-read',
    ...overrides
  }
}
export const task = { prompt: 'Find real bugs in the checkout flow', evidence: '' }
export const areas = {
  areas: [
    { name: 'Checkout', files: ['src/a.ts'], why: 'Charges the card' },
    { name: 'Payments', files: ['src/b.ts'], why: 'Talks to the processor' }
  ]
}
export function finding(file: string, line: number, title: string): DiscoverV7RawFinding {
  return {
    title,
    file,
    line,
    endLine: null,
    severity: 'high',
    trigger: 'Two tabs submit at once',
    scenario: 'The card is charged twice',
    evidence: `${file}:${line} has no idempotency key`,
    fix: 'Add an idempotency key'
  }
}
export const vote = (verdict: DiscoverV7Vote['verdict']): DiscoverV7Vote => ({
  verdict,
  reason: `${verdict} after tracing the caller`,
  evidence: 'src/a.ts:12',
  filesRead: ['src/a.ts']
})
export const verifyTarget = (call: WorkflowProgramCall) => {
  const [, id, lens] = call.id.split('/')
  return { id, lens }
}
/** The finding ids a repeat check was asked to group, in the order its prompt lists them. */
const repeatIds = (call: WorkflowProgramCall) =>
  [...call.prompt.matchAll(/"id": "([^"]+)"/g)].map((match) => match[1])
/** The files a finder was pointed at: an answer that opened them. */
const areaFiles = (call: WorkflowProgramCall) =>
  /^FILES: (.*)$/m.exec(call.prompt)?.[1].split(', ') ?? []

export type Responder = {
  scout?: () => unknown
  find?: (call: WorkflowProgramCall) => Partial<DiscoverV7Batch> | Error | undefined
  /** The repeat check; by default every finding is a defect of its own. */
  repeats?: (ids: string[], call: WorkflowProgramCall) => unknown
  verify?: (id: string, lens: string) => DiscoverV7Vote | Error
  rank?: (confirmed: string[]) => unknown
  delay?: (call: WorkflowProgramCall) => number
  isFatal?: (error: unknown) => boolean
}

export function host(responder: Responder = {}) {
  const calls: WorkflowProgramCall[] = []
  /** `start <id>` when a call is made, `end <id>` when it answers. */
  const events: string[] = []
  const logs: string[] = []
  const phases: string[] = []
  const results = new Map<string, unknown>()
  const context = createWorkflowProgramContext({
    guard: () => {},
    isFatal: responder.isFatal ?? (() => false),
    phase: (title) => {
      phases.push(title)
    },
    log: (message) => {
      logs.push(message)
    },
    agent: async (call) => {
      calls.push(call)
      events.push(`start ${call.id}`)
      const wait = responder.delay?.(call) ?? 0
      if (wait) {
        await new Promise((resolve) => setTimeout(resolve, wait))
      }
      let value: unknown
      if (call.id === 'scout/map') {
        value = responder.scout ? responder.scout() : areas
      } else if (call.id.endsWith('/repeats')) {
        const ids = repeatIds(call)
        value = responder.repeats
          ? responder.repeats(ids, call)
          : {
              groups: ids.map((id) => ({
                findingIds: [id],
                rootCause: `The defect ${id} describes`
              }))
            }
      } else if (call.id.startsWith('find/')) {
        const batch = responder.find?.(call)
        if (batch instanceof Error) {
          throw batch
        }
        value = { findings: [], omitted: 0, filesRead: areaFiles(call), ...batch }
      } else if (call.id.startsWith('verify/')) {
        const target = verifyTarget(call)
        value = responder.verify ? responder.verify(target.id, target.lens) : vote('real')
      } else {
        const confirmed = [...new Set(call.dependencies.map((id) => id.split('/')[1]))]
        value = responder.rank
          ? responder.rank(confirmed)
          : {
              summary: 'Fix the double charge first.',
              items: confirmed.map((id, index) => ({
                rank: index + 1,
                title: `Item ${id}`,
                location: 'src/a.ts:12',
                severity: 'high',
                scenario: 'Charged twice',
                fix: 'Idempotency key',
                findingIds: [id],
                parallelSafe: true
              })),
              refutedIds: [],
              unverifiedIds: []
            }
      }
      if (value instanceof Error) {
        throw value
      }
      expect(validateJsonSchema(call.schema, value)).toEqual([])
      const problem = call.validateSemantics(value)
      if (problem) {
        throw new Error(problem)
      }
      results.set(call.id, value)
      events.push(`end ${call.id}`)
      return value
    }
  })
  return { calls, events, logs, phases, results, context }
}

export const byId = (calls: WorkflowProgramCall[], id: string) =>
  calls.find((call) => call.id === id)!
// A failed call is invoked again until its persisted attempts run out; keep the first of each.
export const firstCalls = (calls: WorkflowProgramCall[]) =>
  calls.filter((call, index) => calls.findIndex((entry) => entry.id === call.id) === index)
export const invocations = (calls: WorkflowProgramCall[], id: string) =>
  calls.filter((call) => call.id === id).length
