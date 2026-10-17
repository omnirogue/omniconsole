import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { getAgentDetectionTargetKeyForWorktree } from '@/hooks/useAgentDetectionTarget'
import {
  persistLocalWorkflowConversationAnchor,
  updateLocalWorkflowConversation
} from '@/lib/local-workflow-conversation'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { workspaceLaunchTaskId } from '../../../../shared/workspace-launch-task'
import {
  LOCAL_WORKFLOW_METHODS,
  type LocalWorkflowControlResult,
  type LocalWorkflowReadCallResult,
  type LocalWorkflowSetupResult,
  type LocalWorkflowShowResult,
  type LocalWorkflowStartResult
} from '../../../../shared/local-workflow-rpc'
import type { LocalWorkflowDraft } from '../../../../shared/local-workflow-draft'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { LocalWorkflowController } from './local-workflow-controller'
import { useLocalWorkflowProjection } from './use-local-workflow-projection'
import { useClearLegacyLocalWorkflowStart } from './local-workflow-legacy-start'
import { localWorkflowFollowUpPrompt } from '@/lib/local-workflow-follow-up-prompt'
import { planLocalWorkflowFollowUpLaunch } from '@/lib/local-workflow-follow-up-launch'
import { launchAgentSessionContinuation } from '@/lib/launch-agent-session-continuation'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'

function unavailable(
  state: ReturnType<typeof useAppStore.getState>,
  tab: TerminalTab
): string | undefined {
  const target = getAgentDetectionTargetKeyForWorktree(state, tab.worktreeId)
  if (!target) {
    return 'Resolving the workspace execution host…'
  }
  if (target !== 'local') {
    return 'Council and Discover require a local workspace.'
  }
  const task = workspaceLaunchTaskId(
    tab.worktreeId,
    state.getKnownWorktreeById(tab.worktreeId)?.linkedWorkItem?.hubTaskId,
    state.folderWorkspaces
  )
  return task ? 'Council and Discover are unavailable in card-bound conversations.' : undefined
}

