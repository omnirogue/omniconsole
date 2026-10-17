import { singlePaneTabAgentTemplate } from './tab-agent-template-attribution'
import {
  isMirrorRecordRelaunchRefused,
  isNonOwnedWorkspaceRecordLaunchRefused
} from './mirror-record-relaunch-guard'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { buildAgentResumeStartupPlan } from '@/lib/tui-agent-startup'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { reconcileTabOrder } from '@/components/tab-bar/reconcile-order'
import {
  isLocalAgentResumeHost,
  resolveAgentResumeLaunchTarget,
  type AgentResumeLaunchTarget
} from '@/lib/agent-resume-launch-target'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { pinAgentResumeAccountHome } from '../../../shared/agent-resume-account-home'
import { translate } from '@/i18n/i18n'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { makePaneKey, parsePaneKey } from '../../../shared/stable-pane-id'

export type ResumeSleepingAgentSessionsOptions = {
  tabId?: string
  suppressNavigation?: boolean
  viewMode?: 'chat' | 'terminal'
  /** Provider-session claim keys already woken in place by mounted panes
   *  (WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT). Their sleeping records are
   *  cleared only after the in-place spawn succeeds, so the generic resume
   *  must neither launch nor clear them here. */
  skipClaimKeys?: ReadonlySet<string>
  /** Called with the tab id of each freshly launched resume tab, so
   *  navigation-suppressed callers can background-mount exactly those tabs. */
  onSessionLaunched?: (tabId: string) => void
  /** Activation sweeps only: the tab appears at once but spawns and resumes on first reveal (#857). */
  deferStartupUntilRevealed?: boolean
  /** Per-record form of deferStartupUntilRevealed (the restore flood guard's background wake). */
  deferStartupUntilRevealedFor?: (record: SleepingAgentSessionRecord) => boolean
}

function getResumeLaunchTarget(
  worktreeId: string
): AgentResumeLaunchTarget & { isLocalHost: boolean } {
  const state = useAppStore.getState()
  const worktree = state.getKnownWorktreeById(worktreeId)
  const repo = worktree ? state.repos.find((entry) => entry.id === worktree.repoId) : null
  // The resume tab is created without a shell override, so the global Windows shell wins.
  const targetArgs = {
    projectRuntime: getLocalProjectExecutionRuntimeContext(state, worktreeId),
    connectionId: repo?.connectionId,
    executionHostId: getExecutionHostIdForWorktree(state, worktreeId),
    worktreePath: worktree?.path,
    terminalWindowsShell: state.settings?.terminalWindowsShell
  }
  return {
    ...resolveAgentResumeLaunchTarget(targetArgs),
    isLocalHost: isLocalAgentResumeHost(targetArgs)
  }
}

