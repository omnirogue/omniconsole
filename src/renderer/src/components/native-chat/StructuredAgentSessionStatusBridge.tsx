import { LegacyStructuredAgentSessionStatusProjection } from './LegacyStructuredAgentSessionStatusProjection'
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { agentProviderSessionsEqual } from '../../../../shared/agent-session-resume'
import type { AgentSessionStatusSummary } from '../../../../shared/agent-session-wire'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionStatusState
} from '../../../../shared/structured-agent-session-projection'
import type { Tab } from '../../../../shared/tab-types'
import { isAgentSessionHandleProvider } from '../../../../shared/agent-session-provider-handle'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { useAppStore } from '@/store'
import { getActiveRuntimeTarget, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/structured-agent-session-status-feed'

type StructuredTab = Tab & { contentType: 'agent-session' }

function isStructuredTab(tab: Tab): tab is StructuredTab {
  return tab.contentType === 'agent-session' && isAgentSessionHandleProvider(tab.agentSessionAgent)
}

const structuredTabsByUnifiedTabsSnapshot = new WeakMap<
  Record<string, Tab[]>,
  readonly StructuredTab[]
>()

/** Project structured-session tabs once per immutable tab-map snapshot. */
export function getStructuredAgentSessionTabs(
  unifiedTabsByWorktree: Record<string, Tab[]>
): readonly StructuredTab[] {
  const cached = structuredTabsByUnifiedTabsSnapshot.get(unifiedTabsByWorktree)
  if (cached) {
    return cached
  }

  const tabs: StructuredTab[] = []
  for (const worktreeTabs of Object.values(unifiedTabsByWorktree)) {
    for (const tab of worktreeTabs) {
      if (isStructuredTab(tab)) {
        tabs.push(tab)
      }
    }
  }
  structuredTabsByUnifiedTabsSnapshot.set(unifiedTabsByWorktree, tabs)
  return tabs
}

/** The host's projected status for one session, live while the caller is mounted. */
function useStructuredAgentSessionStatusSummary(
  sessionId: string,
  target: RuntimeClientTarget
): { summary: AgentSessionStatusSummary | null; unsupported: boolean } {
  const pairingRevision = useAppStore((state) => {
    const environment =
      target.kind === 'environment'
        ? state.runtimeEnvironments?.find((entry) => entry.id === target.environmentId)
        : undefined
    return environment?.pairingRevision ?? environment?.createdAt
  })
  const feed = useMemo(
    () => getStructuredAgentSessionStatusFeed(target, pairingRevision),
    [target, pairingRevision]
  )
  useEffect(() => feed.activate(), [feed])
  const summary = useSyncExternalStore(
    feed.subscribe,
    () => feed.getSnapshot().get(sessionId) ?? null,
    () => null
  )
  const support = useSyncExternalStore(feed.subscribe, feed.getSupport, feed.getSupport)
  return { summary, unsupported: support === 'unsupported' }
}

function projectStatus(tab: StructuredTab, summary: AgentSessionStatusSummary | null): void {
  const paneKey = structuredAgentSessionPaneKey(tab.id, tab.entityId)
  const store = useAppStore.getState()
  // No persisted turn yet (or nothing known): the row shows no agent status at all.
  if (!summary?.status) {
    if (store.agentStatusByPaneKey?.[paneKey]) {
      store.removeAgentStatus(paneKey)
    }
    return
  }
  const desired = {
    // Shared with `worktree ps`, so the CLI and this row cannot disagree about one session.
    state: structuredAgentSessionStatusState(summary.status),
    prompt: summary.latestPrompt,
    agentType: tab.agentSessionAgent,
    // The host projects these from the journal so the row reads like a hook-reported one:
    // the running tool while a turn is live, the agent's last words once it settles.
    ...(summary.model ? { model: summary.model } : {}),
    ...(summary.toolName ? { toolName: summary.toolName } : {}),
    ...(summary.toolInput ? { toolInput: summary.toolInput } : {}),
    ...(summary.lastAssistantMessage ? { lastAssistantMessage: summary.lastAssistantMessage } : {}),
    workingMode: summary.workingMode,
    backgroundTaskCount: summary.backgroundTaskCount,
    failed: summary.failed,
    interrupted: summary.interrupted,
    restoredUnconfirmed: summary.status !== 'idle' && !summary.hostExecutionOwned,
    sessionBoundary: false
  } as const
  const current = store.agentStatusByPaneKey?.[paneKey]
  if (
    current?.state === desired.state &&
    current.workingMode === desired.workingMode &&
    current.backgroundTaskCount === desired.backgroundTaskCount &&
    current.failed === desired.failed &&
    current.interrupted === desired.interrupted &&
    current.prompt === desired.prompt &&
    current.agentType === desired.agentType &&
    // A row keeps the last model it was told about, so only a reported one can differ.
    (summary.model === undefined || current.model === summary.model) &&
    current.toolName === summary.toolName &&
    current.toolInput === summary.toolInput &&
    current.lastAssistantMessage === summary.lastAssistantMessage &&
    current.sessionBoundary === desired.sessionBoundary &&
    current.evidenceObservedAt === summary.updatedAt &&
    current.terminalTitle === tab.label &&
    current.tabId === tab.id &&
    current.worktreeId === tab.worktreeId &&
    current.terminalResumeEligible === false &&
    current.structuredHostOwned === summary.hostExecutionOwned &&
    agentProviderSessionsEqual(
      tab.agentSessionAgent,
      current.providerSession,
      summary.providerSession
    )
  ) {
    return
  }
  store.setAgentStatus(
    paneKey,
    desired,
    tab.label,
    {
      updatedAt: summary.updatedAt,
      allowOlderTimestamp: true,
      stateStartedAt:
        desired.state !== 'done' && current?.state === desired.state
          ? current.stateStartedAt
          : summary.updatedAt,
      evidenceObservedAt: summary.updatedAt
    },
    { tabId: tab.id, worktreeId: tab.worktreeId },
    {
      ...(summary.providerSession ? { providerSession: summary.providerSession } : {}),
      terminalResumeEligible: false,
      ...(summary.hostExecutionOwned ? { structuredHostOwned: true as const } : {})
    }
  )
}

function StructuredAgentSessionStatusProjection({
  tab
}: {
  tab: StructuredTab
}): React.JSX.Element | null {
  const environmentId = useAppStore((state) =>
    getRuntimeEnvironmentIdForWorktree(state, tab.worktreeId)
  )
  const target = useMemo(
    () => getActiveRuntimeTarget({ activeRuntimeEnvironmentId: environmentId }),
    [environmentId]
  )
  const { summary, unsupported } = useStructuredAgentSessionStatusSummary(tab.entityId, target)
  useEffect(() => {
    if (!unsupported) {
      projectStatus(tab, summary)
    }
  }, [summary, tab, unsupported])
  useEffect(
    () => () =>
      useAppStore.getState().removeAgentStatus(structuredAgentSessionPaneKey(tab.id, tab.entityId)),
    [tab.entityId, tab.id]
  )
  return unsupported ? <LegacyStructuredAgentSessionStatusProjection tab={tab} /> : null
}

export function StructuredAgentSessionStatusBridge(): React.JSX.Element {
  const tabs = useAppStore(
    useShallow((state) => getStructuredAgentSessionTabs(state.unifiedTabsByWorktree))
  )
  return (
    <>
      {tabs.map((tab) => (
        <StructuredAgentSessionStatusProjection key={`${tab.id}:${tab.entityId}`} tab={tab} />
      ))}
    </>
  )
}
