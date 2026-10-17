import type { ResolvedLocalWorkflowSeat } from '../../../../shared/local-workflow-seats'
import type { WorkflowSpec } from '../../../../shared/workflow-graph'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import { createWorkflowProgramContext, type WorkflowProgramCall } from '../workflow-program-context'
import type { GraphConfig, GraphOutcome } from './graph-plan'
const SEATS: ResolvedLocalWorkflowSeat[] = [
  {
    id: 'seat-claude',
    agent: 'claude',
    accountId: 'a',
    model: 'claude-opus-5',
    effort: null,
    lineage: 'anthropic',
    policyRevision: 'p'
  },
  {
    id: 'seat-codex',
    agent: 'codex',
    accountId: 'a',
    model: 'gpt-5.6-sol',
    effort: null,
    lineage: 'openai',
    policyRevision: 'p'
  },
  {
    id: 'seat-grok',
    agent: 'grok',
    accountId: 'a',
    model: 'grok-4.6',
    effort: null,
    lineage: 'xai',
    policyRevision: 'p'
  },
  {
    id: 'seat-gemini',
    agent: 'gemini',
    accountId: 'a',
    model: 'gemini-3.8-flash',
    effort: null,
    lineage: 'google',
    policyRevision: 'p'
  }
]

export function configFor(spec: WorkflowSpec): GraphConfig {
  return {
    spec,
    seats: SEATS,
    access: 'frozen',
    agentSeats: Object.fromEntries(
      spec.steps.map((step) => [step.id, step.agents.map((agent) => `seat-${agent.route}`)])
    )
  }
}

export class Fatal extends Error {}

type Responder = (call: WorkflowProgramCall) => unknown
/** A fake durable port: answers from `respond`, validates like the real one, records every call. */
export function fakeContext(respond: Responder) {
  const calls: WorkflowProgramCall[] = []
  const phases: string[] = []
  const logs: string[] = []
  const outcomes = new Map<string, GraphOutcome>()
  const context = createWorkflowProgramContext({
    agent: async (call) => {
      calls.push(call)
      await Promise.resolve()
      const value = respond(call)
      const problem = value instanceof Error ? value.message : call.validateSemantics(value)
      if (value instanceof Fatal) {
        throw value
      }
      if (problem) {
        outcomes.set(call.id, { failed: true })
        throw new Error(problem)
      }
      outcomes.set(call.id, { value })
      return value
    },
    phase: (title) => phases.push(title),
    log: (message) => logs.push(message),
    guard: () => {},
    isFatal: (error) => error instanceof Fatal
  })
  return { context, calls, phases, logs, outcomes }
}

export const text = (markdown: string) => ({ markdown })
export const task = { prompt: 'How should we cache the build?', evidence: '' }

export const research = normalizeWorkflowSpec({
  title: 'Research',
  steps: [
    { id: 'research', kind: 'do', title: 'Research', agents: [{}, {}, {}, {}] },
    { id: 'critics', kind: 'review', title: 'Critics', agents: [{}, {}], inputs: ['research'] },
    { id: 'final', kind: 'synthesize', title: 'Final', inputs: ['research', 'critics'] }
  ]
})
