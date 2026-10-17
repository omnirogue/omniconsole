import type { ConsoleWorkflowResult } from './console-workflow-types'

/** Why a workflow stopped advancing. Codes only: the renderer owns the wording. */
export type ConsoleAutoAdvanceStopReason =
  | 'turned_off'
  | 'human_decision'
  | 'fleet_placement'
  | 'folder_workspace'
  | 'no_workspace'
  | 'workflow_complete'
  | 'timed_out'
  | 'refused'

export type ConsoleAutoAdvanceState = 'off' | 'waiting' | 'activated' | 'stopped'

export type ConsoleAutoAdvanceStatus = {
  state: ConsoleAutoAdvanceState
  reason: ConsoleAutoAdvanceStopReason | null
  /** The job the last activation or stop is about; never a job outside this workflow. */
  jobId: string | null
  /** Already-sanitized server or refusal text, for the person to read. */
  detail: string | null
  updatedAt: number
}

export type ConsoleAutoAdvancePreference = {
  workflowId: string
  enabled: boolean
  /** Runtime worktree selector the person approved for this workflow's local jobs. */
  worktree: string
  status: ConsoleAutoAdvanceStatus
}

export type ConsoleAutoAdvanceSetRequest = {
  workflowId: string
  enabled: boolean
  worktree?: string
}

export type ConsoleAutoAdvanceApi = {
  autoAdvanceGet(request: {
    workflowId: string
  }): Promise<ConsoleWorkflowResult<ConsoleAutoAdvancePreference>>
  autoAdvanceSet(
    request: ConsoleAutoAdvanceSetRequest
  ): Promise<ConsoleWorkflowResult<ConsoleAutoAdvancePreference>>
}

export const CONSOLE_AUTO_ADVANCE_RPC = {
  get: 'consoleWorkflow.autoAdvanceGet',
  set: 'consoleWorkflow.autoAdvanceSet',
  run: 'consoleWorkflow.autoAdvanceRun'
} as const

export const CONSOLE_AUTO_ADVANCE_POLL_MS = 5_000
export const CONSOLE_AUTO_ADVANCE_WINDOW_MS = 600_000
const WORKFLOW_ID = /^wf_[A-Za-z0-9_-]{1,128}$/
const JOB_ID = /^job_[a-z0-9]{8,40}$/
/** `id:` selectors only; `id:folder:…` is a folder workspace and is refused, not activated. */
const WORKTREE_SELECTOR = /^id:[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/
const STATES: ConsoleAutoAdvanceState[] = ['off', 'waiting', 'activated', 'stopped']
const REASONS: ConsoleAutoAdvanceStopReason[] = [
  'turned_off',
  'human_decision',
  'fleet_placement',
  'folder_workspace',
  'no_workspace',
  'workflow_complete',
  'timed_out',
  'refused'
]

export function isConsoleAutoAdvanceWorkflowId(value: unknown): value is string {
  return typeof value === 'string' && WORKFLOW_ID.test(value)
}

export function isConsoleAutoAdvanceWorktree(value: unknown): value is string {
  return typeof value === 'string' && WORKTREE_SELECTOR.test(value)
}

/** A folder workspace has no Git repository, so the admitted local path cannot run there. */
export function isConsoleAutoAdvanceFolderWorkspace(worktree: string): boolean {
  return worktree.startsWith('id:folder:')
}

export function consoleAutoAdvanceOff(
  workflowId: string,
  worktree = '',
  at = Date.now()
): ConsoleAutoAdvancePreference {
  return {
    workflowId,
    enabled: false,
    worktree,
    status: { state: 'off', reason: null, jobId: null, detail: null, updatedAt: at }
  }
}

function normalizeStatus(raw: unknown): ConsoleAutoAdvanceStatus | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const value = raw as Record<string, unknown>
  const state = STATES.find((candidate) => candidate === value.state)
  const reason = REASONS.find((candidate) => candidate === value.reason) ?? null
  if (!state) {
    return null
  }
  return {
    state,
    reason,
    jobId: typeof value.jobId === 'string' && JOB_ID.test(value.jobId) ? value.jobId : null,
    detail: typeof value.detail === 'string' ? value.detail.slice(0, 1500) : null,
    updatedAt:
      typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : 0
  }
}

/** Persisted preferences are untrusted JSON; an unreadable row falls back to off. */
export function normalizeConsoleAutoAdvancePreferences(
  raw: unknown
): Record<string, ConsoleAutoAdvancePreference> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {}
  }
  const normalized: Record<string, ConsoleAutoAdvancePreference> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isConsoleAutoAdvanceWorkflowId(key) || !value || typeof value !== 'object') {
      continue
    }
    const row = value as Record<string, unknown>
    const worktree = isConsoleAutoAdvanceWorktree(row.worktree) ? row.worktree : ''
    const enabled = row.enabled === true && worktree !== ''
    normalized[key] = {
      workflowId: key,
      enabled,
      worktree,
      status: enabled
        ? (normalizeStatus(row.status) ?? consoleAutoAdvanceOff(key, worktree).status)
        : consoleAutoAdvanceOff(key, worktree).status
    }
  }
  return normalized
}
