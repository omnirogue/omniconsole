import { useAppStore } from '@/store'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { getAgentDetectionTargetKeyForWorktree } from '@/hooks/useAgentDetectionTarget'
import { buildWorkspaceSessionPayload } from './workspace-session'
import { persistWorkspaceSessionByHost } from './workspace-session-host-persistence'
import {
  isWorkflowPresetTitle,
  workflowAnchorKind,
  isGraphWorkflowKind,
  workflowPresetLabel,
  type WorkflowKind
} from '@/components/local-workflows/workflow-presets'
import { createLocalWorkflowGraphDraft } from '../../../shared/local-workflow-draft'
import { createLocalWorkflowAuditDraft } from '../../../shared/workflow-audit-draft'
import { normalizeWorkflowSpec } from '../../../shared/workflow-graph-normalize'
import { withoutHiddenOutputFile } from '@/components/local-workflows/workflow-setup-props'
import { translate } from '@/i18n/i18n'
import type { LocalWorkflowLaunch } from '../../../shared/local-workflow-launch'

/** A tab title from the request: folded onto one line and cut near 48 characters. */
export function localWorkflowTitleFromPrompt(prompt: string): string | undefined {
  const line = prompt.replace(/\s+/g, ' ').trim()
  if (!line) {
    return undefined
  }
  return line.length <= 48 ? line : `${line.slice(0, 47).trimEnd()}…`
}

/**
 * Opens a workflow tab. A custom workflow is a Council anchor carrying an empty custom graph, so
 * older builds that do not know graphs still restore the tab; `workflowAnchorKind` reads it back.
 * A tab opened for a command (`omni find`) stays in the background, so it never takes the view.
 */
export function createLocalWorkflowConversation(
  worktreeId: string,
  kind: WorkflowKind,
  options: { background?: boolean; launch?: LocalWorkflowLaunch } = {}
): string {
  const preset = kind === 'audit' ? 'discover' : isGraphWorkflowKind(kind) ? 'council' : kind
  const state = useAppStore.getState()
  const target = getAgentDetectionTargetKeyForWorktree(state, worktreeId)
  // Why: Build + Review coordinates here and dispatches its workers to the SSH host; Evolve runs
  // on a fleet host whatever the workspace; the other workflows run every agent on this machine.
  const sshBuildReview = kind === 'build-review' && Boolean(target?.startsWith('ssh:'))
  if (target !== 'local' && !sshBuildReview && kind !== 'evolve') {
    throw new Error(
      kind === 'build-review'
        ? translate(
            'localWorkflow.chooseBuildReviewWorkspace',
            'Choose a local or SSH workspace for Build + Review.'
          )
        : translate(
            'localWorkflow.chooseLocalWorkspace',
            'Choose a local workspace for this workflow.'
          )
    )
  }
  const groupId =
    state.activeGroupIdByWorktree[worktreeId] ?? state.groupsByWorktree[worktreeId]?.[0]?.id
  const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  const activeId = state.groupsByWorktree[worktreeId]?.find(
    (group) => group.id === groupId
  )?.activeTabId
  const active = tabs.find((tab) => tab.id === activeId)
  const viewMode =
    active?.viewMode ?? (state.settings?.openAgentTabsInChatByDefault ? 'chat' : 'terminal')
  const tab = state.createTab(worktreeId, groupId, undefined, {
    ...(options.launch ? { id: `workflow-${options.launch.operationId}` } : {}),
    localWorkflow: {
      preset,
      prompt: '',
      ...(kind === 'audit' ? { draft: createLocalWorkflowAuditDraft() } : {}),
      ...(options.launch ? { launch: options.launch } : {}),
      ...(isGraphWorkflowKind(kind)
        ? {
            // Best of N and Improve are drawn from the models this host lists once it answers
            // (graphDraftFor).
            draft: createLocalWorkflowGraphDraft({
              prompt: '',
              graph: {
                spec: normalizeWorkflowSpec({
                  title: workflowPresetLabel(kind),
                  template: kind,
                  steps: []
                }),
                team: []
              }
            })
          }
        : {})
    },
    viewMode,
    ...(options.background ? { activate: false } : {})
  })
  state.setTabCustomTitle(tab.id, workflowPresetLabel(kind), { origin: 'generated' })
  if (!options.background) {
    state.setActiveTabType('terminal')
    state.setActiveView('terminal')
  }
  return tab.id
}

/**
 * Once a run starts the tab is named after its request, so several Council or Discover tabs can
 * be told apart. A title the person typed themselves is kept.
 */
export function titleLocalWorkflowConversation(tabId: string, prompt: string): void {
  const state = useAppStore.getState()
  const tab = Object.values(state.tabsByWorktree)
    .flat()
    .find((entry) => entry.id === tabId)
  const title = localWorkflowTitleFromPrompt(prompt)
  const preset = tab?.localWorkflow ? workflowAnchorKind(tab.localWorkflow) : undefined
  if (!tab || !preset || !title) {
    return
  }
  if (tab.customTitle && !isWorkflowPresetTitle(preset, tab.customTitle)) {
    return
  }
  state.setTabCustomTitle(tabId, title, { origin: 'generated' })
}

export function updateLocalWorkflowConversation(
  worktreeId: string,
  tabId: string,
  patch: Partial<NonNullable<TerminalTab['localWorkflow']>>
): void {
  useAppStore.setState((state) => ({
    tabsByWorktree: {
      ...state.tabsByWorktree,
      [worktreeId]: (state.tabsByWorktree[worktreeId] ?? []).map((tab) =>
        tab.id === tabId && tab.localWorkflow
          ? { ...tab, localWorkflow: { ...tab.localWorkflow, ...patch } }
          : tab
      )
    }
  }))
}

export async function persistLocalWorkflowConversationAnchor(
  worktreeId: string,
  tabId: string
): Promise<void> {
  const state = useAppStore.getState()
  const tab = state.tabsByWorktree[worktreeId]?.find((entry) => entry.id === tabId)
  if (!tab?.localWorkflow) {
    throw new Error('Workflow conversation anchor is unavailable or changed.')
  }
  await persistWorkspaceSessionByHost(
    window.api.session,
    buildWorkspaceSessionPayload(state, { includePendingConversations: true }),
    state
  )
}

export function prepareLocalWorkflowTurn(source: TerminalTab, prompt: string): string {
  const workflow = source.localWorkflow
  if (!workflow || workflow.preset === 'build-review' || workflow.preset === 'evolve') {
    throw new Error('Choose a Council or Discover conversation.')
  }
  const tabId = createLocalWorkflowConversation(source.worktreeId, workflowAnchorKind(workflow))
  updateLocalWorkflowConversation(source.worktreeId, tabId, {
    prompt,
    ...(workflow.draft
      ? { draft: { ...withoutHiddenOutputFile(structuredClone(workflow.draft)), prompt } }
      : {})
  })
  return tabId
}
