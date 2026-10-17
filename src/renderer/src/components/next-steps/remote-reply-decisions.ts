import { getReachableRuntimeSessionMirrorTargets } from '@/lib/runtime-session-mirror-targets'
import type { RuntimeSessionMirrorTarget } from '@/lib/runtime-session-mirror-targets'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { matchesNextStepReplyPtyProof } from '../../../../shared/next-step-reply-proof'
import { isLocalReplyDecisionCurrent, replyDecisionEntryFingerprint } from './local-reply-decisions'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import {
  normalizeConversationSource,
  structuredConversationSource,
  type ConversationSource
} from '../../../../shared/conversation-source'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import {
  NEXT_STEPS_RPC,
  type NextStepReplyDecision,
  type NextStepsListResult
} from '../../../../shared/next-step-suggestions-rpc'
import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { makePaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import {
  isCanonicalWebTerminalSurfaceTabId,
  isWebTerminalSurfaceTabId,
  toHostSessionTabId
} from '../../../../shared/terminal-surface-id'

type RemoteReplyDecisionOwner = RuntimeSessionMirrorTarget & {
  source: ConversationSource
  sourceFingerprint: string
}

export type ProjectedReplyDecision = NextStepReplyDecision & {
  remoteOwner?: RemoteReplyDecisionOwner
  localSourceFingerprint?: string
}

type MirroredSource = {
  conversation: ConversationSource
  source: ConversationSource
  fingerprint: string
}

function ownerIsCurrent(owner: RuntimeSessionMirrorTarget, state: Partial<AppState>): boolean {
  const environment = state.runtimeEnvironments?.find((item) => item.id === owner.environmentId)
  const status = state.runtimeStatusByEnvironmentId?.get(owner.environmentId)
  return (
    state.runtimeEnvironmentCatalogHydrated === true &&
    environment !== undefined &&
    (environment.pairingRevision ?? environment.createdAt) === owner.pairingRevision &&
    getRuntimeEnvironmentRevision(owner.environmentId) === owner.pairingRevision &&
    status?.status?.runtimeId === owner.runtimeId &&
    (status.connectionGeneration ?? 0) === owner.connectionGeneration
  )
}

function sourceKey(source: ConversationSource): string {
  return JSON.stringify([source.worktreeId, source.paneKey, source.kind, source.sessionId ?? null])
}

function mirroredSource(
  state: Partial<AppState>,
  owner: RuntimeSessionMirrorTarget,
  entry: AgentStatusEntry
): MirroredSource | null {
  const pane = parsePaneKey(entry.paneKey)
  const worktreeId = entry.worktreeId
  if (!pane || !worktreeId || entry.connectionId || entry.restoredUnconfirmed) {
    return null
  }
  const tabs = state.unifiedTabsByWorktree?.[worktreeId]?.filter((tab) => tab.id === pane.tabId)
  const tab = tabs?.length === 1 ? tabs[0] : undefined
  if (
    !tab ||
    tab.worktreeId !== worktreeId ||
    tab.executionHostId !== toRuntimeExecutionHostId(owner.environmentId) ||
    (entry.tabId !== undefined && entry.tabId !== tab.id)
  ) {
    return null
  }
  let source: ConversationSource
  let ptyId: string | undefined
  if (tab.contentType === 'terminal') {
    const hostTabId = toHostSessionTabId(tab.id)
    ptyId = state.terminalLayoutsByTabId?.[tab.id]?.ptyIdsByLeafId?.[pane.leafId]
    const pty = ptyId ? parseRemoteRuntimePtyId(ptyId) : null
    if (
      !isWebTerminalSurfaceTabId(tab.id) ||
      !isCanonicalWebTerminalSurfaceTabId(tab.id, hostTabId, owner.environmentId) ||
      pty?.environmentId !== owner.environmentId ||
      !pty.handle ||
      !entry.providerSession?.id ||
      (entry.terminalHandle !== undefined && entry.terminalHandle !== pty.handle)
    ) {
      return null
    }
    source = { worktreeId, paneKey: makePaneKey(hostTabId, pane.leafId), kind: 'pty' }
  } else if (tab.contentType === 'agent-session') {
    if (!tab.entityId || structuredAgentSessionPaneKey(tab.id, tab.entityId) !== entry.paneKey) {
      return null
    }
    source = structuredConversationSource(worktreeId, tab.entityId)
  } else {
    return null
  }
  const conversation = { ...source, paneKey: entry.paneKey }
  return {
    source,
    conversation,
    fingerprint: JSON.stringify([
      sourceKey(source),
      replyDecisionEntryFingerprint(entry),
      tab.entityId,
      tab.executionHostId,
      ptyId ?? null
    ])
  }
}

export function isReplyDecisionOwnerCurrent(
  decision: ProjectedReplyDecision,
  state: Partial<AppState>
): boolean {
  const entry = state.agentStatusByPaneKey?.[decision.conversation.paneKey]
  if (!entry || entry.connectionId) {
    return false
  }
  const owner = decision.remoteOwner
  if (!owner) {
    if (decision.conversation.kind === 'pty') {
      return isLocalReplyDecisionCurrent(decision, state)
    }
    const pane = parsePaneKey(decision.conversation.paneKey)
    const tab = state.unifiedTabsByWorktree?.[decision.conversation.worktreeId]?.find(
      (item) => item.id === pane?.tabId
    )
    return !tab?.executionHostId || tab.executionHostId === 'local'
  }
  if (!ownerIsCurrent(owner, state)) {
    return false
  }
  if (
    owner.source.kind === 'pty' &&
    (!decision.ptyProof ||
      decision.ptyProof.turnKey !== decision.turnKey ||
      !matchesNextStepReplyPtyProof(decision.ptyProof, entry))
  ) {
    return false
  }
  const current = mirroredSource(state, owner, entry)
  return (
    current !== null &&
    sourceKey(current.conversation) === sourceKey(decision.conversation) &&
    sourceKey(current.source) === sourceKey(owner.source) &&
    current.fingerprint === owner.sourceFingerprint
  )
}

/** Only paired owners supply decisions; remote suggestion sets never enter the local queue. */
export async function readRemoteReplyDecisions(): Promise<ProjectedReplyDecision[]> {
  const initial = useAppStore.getState()
  const targets = getReachableRuntimeSessionMirrorTargets(initial)
  const results = await Promise.all(
    targets.map(async (owner): Promise<ProjectedReplyDecision[]> => {
      if (!ownerIsCurrent(owner, initial)) {
        return []
      }
      const sources = new Map<string, MirroredSource>()
      const ambiguous = new Set<string>()
      for (const entry of Object.values(initial.agentStatusByPaneKey ?? {})) {
        const source = mirroredSource(initial, owner, entry)
        if (!source) {
          continue
        }
        const key = sourceKey(source.source)
        if (sources.has(key)) {
          ambiguous.add(key)
        }
        sources.set(key, source)
      }
      if (sources.size === 0) {
        return []
      }
      try {
        const result = await callRuntimeRpc<NextStepsListResult & { executionRuntimeId?: string }>(
          { kind: 'environment', environmentId: owner.environmentId },
          NEXT_STEPS_RPC.list,
          { statuses: ['pending'] },
          { timeoutMs: 10_000, expectedEnvironmentPairingRevision: owner.pairingRevision }
        )
        if (
          result.executionRuntimeId !== owner.runtimeId ||
          !Array.isArray(result.replyDecisions)
        ) {
          return []
        }
        const current = useAppStore.getState()
        return result.replyDecisions.flatMap((decision) => {
          const source = normalizeConversationSource(decision?.conversation)
          if (
            !source ||
            typeof decision.turnKey !== 'string' ||
            !decision.turnKey ||
            typeof decision.question !== 'string' ||
            !decision.question.trim() ||
            !Number.isFinite(decision.completedAt) ||
            decision.completedAt <= 0
          ) {
            return []
          }
          const key = sourceKey(source)
          const captured = sources.get(key)
          if (!captured || ambiguous.has(key)) {
            return []
          }
          const projected: ProjectedReplyDecision = {
            conversation: captured.conversation,
            turnKey: decision.turnKey,
            question: decision.question,
            completedAt: decision.completedAt,
            ...(decision.ptyProof ? { ptyProof: decision.ptyProof } : {}),
            remoteOwner: { ...owner, source, sourceFingerprint: captured.fingerprint }
          }
          return isReplyDecisionOwnerCurrent(projected, current) ? [projected] : []
        })
      } catch {
        // Missing methods, unreachable owners and replaced pairings carry no current decision.
        return []
      }
    })
  )
  return results.flat()
}