function appendTabToWorktreeOrder(worktreeId: string, tabId: string): void {
  const state = useAppStore.getState()
  const termIds = (state.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
  const editorIds = state.openFiles
    .filter((file) => file.worktreeId === worktreeId)
    .map((f) => f.id)
  const browserIds = (state.browserTabsByWorktree?.[worktreeId] ?? []).map((tab) => tab.id)
  const base = reconcileTabOrder(
    state.tabBarOrderByWorktree[worktreeId],
    termIds,
    editorIds,
    browserIds
  )
  const order = base.filter((id) => id !== tabId)
  order.push(tabId)
  state.setTabBarOrder(worktreeId, order)
}

// Why: the deferred startup is runtime-only; a restart before the first click would otherwise
// restore a bare shell. Keyed to the tab's own pane, the record is resumed by that pane's cold
// restore on reveal and cleared when that spawn succeeds (or the tab is closed).
function rekeySleepingRecordOntoDeferredTab(
  record: SleepingAgentSessionRecord,
  tabId: string,
  leafId: string
): void {
  const paneKey = makePaneKey(tabId, leafId)
  useAppStore.setState((s) => ({
    sleepingAgentSessionsByPaneKey: {
      ...s.sleepingAgentSessionsByPaneKey,
      [paneKey]: { ...record, paneKey, tabId, resumeOnFirstReveal: true }
    }
  }))
}

// Why: mobile-driven wake runs on the desktop host renderer, so it must create
// the resume tab without stealing the desktop's active worktree/tab/view.
export function launchSleepingAgentSession(
  record: SleepingAgentSessionRecord,
  options?: ResumeSleepingAgentSessionsOptions
): boolean {
  const state = useAppStore.getState()
  // Why: every relaunch path (activation sweep, wake, a person's resume) is held to the same rule:
  // another computer's pane relaunches only while its owner lists that exact pane, and nothing
  // relaunches under a workspace another computer owns or none can settle (step 7).
  if (
    isMirrorRecordRelaunchRefused(record, state) ||
    isNonOwnedWorkspaceRecordLaunchRefused(record, state)
  ) {
    return false
  }
  const launchConfig = record.launchConfig
  const resumeTarget = getResumeLaunchTarget(record.worktreeId)
  const planArgs = {
    agent: record.agent,
    providerSession: record.providerSession,
    cmdOverrides: state.settings?.agentCmdOverrides ?? {},
    agentArgs:
      launchConfig !== undefined
        ? launchConfig.agentArgs
        : resolveTuiAgentLaunchArgs(record.agent, state.settings?.agentDefaultArgs),
    agentEnv:
      launchConfig !== undefined
        ? launchConfig.agentEnv
        : resolveTuiAgentLaunchEnv(record.agent, state.settings?.agentDefaultEnv),
    ...(launchConfig?.agentCommand ? { agentCommand: launchConfig.agentCommand } : {}),
    ...(launchConfig?.ompResumeFilePath
      ? { ompResumeFilePath: launchConfig.ompResumeFilePath }
      : {}),
    platform: resumeTarget.platform,
    shell: resumeTarget.shell
  }
  const startupPlan = buildAgentResumeStartupPlan(
    resumeTarget.isLocalHost ? pinAgentResumeAccountHome(planArgs) : planArgs
  )
  if (!startupPlan) {
    toast.error(
      translate(
        'auto.lib.resume.sleeping.agent.session.f235f604fd',
        'This agent session cannot be resumed.'
      )
    )
    return false
  }

  const originTabId = record.tabId ?? parsePaneKey(record.paneKey)?.tabId
  // Why the origin tab too: a record built after the agent exited was never captured with it.
  const agentTemplate =
    record.agentTemplate ??
    (originTabId
      ? singlePaneTabAgentTemplate(
          state.tabsByWorktree[record.worktreeId]?.find((tab) => tab.id === originTabId),
          state.terminalLayoutsByTabId[originTabId]
        )
      : undefined)
  const deferStartup =
    options?.deferStartupUntilRevealed === true ||
    options?.deferStartupUntilRevealedFor?.(record) === true
  const initialLeafId = deferStartup ? createBrowserUuid() : undefined
  const tab = state.createTab(record.worktreeId, undefined, undefined, {
    ...(options?.tabId ? { id: options.tabId } : {}),
    launchAgent: record.agent,
    ...(initialLeafId ? { initialLeafId } : {}),
    ...(options?.viewMode ? { viewMode: options.viewMode } : {}),
    pendingStartup: {
      command: startupPlan.launchCommand,
      ...(startupPlan.env ? { env: startupPlan.env } : {}),
      launchConfig: startupPlan.launchConfig,
      resumeProviderSession: record.providerSession,
      launchAgent: record.agent,
      ...(launchConfig ? { agentArgsOverride: launchConfig.agentArgs } : {}),
      ...(startupPlan.startupCommandDelivery
        ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
        : {}),
      showSessionRestoredBanner: true,
      ...(deferStartup ? { deferUntilRevealed: true as const } : {}),
      telemetry: {
        agent_kind: tuiAgentToAgentKind(record.agent),
        launch_source: 'sidebar',
        request_kind: 'resume'
      }
    },
    automaticResumeClaim: {
      worktreeId: record.worktreeId,
      launchAgent: record.agent,
      providerSession: record.providerSession
    },
    ...(options?.suppressNavigation ? { activate: false, recordInteraction: false } : {})
  })
  if (agentTemplate) {
    state.setTabAgentTemplate(tab.id, agentTemplate)
  }
  state.clearSleepingAgentSession(record.paneKey)
  if (initialLeafId) {
    rekeySleepingRecordOntoDeferredTab(record, tab.id, initialLeafId)
  }
  if (!options?.suppressNavigation) {
    state.setActiveTabType('terminal')
  }
  appendTabToWorktreeOrder(record.worktreeId, tab.id)
  options?.onSessionLaunched?.(tab.id)
  return true
}
