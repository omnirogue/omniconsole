import type { AppState } from '@/store/types'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import type {
  RuntimeTerminalListResult,
  RuntimeTerminalSummary
} from '../../../shared/runtime-types'
import { getRuntimeEnvironmentIdForWorktree } from './worktree-runtime-owner'

/** Live PTYs of runtime-environment worktrees, read fresh for agent sleep (moved from the coordinator). */
export type RuntimePtyLivenessSample = {
  runtimeLivePtyIdsByWorktreeId: Record<string, string[]>
  runtimeLivenessRequiredWorktreeIds: string[]
}

/** The runtime's terminal handle for each PTY it last listed, so a guard can inspect its process. */
const runtimeTerminalHandleByPtyId = new Map<string, string>()
/** Bounds the memory; a forgotten handle at worst keeps one pane awake until the next listing. */
const MAX_REMEMBERED_HANDLES = 2_000

export function getRuntimeTerminalHandle(ptyId: string): string | null {
  return runtimeTerminalHandleByPtyId.get(ptyId) ?? null
}

function getRuntimeLivenessTargetWorktrees(
  state: AppState,
  targetWorktreeId?: string
): Map<string, string> {
  const targets = new Map<string, string>()
  const worktreeIds = targetWorktreeId
    ? Object.hasOwn(state.tabsByWorktree, targetWorktreeId)
      ? [targetWorktreeId]
      : []
    : Object.keys(state.tabsByWorktree)
  for (const worktreeId of worktreeIds) {
    const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
    if (runtimeEnvironmentId) {
      targets.set(worktreeId, runtimeEnvironmentId)
    }
  }
  return targets
}

function getTypedRuntimePtyId(terminal: RuntimeTerminalSummary): string | null {
  if (terminal.ptyId) {
    return terminal.ptyId
  }
  if (terminal.tabId.startsWith('pty:') && terminal.tabId === terminal.leafId) {
    return terminal.tabId.slice('pty:'.length) || null
  }
  return null
}

/**
 * The sample for a pass that must not touch runtime environments (the idle rules' R1): every
 * runtime worktree is required but unlisted, so the planner fails closed for it.
 */
export function runtimeWorktreesHeldBack(
  state: AppState,
  targetWorktreeId?: string
): RuntimePtyLivenessSample {
  return {
    runtimeLivePtyIdsByWorktreeId: {},
    runtimeLivenessRequiredWorktreeIds: [
      ...getRuntimeLivenessTargetWorktrees(state, targetWorktreeId).keys()
    ]
  }
}

export async function collectRuntimePtyLiveness(
  state: AppState,
  targetWorktreeId?: string
): Promise<RuntimePtyLivenessSample> {
  const targets = getRuntimeLivenessTargetWorktrees(state, targetWorktreeId)
  const runtimeLivePtyIdsByWorktreeId: Record<string, string[]> = {}
  const runtimeLivenessRequiredWorktreeIds = [...targets.keys()]
  await Promise.all(
    [...targets].map(async ([worktreeId, runtimeEnvironmentId]) => {
      try {
        const result = await callRuntimeRpc<RuntimeTerminalListResult>(
          { kind: 'environment', environmentId: runtimeEnvironmentId },
          'terminal.list',
          {
            worktree: toRuntimeWorktreeSelector(worktreeId),
            limit: 10_000,
            requireFreshPtyLiveness: true,
            includeVisualLayouts: false
          },
          { timeoutMs: 10_000 }
        )
        if (result.truncated) {
          return
        }
        const ptyIds = new Set<string>()
        for (const terminal of result.terminals) {
          if (!terminal.connected || terminal.worktreeId !== worktreeId) {
            continue
          }
          const ptyId = getTypedRuntimePtyId(terminal)
          if (ptyId) {
            ptyIds.add(ptyId)
            if (runtimeTerminalHandleByPtyId.size >= MAX_REMEMBERED_HANDLES) {
              runtimeTerminalHandleByPtyId.clear()
            }
            runtimeTerminalHandleByPtyId.set(ptyId, terminal.handle)
          }
        }
        runtimeLivePtyIdsByWorktreeId[worktreeId] = [...ptyIds].sort()
      } catch {
        // Why: stale runtime liveness is unsafe for all-or-nothing hibernation;
        // omitting the worktree makes the planner fail closed for this pass.
      }
    })
  )
  return { runtimeLivePtyIdsByWorktreeId, runtimeLivenessRequiredWorktreeIds }
}
