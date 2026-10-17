// Ownership inputs for the session frame log (session-count fix, step 0): what the publication and
// ownership predicates read for each workspace on this computer, recorded once per workspace and
// again whenever an input changes. Receiver frames note their workspace; while the log is on, a
// sampler covers every workspace this window knows, so the owner (publishing) side is covered too.

import { useEffect, useSyncExternalStore } from 'react'
import { useAppStore, type AppState } from '../store'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { classifyFrameLogPtyKind, countBy } from '../../../shared/session-frame-log'
import {
  getExecutionHostIdForWorktree,
  getExplicitRuntimeEnvironmentIdForWorktree,
  getRuntimeEnvironmentIdForWorktree
} from '@/lib/worktree-runtime-owner'
import { findIndexedRepoOwner, findIndexedWorktreeOwner } from '@/lib/worktree-runtime-owner-index'
import { getRepoIdFromWorktreeId } from '@/store/slices/worktree-helpers'
import {
  isSessionFrameLogEnabled,
  onSessionFrameLogEnabledChanged,
  recordSessionFrameLog
} from './session-frame-log'

const OWNERSHIP_SAMPLE_INTERVAL_MS = 15_000
const DEDUPE_LIMIT = 4096

/** The inputs the publication and ownership predicates read for one workspace on this computer. */
function collectWorkspaceOwnershipInputs(
  state: AppState,
  worktreeId: string
): Record<string, unknown> {
  const worktree = findIndexedWorktreeOwner(state.worktreesByRepo, worktreeId)
  const repo = findIndexedRepoOwner(
    state.repos,
    worktree?.repoId ?? getRepoIdFromWorktreeId(worktreeId)
  )
  const scope = parseWorkspaceKey(worktreeId)
  const folder =
    scope?.type === 'folder'
      ? state.folderWorkspaces?.find((entry) => entry.id === scope.folderWorkspaceId)
      : undefined
  const terminalTabs = state.tabsByWorktree[worktreeId] ?? []
  return {
    explicitRuntimeOwner: getExplicitRuntimeEnvironmentIdForWorktree(state, worktreeId),
    routeRuntimeOwner: getRuntimeEnvironmentIdForWorktree(state, worktreeId),
    executionHostId: getExecutionHostIdForWorktree(state, worktreeId),
    worktreeHostId: worktree?.hostId ?? null,
    worktreeRuntimeOwnerEnvironmentId: worktree?.runtimeOwnerEnvironmentId ?? null,
    repoExecutionHostId: repo?.executionHostId ?? null,
    repoConnectionId: repo?.connectionId ?? null,
    ...(folder
      ? {
          folderExecutionHostId: folder.executionHostId ?? null,
          folderConnectionId: folder.connectionId ?? null
        }
      : {}),
    unifiedTabExecutionHostIds: countBy(
      (state.unifiedTabsByWorktree[worktreeId] ?? []).map((tab) => tab.executionHostId ?? 'unset')
    ),
    terminalPtyKinds: countBy(
      terminalTabs.map((tab) =>
        classifyFrameLogPtyKind(tab.ptyId, tab, state.terminalLayoutsByTabId[tab.id])
      )
    )
  }
}

const ownershipSignatureByKey = new Map<string, string>()

function recordOwnershipIfChanged(
  state: AppState,
  worktreeId: string,
  environmentId: string | null
): void {
  const status = environmentId ? state.runtimeStatusByEnvironmentId?.get(environmentId) : undefined
  const inputs = {
    ...collectWorkspaceOwnershipInputs(state, worktreeId),
    ...(environmentId
      ? { publisherAppVersion: status?.status?.appVersion ?? status?.appVersion ?? null }
      : {})
  }
  const key = `${environmentId ?? ''}\u0000${worktreeId}`
  const signature = JSON.stringify(inputs)
  if (ownershipSignatureByKey.get(key) === signature) {
    return
  }
  if (ownershipSignatureByKey.size > DEDUPE_LIMIT) {
    ownershipSignatureByKey.clear()
  }
  ownershipSignatureByKey.set(key, signature)
  recordSessionFrameLog({
    kind: 'receiver.ownership',
    worktree: worktreeId,
    ...(environmentId ? { environmentId } : {}),
    ...inputs
  })
}

/** Once per (environment, workspace) and again whenever the inputs change. */
export function noteReceiverOwnershipInputs(worktreeId: string, environmentId: string): void {
  try {
    recordOwnershipIfChanged(useAppStore.getState(), worktreeId, environmentId)
  } catch {
    /* ownership inputs are context; never let them break the frame record */
  }
}

/** Every workspace this window knows (published or mirrored), so the owner side is covered too. */
function sampleWorkspaceOwnershipInputs(state: AppState = useAppStore.getState()): void {
  const worktreeIds = new Set<string>([
    ...Object.keys(state.tabsByWorktree),
    ...Object.keys(state.unifiedTabsByWorktree),
    ...Object.values(state.worktreesByRepo ?? {}).flatMap((worktrees) =>
      worktrees.map((worktree) => worktree.id)
    )
  ])
  for (const worktreeId of worktreeIds) {
    try {
      recordOwnershipIfChanged(state, worktreeId, null)
    } catch {
      /* one malformed workspace must not stop the sample */
    }
  }
}

function subscribeFrameLogFlag(onChange: () => void): () => void {
  return onSessionFrameLogEnabledChanged(onChange)
}

/** Samples ownership inputs only while the frame log is on; off, no timer runs. */
export function useSessionFrameLogOwnershipSampler(): void {
  const enabled = useSyncExternalStore(
    subscribeFrameLogFlag,
    isSessionFrameLogEnabled,
    isSessionFrameLogEnabled
  )
  useEffect(() => {
    if (!enabled) {
      return
    }
    sampleWorkspaceOwnershipInputs()
    const timer = setInterval(() => sampleWorkspaceOwnershipInputs(), OWNERSHIP_SAMPLE_INTERVAL_MS)
    return () => {
      clearInterval(timer)
      // Why: the next "on" starts a fresh capture, so every workspace is recorded again.
      ownershipSignatureByKey.clear()
    }
  }, [enabled])
}

export function resetOwnershipInputsForTests(): void {
  ownershipSignatureByKey.clear()
}
