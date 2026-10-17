import { recordingAgentTemplate } from './session-agent-template-record'
import { recordingSessionLaunch } from './session-launch-record'
import type { LaunchManifest } from '../../../shared/launch-manifest'
import type { SessionAgentTemplate } from '../../../shared/session-agent-template'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { launchAgentInNewTab } from './launch-agent-in-new-tab'
import { selectConsoleAccountScope } from './console-account-scope'
import { sessionContextLaunchBinding } from './session-context-store'
import type { SessionContextAttachment } from '../../../shared/session-context-attachments'
import { conversationLauncherArgs } from './launch-agent-in-new-tab-defaults'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import { launchPreferencesToSessionOptions } from '../../../shared/agent-launch-preference-check'
import { nativeChatEnabledByPreference } from '../../../shared/native-chat-preference'
import type { AgentLaunchPreferences } from '../../../shared/agent-session-host-authority'
import { translate } from '@/i18n/i18n'
import { buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import { composeLaunchAgentPrompt } from '@/lib/launch-agent-outcome-prompt'
import type { LaunchAgentInNewTabArgs } from '@/lib/launch-agent-in-new-tab-types'
import { launchFolderWorkspaceAgentSession } from '@/lib/folder-workspace-agent-launch'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { getCompanyFolderHome, resetCompanyFolderHomeCache } from '@/lib/company-folder-home'
import { useAppStore } from '@/store'
import {
  resolveCompanyFolder,
  resolveDomainFolder,
  type CompanyFolderIdentity
} from '../../../shared/company-folders'
import { ensureCompanySessionWorkspace } from './company-session-workspace'
import type { TuiAgent } from '../../../shared/tui-agent'

export { getCompanyFolderHome, resetCompanyFolderHomeCache }

export type CompanySessionTarget = {
  company: CompanyFolderIdentity & { name: string }
  domain: { id?: string | null; name: string } | null
}

export type StartCompanySessionResult =
  /** `tabId`: the new conversation's tab, when this call opened one. */
  | { ok: true; workspaceId: string; tabId?: string }
  | { ok: false; reason: 'folder-missing'; path: string }
  | { ok: false; reason: 'failed'; message: string }

export async function resolveCompanySessionFolder(target: CompanySessionTarget): Promise<string> {
  const settings = useAppStore.getState().settings
  // Why: with no home to expand against, show the `~` form rather than a wrong absolute path.
  const home = (await getCompanyFolderHome()) || '~'
  const companyFolder = resolveCompanyFolder({
    workRoot: settings?.companyWorkRoot,
    overrides: settings?.companyFolders,
    company: target.company,
    home
  })
  return target.domain ? resolveDomainFolder(companyFolder, target.domain.name) : companyFolder
}

/** Creates the missing folder, but only where the main process allows it. */
export async function createCompanySessionFolder(
  path: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  const api = window.api?.companyWorkspaces
  if (!api) {
    return {
      ok: false,
      message: translate(
        'companyFolders.desktopOnly',
        'Company folders can only be created in the OmniConsole desktop app.'
      )
    }
  }
  const result = await api.ensureFolder({ path })
  return result.ok ? { ok: true } : { ok: false, message: result.message }
}

/**
 * A null company starts at the shared work root. Otherwise the company's folder becomes a project
 * group, the department folder becomes a folder workspace inside it, and the
 * chosen agent launches there through the sidebar's own launch path.
 */
export async function startCompanySession(
  args: {
    expectedAccountScope?: string
    onSessionCreated?: (tabId: string) => void
    sessionContext?: readonly SessionContextAttachment[]
    /** Project items left out of this session, kept with its context. */
    sessionContextRemoved?: readonly string[]
    /** Recorded on the tab this launch creates; Default passes none. */
    agentTemplate?: SessionAgentTemplate
    /** What the launch attaches, kept for Session details. */
    launchManifest?: LaunchManifest
    company: (CompanyFolderIdentity & { name: string }) | null
    domain: { id?: string | null; name: string } | null
    agent: TuiAgent | null
    note: string
    launchEnv?: Record<string, string> | null
    conversationLauncher?: boolean
    launchPreferences?: AgentLaunchPreferences
    viewModePreference?: 'chat' | 'terminal'
    /** How the note reaches a session that opens in an existing tab set (see launchAgentInNewTab). */
    promptDelivery?: LaunchAgentInNewTabArgs['promptDelivery']
  } & Pick<LaunchAgentInNewTabArgs, 'outcome' | 'hubTaskId'>
): Promise<StartCompanySessionResult> {
  const contextScope = selectConsoleAccountScope(useAppStore.getState())
  if (args.expectedAccountScope !== undefined && args.expectedAccountScope !== contextScope) {
    return {
      ok: false,
      reason: 'failed',
      message: translate(
        'companySessions.accountChanged',
        'The signed-in account changed before launch.'
      )
    }
  }
  if (
    args.viewModePreference === 'chat' &&
    !nativeChatEnabledByPreference(useAppStore.getState().settings)
  ) {
    await useAppStore.getState().updateSettingsOrThrow({ experimentalNativeChat: true })
  }
  const prepared = await ensureCompanySessionWorkspace(args)
  if (!prepared.ok) {
    return prepared
  }
  if (
    (args.sessionContext?.length || args.expectedAccountScope !== undefined) &&
    selectConsoleAccountScope(useAppStore.getState()) !== contextScope
  ) {
    throw new Error('The account changed while the session workspace was prepared.')
  }
  const { workspace } = prepared
  const settings = useAppStore.getState().settings
  const onSessionCreated = recordingAgentTemplate(
    args.sessionContext
      ? recordingSessionLaunch(
          sessionContextLaunchBinding(
            args.sessionContext,
            folderWorkspaceKey(workspace.id),
            args.sessionContextRemoved
          ),
          args.launchManifest
        )
      : args.onSessionCreated,
    args.agentTemplate
  )

  if (
    args.conversationLauncher &&
    args.agent === 'omp' &&
    args.launchPreferences?.model?.startsWith('openrouter/')
  ) {
    const { launchCustomModel } = await import('./launch-custom-model')
    const tabId = await launchCustomModel({
      worktreeId: folderWorkspaceKey(workspace.id),
      modelId: args.launchPreferences.model.slice(11),
      viewMode: args.viewModePreference ?? 'terminal',
      prompt: args.note,
      onSessionCreated
    })
    return { ok: true, workspaceId: workspace.id, ...(tabId ? { tabId } : {}) }
  }
  const startupPlan = args.agent
    ? buildAgentStartupPlan({
        agent: args.agent,
        prompt: composeLaunchAgentPrompt({
          prompt: args.note,
          outcome: args.outcome,
          hubTaskId: args.hubTaskId,
          platform: CLIENT_PLATFORM,
          isRemote: false
        }),
        cmdOverrides: settings?.agentCmdOverrides ?? {},
        platform: CLIENT_PLATFORM,
        allowEmptyPromptLaunch: true,
        agentArgs: args.conversationLauncher
          ? conversationLauncherArgs(
              args.agent,
              resolveTuiAgentLaunchArgs(args.agent, settings?.agentDefaultArgs),
              CLIENT_PLATFORM === 'win32' ? 'powershell' : 'posix'
            )
          : resolveTuiAgentLaunchArgs(args.agent, settings?.agentDefaultArgs),
        agentEnv: {
          ...resolveTuiAgentLaunchEnv(args.agent, settings?.agentDefaultEnv),
          ...args.launchEnv
        },
        bypassShellFunctions: Boolean(args.launchEnv && Object.keys(args.launchEnv).length),
        sessionOptions: launchPreferencesToSessionOptions(args.launchPreferences),
        sessionOptionsOverrideAgentArgs:
          Boolean(args.launchPreferences) || args.conversationLauncher === true
      })
    : null
  // Why: an agent whose command cannot be resolved must not read as a started session.
  if (args.agent && !startupPlan) {
    return {
      ok: false,
      reason: 'failed',
      message: translate(
        'companySessions.agentUnavailable',
        'The chosen agent could not be launched here; check its command in Agent settings.'
      )
    }
  }
  const worktreeId = folderWorkspaceKey(workspace.id)
  let previousTabs = useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []
  let seeded = false
  let launchedTabId: string | undefined
  const revealed = await launchFolderWorkspaceAgentSession({
    beforeActivate: () => {
      if (
        args.expectedAccountScope !== undefined &&
        selectConsoleAccountScope(useAppStore.getState()) !== args.expectedAccountScope
      ) {
        throw new Error('The signed-in account changed before launch.')
      }
      previousTabs = useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []
    },
    onLaunched: (_worktreeId, tabId) => {
      seeded = !previousTabs.some((tab) => tab.id === tabId || tab.entityId === tabId)
      launchedTabId = seeded ? tabId : undefined
      if (seeded) {
        onSessionCreated?.(tabId)
      }
    },
    workspace,
    agent: args.agent,
    startupPlan,
    launchSource: 'companies',
    viewModePreference: args.viewModePreference,
    runtimeEnvironmentId: null
  })
  if (!revealed) {
    return {
      ok: false,
      reason: 'failed',
      message: translate(
        'companySessions.revealFailed',
        'The session folder is ready but it could not be opened; open it from the Workspaces tree.'
      )
    }
  }
  if (args.conversationLauncher && args.agent && !seeded) {
    if (
      args.expectedAccountScope !== undefined &&
      selectConsoleAccountScope(useAppStore.getState()) !== args.expectedAccountScope
    ) {
      return {
        ok: false,
        reason: 'failed',
        message: translate(
          'companySessions.accountChanged',
          'The signed-in account changed before launch.'
        )
      }
    }
    const current = useAppStore.getState()
    const launched = launchAgentInNewTab({
      agent: args.agent,
      onSessionCreated,
      worktreeId,
      groupId:
        current.activeGroupIdByWorktree[worktreeId] ??
        current.groupsByWorktree[worktreeId]?.[0]?.id,
      launchSource: 'companies',
      conversationLauncher: true,
      launchEnv: args.launchEnv,
      launchPreferences: args.launchPreferences,
      viewModePreference: args.viewModePreference,
      ...(args.promptDelivery ? { promptDelivery: args.promptDelivery } : {}),
      prompt: args.note,
      outcome: args.outcome,
      hubTaskId: args.hubTaskId
    })
    launchedTabId = launched?.tabId ?? undefined
    if (!launched || (launched.launchCompletion && !(await launched.launchCompletion))) {
      return {
        ok: false,
        reason: 'failed',
        message: translate(
          'conversations.startFailed',
          'Work could not start. Check the connection and try again.'
        )
      }
    }
  }
  return { ok: true, workspaceId: workspace.id, ...(launchedTabId ? { tabId: launchedTabId } : {}) }
}
