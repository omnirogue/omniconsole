import { useEffect, useMemo, useState } from 'react'
import type { CatalogModel } from '../../../../shared/agent-session-option-catalog'
import { resolveNativeChatModelDiscoveryHostKey } from '@/components/native-chat/native-chat-session-option-discovery'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { getSettingsForWorktreeRuntimeOwner } from '@/lib/worktree-runtime-owner'
import {
  discoverRuntimeCommitMessageModels,
  getRuntimeGitScope,
  type RuntimeGitContext
} from '@/runtime/runtime-git-client'
import { useAppStore } from '@/store'
import {
  catalogModelsFromDiscovery,
  resolveBuildReviewModels
} from '../../../../shared/build-review-model-options'

type DiscoveryEntry = {
  state: 'pending' | 'settled'
  models: CatalogModel[] | null
  listeners: Set<(models: CatalogModel[] | null) => void>
}

// Why: one probe per agent and host for the app's lifetime. The CLIs answer in
// seconds, the answer only changes when the CLI or account does, and the dialog
// must never wait on it — the static seed renders until the probe lands.
const discoveryByAgentHost = new Map<string, DiscoveryEntry>()

function stripSelectorPrefix(worktree: string): string {
  return worktree.startsWith('id:') ? worktree.slice('id:'.length) : worktree
}

export function resolveBuildReviewDiscoveryContext(
  worktree: string
): { hostKey: string; runtime: RuntimeGitContext } | null {
  const state = useAppStore.getState()
  const key = stripSelectorPrefix(worktree)
  const folder = key.startsWith('folder:')
    ? state.folderWorkspaces.find((candidate) => candidate.id === key.slice('folder:'.length))
    : undefined
  // Folder model discovery must retain its owner instead of probing this computer.
  const worktreeId = key || null
  const connectionId = getConnectionIdFromState(state, worktreeId)
  if (worktreeId && connectionId === undefined) {
    return null
  }
  const settings = getSettingsForWorktreeRuntimeOwner(state, worktreeId)
  const worktreePath =
    folder?.folderPath ?? (worktreeId ? (state.getKnownWorktreeById?.(worktreeId)?.path ?? '') : '')
  const scope = getRuntimeGitScope(settings, connectionId)
  return {
    hostKey: resolveNativeChatModelDiscoveryHostKey(state, worktreeId, worktreePath, scope),
    runtime: {
      settings,
      worktreeId,
      worktreePath,
      ...(connectionId ? { connectionId } : {})
    }
  }
}

async function discover(agent: string, runtime: RuntimeGitContext): Promise<CatalogModel[] | null> {
  const result = await discoverRuntimeCommitMessageModels(runtime, agent)
  // Why: a spec's static fallback list is not the host's answer; only a real
  // probe may replace the seed's membership.
  if (!result.success || result.models.length === 0 || result.catalogOrigin !== 'probe') {
    return null
  }
  return catalogModelsFromDiscovery(agent, result.models)
}

function ensureDiscovery(
  agent: string,
  context: { hostKey: string; runtime: RuntimeGitContext },
  listener: (models: CatalogModel[] | null) => void
): () => void {
  const key = JSON.stringify([agent, context.hostKey])
  let entry = discoveryByAgentHost.get(key)
  if (!entry) {
    const created: DiscoveryEntry = { state: 'pending', models: null, listeners: new Set() }
    entry = created
    discoveryByAgentHost.set(key, created)
    void discover(agent, context.runtime)
      .catch(() => null)
      .then((models) => {
        created.state = 'settled'
        created.models = models
        for (const notify of created.listeners) {
          notify(models)
        }
      })
  }
  entry.listeners.add(listener)
  return () => entry.listeners.delete(listener)
}

export function readBuildReviewDiscoveredModels(
  agent: string,
  hostKey: string
): CatalogModel[] | null {
  return discoveryByAgentHost.get(JSON.stringify([agent, hostKey]))?.models ?? null
}

export function clearBuildReviewModelDiscoveryForTests(): void {
  discoveryByAgentHost.clear()
}

/** Models the chosen agent can run on the workspace's host: the live probe when it answered, else the seed. */
export function useBuildReviewAgentModels(
  agent: string,
  worktree: string,
  enabled = true
): CatalogModel[] {
  const context = useMemo(() => resolveBuildReviewDiscoveryContext(worktree), [worktree])
  const [discovered, setDiscovered] = useState<CatalogModel[] | null>(() =>
    context ? readBuildReviewDiscoveredModels(agent, context.hostKey) : null
  )
  useEffect(() => {
    if (!enabled || !context) {
      setDiscovered(null)
      return
    }
    setDiscovered(readBuildReviewDiscoveredModels(agent, context.hostKey))
    return ensureDiscovery(agent, context, setDiscovered)
  }, [agent, context, enabled])
  return useMemo(() => resolveBuildReviewModels(agent, discovered), [agent, discovered])
}