export function useLocalWorkflowController(
  tab: TerminalTab,
  enabled: boolean
): LocalWorkflowController | undefined {
  const workflow = tab.localWorkflow!
  const active = enabled && (workflow.preset === 'council' || workflow.preset === 'discover')
  const reason = useAppStore((state) => (active ? unavailable(state, tab) : undefined))
  const request = {
    worktree: toRuntimeWorktreeSelector(tab.worktreeId),
    conversationId: tab.id,
    preset: workflow.preset === 'discover' ? ('discover' as const) : ('council' as const)
  }
  const { setup, view, loading, error, accept } = useLocalWorkflowProjection(
    request,
    tab.worktreeId,
    workflow.executionId,
    active && !reason
  )
  useEffect(() => {
    if (active && !reason && !workflow.executionId && setup?.executionId) {
      updateLocalWorkflowConversation(tab.worktreeId, tab.id, {
        executionId: setup.executionId,
        startRequest: undefined
      })
    }
  }, [active, reason, tab.worktreeId, tab.id, workflow.executionId, setup?.executionId])
  useClearLegacyLocalWorkflowStart(tab, setup, active && !reason && !loading)
  if (!active) {
    return undefined
  }
  const checkHost = () => {
    const current = unavailable(useAppStore.getState(), tab)
    if (current) {
      throw new Error(current)
    }
  }
  const readCall = async (executionId: string, callId: string) => {
    checkHost()
    if (executionId !== workflow.executionId) {
      throw new Error('Workflow execution changed. Refresh before reading call logs.')
    }
    return callRuntimeRpc<LocalWorkflowReadCallResult>(
      { kind: 'local' },
      LOCAL_WORKFLOW_METHODS.readCall,
      {
        worktree: request.worktree,
        conversationId: request.conversationId,
        executionId,
        callId
      }
    )
  }
  return {
    catalog: setup?.catalog ?? [],
    defaults: setup?.defaults,
    graphTeam: setup?.graphTeam ?? [],
    scopeLabel: setup?.scopeLabel ?? 'Local workspace',
    scopeOptions: setup?.scopeOptions ?? [],
    maxConcurrency: setup?.maxConcurrency ?? 4,
    auditSupport: setup?.auditSupport,
    auditTeam: setup?.auditTeam,
    unavailableReason:
      reason ??
      (setup?.executionId && !workflow.executionId
        ? 'Restoring the existing workflow execution…'
        : workflow.startRequest
          ? undefined
          : workflow.draft?.audit
            ? setup?.auditSupport?.unavailableReason
            : setup?.unavailableReason),
    loading: !reason && !workflow.startRequest && loading,
    error: workflow.startRequest ? undefined : error,
    view,
    start: async (draft: LocalWorkflowDraft) => {
      checkHost()
      const saved =
        useAppStore.getState().tabsByWorktree[tab.worktreeId]?.find((entry) => entry.id === tab.id)
          ?.localWorkflow ?? workflow
      if (saved.executionId) {
        return { executionId: saved.executionId }
      }
      const pending = saved.startRequest ?? {
        requestId: crypto.randomUUID(),
        draft: structuredClone(draft)
      }
      if (JSON.stringify(pending.draft) !== JSON.stringify(draft)) {
        throw new Error(
          'The earlier Start request is unresolved. Retry it before changing the scope.'
        )
      }
      updateLocalWorkflowConversation(tab.worktreeId, tab.id, {
        startRequest: pending,
        draft: pending.draft,
        prompt: pending.draft.prompt
      })
      await persistLocalWorkflowConversationAnchor(tab.worktreeId, tab.id)
      const result = await callRuntimeRpc<LocalWorkflowStartResult>(
        { kind: 'local' },
        LOCAL_WORKFLOW_METHODS.start,
        { ...request, requestId: pending.requestId, draft: pending.draft }
      )
      if ('rejected' in result) {
        updateLocalWorkflowConversation(tab.worktreeId, tab.id, { startRequest: undefined })
        throw new Error(result.reason)
      }
      updateLocalWorkflowConversation(tab.worktreeId, tab.id, {
        executionId: result.executionId,
        startRequest: undefined
      })
      return result
    },
    control: async (executionId, fence, action) => {
      checkHost()
      if (executionId !== workflow.executionId) {
        throw new Error('Workflow execution changed. Refresh before sending a control.')
      }
      const send = (next: typeof action) =>
        callRuntimeRpc<LocalWorkflowControlResult>(
          { kind: 'local' },
          LOCAL_WORKFLOW_METHODS.control,
          {
            worktree: request.worktree,
            conversationId: request.conversationId,
            executionId,
            fence,
            action: next
          }
        )
      const result = await send(action)
      accept(result)
      // A paused run finishes by running again: only its final step still gets agents.
      if (action === 'finish' && result.state === 'paused') {
        accept(await send('resume'))
      }
    },
    readCall,
    followUp: async (executionId, prompt, savedResult) => {
      checkHost()
      if (!view || view.executionId !== executionId || workflow.executionId !== executionId) {
        throw new Error('Workflow execution changed. Refresh before following up.')
      }
      const [fresh, latestView] = await Promise.all([
        callRuntimeRpc<LocalWorkflowSetupResult>(
          { kind: 'local' },
          LOCAL_WORKFLOW_METHODS.setup,
          request
        ),
        callRuntimeRpc<LocalWorkflowShowResult>({ kind: 'local' }, LOCAL_WORKFLOW_METHODS.show, {
          worktree: request.worktree,
          conversationId: request.conversationId,
          executionId
        })
      ])
      if (
        fresh.executionId !== executionId ||
        latestView.executionId !== executionId ||
        latestView.fence < view.fence
      ) {
        throw new Error('Workflow execution changed. Refresh before following up.')
      }
      const state = useAppStore.getState()
      const route = planLocalWorkflowFollowUpLaunch({
        view: latestView,
        catalog: fresh.catalog
      })
      const source = state.unifiedTabsByWorktree[tab.worktreeId]?.find(
        (entry) => entry.entityId === tab.id || entry.id === tab.id
      )
      const groupId =
        source?.groupId ??
        state.activeGroupIdByWorktree[tab.worktreeId] ??
        state.groupsByWorktree[tab.worktreeId]?.[0]?.id
      const workspacePath = state.getKnownWorktreeById(tab.worktreeId)?.path
      if (!workspacePath) {
        throw new Error('The workflow workspace is unavailable.')
      }
      let delivered: Promise<boolean> | undefined
      const started = await launchAgentSessionContinuation({
        ...route,
        worktreeId: tab.worktreeId,
        groupId,
        workspacePath,
        prompt: localWorkflowFollowUpPrompt(latestView, prompt, savedResult),
        viewModePreference: source?.viewMode === 'chat' ? 'chat' : 'terminal',
        launchSource: 'workflow_follow_up',
        shouldLaunch: () =>
          !unavailable(useAppStore.getState(), tab) &&
          useAppStore
            .getState()
            .tabsByWorktree[tab.worktreeId]?.find((entry) => entry.id === tab.id)?.localWorkflow
            ?.executionId === executionId,
        onLaunched: (launch) => {
          delivered = launch.promptDelivered
          if (launch.tabId) {
            activateTabAndFocusPane(launch.tabId, null)
          }
        }
      })
      if (!started || !delivered) {
        throw new Error('The follow-up session could not be launched.')
      }
      if (!(await delivered)) {
        throw new Error('The follow-up prompt was not delivered to the model.')
      }
    }
  }
}
