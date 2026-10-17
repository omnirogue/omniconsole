import { renderDirectPrompt, renderSessionPrompt } from '../../shared/session-prep-prompt'
import type { PrepJevAsk, PrepRunText, SessionPrepSteps } from '../../shared/session-prep-types'
import type { TuiAgent } from '../../shared/tui-agent'
import { gate } from './session-prep-gate'
import { plan } from './session-prep-planner'
import { prepare, revise } from './session-prep-preparer'

const WORK_PLAN = {
  agent: 'codex',
  model: 'gpt-6-astra',
  effort: 'high',
  timeoutMs: 180_000
} as const
const PLAN = { model: 'sonnet', effort: 'low', timeoutMs: 120_000 } as const
const PREPARE = { effort: 'medium', timeoutMs: 360_000 } as const
const REVISE = { effort: 'low', timeoutMs: 180_000 } as const
const JUDGE = { model: 'sonnet', effort: 'low', timeoutMs: 90_000 } as const

export function createSessionPrepSteps(deps: {
  runText: PrepRunText
  jevAsk?: PrepJevAsk
  pathExists: (cwd: string, rel: string, connectionId?: string) => Promise<boolean>
  modelAgent?: TuiAgent
}): SessionPrepSteps {
  const agent = deps.modelAgent ?? 'claude'
  const writerAgent = deps.modelAgent ?? 'codex'
  const writer = {
    agent: writerAgent,
    model: writerAgent === 'codex' ? 'gpt-6-luna' : 'sonnet'
  }
  const onHost =
    (connectionId?: string): PrepRunText =>
    (request) =>
      deps.runText({ ...request, ...(connectionId ? { connectionId } : {}) })
  return {
    plan: (input) =>
      plan(input, {
        runText: onHost(input.connectionId),
        ...(input.source.entryPoint === 'work' ? WORK_PLAN : { agent, ...PLAN })
      }),
    prepare: (input) =>
      prepare(input, { runText: onHost(input.connectionId), ...writer, ...PREPARE }),
    revise: (input) => revise(input, { runText: onHost(input.connectionId), ...writer, ...REVISE }),
    gate: (input) =>
      gate(input, {
        runText: onHost(input.connectionId),
        jevAsk: deps.jevAsk,
        pathExists: (cwd, rel) => deps.pathExists(cwd, rel, input.connectionId),
        agent,
        ...JUDGE
      }),
    render: renderSessionPrompt,
    renderDirect: renderDirectPrompt
  }
}
