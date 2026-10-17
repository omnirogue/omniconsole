import type { UsageScanWorktreeRef } from '../usage/usage-provider-contract'
import type { scanCodexUsageFiles } from './scanner'
import type { CodexUsagePersistedFile } from './types'

export type CodexUsageWorkerRequest = {
  worktrees: UsageScanWorktreeRef[]
  previous: CodexUsagePersistedFile[]
  worktreeSetChanged?: boolean
  checkpointState?: Record<string, unknown>
}

export type CodexUsageWorkerMessage =
  | { type: 'result'; result: Awaited<ReturnType<typeof scanCodexUsageFiles>> }
  | { type: 'checkpoint'; snapshot: string }
  | { type: 'sources'; sources: CodexUsagePersistedFile[] }
  | { type: 'error'; message: string; stopped: boolean }
