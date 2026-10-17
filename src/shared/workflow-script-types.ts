import type { JsonSchema } from './json-schema-validate'

/**
 * A workflow script is plain JavaScript that orchestrates agents through five globals —
 * agent, parallel, pipeline, phase, log — with `args` and `budget` in scope. The script
 * decides the shape (fan-out, verification, loops); the runtime decides nothing. This
 * file is the contract both the runtime and the views read. It borrows the authoring
 * contract of the Workflow tool Sal already runs, so scripts move between the two.
 */
export const WORKFLOW_SCRIPT_RPC = {
  readMeta: 'workflowScript.readMeta',
  // Not currently registered on the RPC method list (unregistered 2026-09-17, security).
  dryRun: 'workflowScript.dryRun'
} as const

export type WorkflowScriptPhaseMeta = { title: string; detail?: string; model?: string }

export type WorkflowScriptMeta = {
  name: string
  description: string
  whenToUse?: string
  phases: WorkflowScriptPhaseMeta[]
}

export type WorkflowScriptAgentState = 'queued' | 'running' | 'done' | 'failed'

/** One `agent()` call as the views see it: where it sits, what it asked, where it stands. */
export type WorkflowScriptAgentRecord = {
  /** 1-based call order, the same on every run of an unchanged script. */
  index: number
  /** Content key of the call (prompt and options, plus its occurrence), the resume unit. */
  key: string
  label: string
  phaseTitle: string | null
  phaseIndex: number | null
  model: string | null
  effort: string | null
  isolation: 'worktree' | null
  schema: boolean
  state: WorkflowScriptAgentState
  /** The answer came from the journal; no agent ran. */
  cached: boolean
  attempt: number
  promptPreview: string
  tokens: number
  startedAt: number | null
  endedAt: number | null
  error: string | null
}

export type WorkflowScriptEvent =
  | { type: 'phase'; index: number; title: string }
  | { type: 'agent'; agent: WorkflowScriptAgentRecord }
  | { type: 'log'; message: string }

export type WorkflowScriptRunStatus = 'completed' | 'failed' | 'cancelled'

export type WorkflowScriptRunSnapshot = {
  status: WorkflowScriptRunStatus
  meta: WorkflowScriptMeta | null
  phases: string[]
  agents: WorkflowScriptAgentRecord[]
  logs: string[]
  result: unknown
  error: string | null
  tokens: number
  cachedAgents: number
  durationMs: number
}

/** What a dry run needs to know about the world the script would run in. */
export type WorkflowScriptDryRunInput = {
  source: string
  args?: unknown
  /** How many elements array-valued answers carry; data-driven fan-out responds to it. */
  richness?: number
  budgetTotal?: number | null
}

export type WorkflowScriptAgentCall = {
  index: number
  key: string
  prompt: string
  label: string
  phaseTitle: string | null
  schema: JsonSchema | null
  model: string | null
  effort: string | null
  isolation: 'worktree' | null
  agentType: string | null
}
