import { useEffect, useMemo } from 'react'
import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session-resume'
import { agentProviderSessionsEqual } from '../../../../shared/agent-session-resume'
import { normalizeBackgroundTaskCountField } from '../../../../shared/agent-status-field-normalization'
import {
  hasPersistedStructuredAgentSessionTurn,
  projectStructuredAgentSessionStatus,
  structuredAgentSessionPaneKey
} from '../../../../shared/structured-agent-session-projection'
import type { StructuredAgentSessionState } from '../../../../shared/structured-agent-session-reducer'
import type { Tab } from '../../../../shared/tab-types'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { useAppStore } from '@/store'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { useStructuredAgentSessionReadObservation } from './use-structured-agent-session-read'

type StructuredTab = Tab & { contentType: 'agent-session' }

function latestPrompt(state: StructuredAgentSessionState): string {
  for (let index = state.items.length - 1; index >= 0; index -= 1) {
    const body = state.items[index]?.body
    if (body?.kind === 'message' && body.role === 'user') {
      return body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
    }
  }
  return ''
}

function projectStatus(
  tab: StructuredTab,
  state: StructuredAgentSessionState,
  providerSession: AgentProviderSessionMetadata | undefined
): void {
  const paneKey = structuredAgentSessionPaneKey(tab.id, tab.entityId)
  const store = useAppStore.getState()
  if (!hasPersistedStructuredAgentSessionTurn(state.items)) {
    if (store.agentStatusByPaneKey?.[paneKey]) {
      store.removeAgentStatus(paneKey)
    }
    return
  }
  const projection = projectStructuredAgentSessionStatus(state.items)
  const background = state.backgroundTasks
  // Why: same rule as the host feed — background tasks after the turn are waited on, not executed.
  const waitingOnBackground = projection === 'idle' && Boolean(background)
  const desired = {
    state:
      projection === 'working' || waitingOnBackground
        ? 'working'
        : projection === 'attention'
          ? 'blocked'
          : 'done',
    workingMode: waitingOnBackground ? 'monitoring' : undefined,
    backgroundTaskCount: waitingOnBackground
      ? normalizeBackgroundTaskCountField(background?.tasks?.length, 'monitoring')
      : undefined,
    prompt: latestPrompt(state),
    agentType: tab.agentSessionAgent,
    sessionBoundary: projection === 'idle'
  } as const
  const current = store.agentStatusByPaneKey?.[paneKey]
  if (
    current?.state === desired.state &&
    current.workingMode === desired.workingMode &&
    current.backgroundTaskCount === desired.backgroundTaskCount &&
    current.prompt === desired.prompt &&
    current.agentType === desired.agentType &&
    current.sessionBoundary === desired.sessionBoundary &&
    current.terminalTitle === tab.label &&
    current.tabId === tab.id &&
    current.worktreeId === tab.worktreeId &&
    current.terminalResumeEligible === false &&
    agentProviderSessionsEqual(tab.agentSessionAgent, current.providerSession, providerSession)
  ) {
    return
  }
  store.setAgentStatus(
    paneKey,
    desired,
    tab.label,
    undefined,
    { tabId: tab.id, worktreeId: tab.worktreeId },
    {
      ...(providerSession ? { providerSession } : {}),
      terminalResumeEligible: false
    }
  )
}

export function LegacyStructuredAgentSessionStatusProjection({
  tab
}: {
  tab: StructuredTab
}): null {
  const environmentId = useAppStore((state) =>
    getRuntimeEnvironmentIdForWorktree(state, tab.worktreeId)
  )
  const target = useMemo(
    () => getActiveRuntimeTarget({ activeRuntimeEnvironmentId: environmentId }),
    [environmentId]
  )
  const { providerSession, state } = useStructuredAgentSessionReadObservation({
    sessionId: tab.entityId,
    target
  })
  useEffect(() => {
    projectStatus(tab, state, providerSession)
  }, [providerSession, state, tab])
  useEffect(
    () => () =>
      useAppStore.getState().removeAgentStatus(structuredAgentSessionPaneKey(tab.id, tab.entityId)),
    [tab.entityId, tab.id]
  )
  return null
}
