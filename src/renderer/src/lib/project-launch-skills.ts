import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { getSettingsForWorktreeRuntimeOwner } from './worktree-runtime-owner'
import { getLocalProjectExecutionRuntimeContext } from './local-preflight-context'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import type { SkillDiscoveryResult } from '../../../shared/skills'

/** The `skills.discover` call for a launch target: its runtime owner and the target to scan. */
export function skillDiscoveryRequestFor(worktreeId: string | null, hostId: ExecutionHostId) {
  const state = useAppStore.getState()
  const settings = worktreeId
    ? getSettingsForWorktreeRuntimeOwner(state, worktreeId)
    : { activeRuntimeEnvironmentId: null }
  const runtime = getActiveRuntimeTarget(settings)
  const cwd = worktreeId
    ? (state.getKnownWorktreeById(worktreeId)?.path ??
      state.folderWorkspaces.find((folder) => `folder:${folder.id}` === worktreeId)?.folderPath)
    : undefined
  const target = worktreeId
    ? {
        worktreeId,
        cwd,
        ...(runtime.kind === 'local' && hostId === LOCAL_EXECUTION_HOST_ID
          ? { projectRuntime: getLocalProjectExecutionRuntimeContext(state, worktreeId) }
          : {})
      }
    : { runtime: 'host' }
  return { runtime, target }
}

/** Skills by name on each launch target this window has read, as `skills.discover` found them. */
const discovered = new Map<string, Map<string, string>>()
const cacheKey = (worktreeId: string | null, hostId: ExecutionHostId) =>
  `${hostId}\0${worktreeId ?? ''}`

/**
 * A launch target's skills, or `unknown` when they cannot be read from here: `skills.discover`
 * scans this computer (or WSL) only, never an SSH host (checked 2026-09-30), and a target not
 * read yet is not guessed.
 */
export function launchSkillsFor(
  worktreeId: string | null,
  hostId: ExecutionHostId
): ReadonlyMap<string, string> | 'unknown' {
  if (hostId !== LOCAL_EXECUTION_HOST_ID) {
    return 'unknown'
  }
  return discovered.get(cacheKey(worktreeId, hostId)) ?? 'unknown'
}

/** Reads the target's skills once while `enabled`; the returned counter changes when they land. */
export function useLaunchSkills(
  worktreeId: string | null,
  hostId: ExecutionHostId,
  enabled: boolean
): number {
  const [loaded, setLoaded] = useState(0)
  useEffect(() => {
    if (!enabled || hostId !== LOCAL_EXECUTION_HOST_ID) {
      return
    }
    let cancelled = false
    const { runtime, target } = skillDiscoveryRequestFor(worktreeId, hostId)
    void callRuntimeRpc<SkillDiscoveryResult>(runtime, 'skills.discover', target, {
      timeoutMs: 15_000
    })
      .then((result) => {
        discovered.set(
          cacheKey(worktreeId, hostId),
          new Map(result.skills.map((skill) => [skill.name, skill.skillFilePath]))
        )
        if (!cancelled) {
          setLoaded((count) => count + 1)
        }
      })
      // Why silent: an unread target leaves its skills `unknown`, which the launcher says.
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [worktreeId, hostId, enabled])
  return loaded
}
