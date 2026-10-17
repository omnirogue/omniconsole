import { prepareConversationReviewPick } from './reviewed-launch-plan'
import type { ConversationLaunchInput } from './conversation-launch-input'
import { recordingAgentTemplate } from '@/lib/session-agent-template-record'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import {
  reserveConversationLaunch,
  verifyConversationLaunch
} from '@/lib/conversation-launch-draft'
import {
  assertCurrentConversationLaunchOwner,
  captureConversationLaunchOwner
} from './conversation-launch-owner'
import { launcherUnavailableMessage } from './launcher-unavailable-message'
import { announceLaunchAccount } from './launch-account-notice'
import { launcherViewModePreference } from './launch-context'
import { sessionContextLaunchBinding } from '@/lib/session-context-store'
import { recordingSessionLaunch } from '@/lib/session-launch-record'
import { consumeLaunchSessionContext } from '@/lib/launch-session-context'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { startCompanySession, createCompanySessionFolder } from '@/lib/start-company-session'
import {
  resolveLaunchPlan,
  teamLaunchOpening,
  type LaunchPick,
  type LauncherCapability
} from './resolve-launch-plan'
import {
  openLauncherAccounts,
  rememberLauncherCompany,
  type LauncherCompany
} from './launcher-target'

export function useConversationLaunch(input: ConversationLaunchInput) {
  const pendingPick = useRef<LaunchPick>({})
  const latest = useRef(input)
  // Why: an async launch that resolves later reads the rows of the last committed render.
  useLayoutEffect(() => {
    latest.current = input
  })
  useEffect(() => {
    if (input.open === false) {
      pendingPick.current = {}
    }
  }, [input.open])
  const busy = useRef(false)
  const [starting, setStarting] = useState(false)
  const [launchError, setLaunchError] = useState('')
  const launch = async (
    requestedPick?: LaunchPick,
    selectedCompany?: LauncherCompany
  ): Promise<void> => {
    const pick = requestedPick ?? (selectedCompany ? pendingPick.current : {})
    const company = selectedCompany ?? (input.defaultToWorkRoot ? undefined : input.company)
    const state = useAppStore.getState()
    const scopeIsCurrent = captureConversationLaunchOwner(input, () => latest.current)
    assertCurrentConversationLaunchOwner(scopeIsCurrent)
    const contextBinding = recordingSessionLaunch(
      sessionContextLaunchBinding(
        pick.sessionContext ?? [],
        input.worktreeId,
        pick.sessionContextRemoved
      ),
      pick.launchManifest
    )
    const contextCreated = recordingAgentTemplate(contextBinding, pick.agentTemplate)
    // Why only once started: a failed or cancelled launch leaves the launcher's context in place.
    const started = () => consumeLaunchSessionContext(pick.launchContextClaim)
    // Why current settings and rows: a delayed check resolves after the launcher changed.
    const resolveCheckedPlan = (capabilities: LauncherCapability[]) => {
      const { settings } = useAppStore.getState()
      return resolveLaunchPlan({
        hasTarget: true,
        local: input.local,
        accountEnvironmentId: input.accountEnvironmentId,
        capabilities,
        rows: latest.current.rows,
        pick,
        defaultProvider: settings?.defaultTuiAgent,
        defaults: settings?.conversationLaunchDefaults
      })
    }
    if (
      (pick.customModelId !== undefined ||
        pick.agent === 'omp' ||
        (!pick.agent && state.settings?.defaultTuiAgent === 'omp')) &&
      (input.worktreeId || company || input.defaultToWorkRoot) &&
      input.refreshCapabilities
    ) {
      await input.refreshCapabilities()
      assertCurrentConversationLaunchOwner(scopeIsCurrent)
    }
    let plan = resolveLaunchPlan({
      hasTarget: Boolean(input.worktreeId || company || input.defaultToWorkRoot),
      local: input.local,
      accountEnvironmentId: input.accountEnvironmentId,
      capabilities: input.readCapabilities(),
      rows: input.rows,
      pick,
      defaultProvider: state.settings?.defaultTuiAgent,
      defaults: state.settings?.conversationLaunchDefaults
    })
    if (plan.kind === 'target-required') {
      pendingPick.current = pick
      input.setOpen(true)
      return
    }
    if (plan.kind === 'model-unavailable') {
      throw new Error(plan.message)
    }
    if (plan.kind === 'provider-unavailable') {
      if (input.loading && input.worktreeId && input.refreshCapabilities) {
        input.setOpen(false)
        const worktreeId = input.worktreeId
        useSessionSidebarView.getState().setCollapsed(['waiting'], false)
        await new Promise<void>((resolve) => {
          const reservedTabId = reserveConversationLaunch({
            onSettled: resolve,
            onStarted: started,
            worktreeId,
            groupId:
              state.activeGroupIdByWorktree[worktreeId] ??
              state.groupsByWorktree[worktreeId]?.[0]?.id,
            viewModePreference:
              input.viewModePreference ?? launcherViewModePreference(state.settings),
            scopeIsCurrent,
            verify: async () => {
              const capabilities = await input.refreshCapabilities!()
              assertCurrentConversationLaunchOwner(scopeIsCurrent)
              const verified = resolveCheckedPlan(capabilities)
              if (verified.kind !== 'launch') {
                throw new Error(launcherUnavailableMessage(capabilities))
              }
              return {
                ...pick.opening,
                onSessionCreated: contextCreated,
                agent: verified.agent,
                ...teamLaunchOpening(verified.teamPrompt),
                launchEnv: verified.launchEnv,
                launchPreferences: verified.launchPreferences,
                conversationLauncher: true
              }
            }
          })
          input.onLaunched?.(reservedTabId)
        })
        return
      }
      if (input.loading && (company || input.defaultToWorkRoot) && input.refreshCapabilities) {
        const capabilities = await verifyConversationLaunch(
          input.refreshCapabilities,
          translate(
            'conversations.startFailed',
            'Work could not start. Check the connection and try again.'
          )
        )
        assertCurrentConversationLaunchOwner(scopeIsCurrent)
        plan = resolveCheckedPlan(capabilities)
        if (plan.kind === 'provider-unavailable') {
          toast.error(launcherUnavailableMessage(capabilities))
          return
        }
      } else {
        toast.error(launcherUnavailableMessage(input.readCapabilities(), input.loading))
        return
      }
    }
    if (plan.kind === 'sign-in-required') {
      toast.error(translate('conversationLauncher.noAccount', 'No account is ready to launch.'), {
        action: {
          label: translate('conversationLauncher.signIn', 'Sign in'),
          onClick: openLauncherAccounts
        }
      })
      return
    }
    if (plan.kind !== 'launch') {
      return
    }
    pendingPick.current = {}
    input.setOpen(false)
    const args = {
      ...pick.opening,
      onSessionCreated: contextCreated,
      sessionContext: pick.sessionContext,
      sessionContextRemoved: pick.sessionContextRemoved,
      agent: plan.agent,
      ...teamLaunchOpening(plan.teamPrompt),
      launchEnv: plan.launchEnv,
      launchPreferences: plan.launchPreferences,
      viewModePreference: input.viewModePreference ?? launcherViewModePreference(state.settings),
      conversationLauncher: true
    }
    if (input.worktreeId) {
      const worktreeId = input.worktreeId
      if (plan.agent === 'omp' && plan.launchPreferences?.model?.startsWith('openrouter/')) {
        const { launchCustomModel } = await import('@/lib/launch-custom-model')
        const tabId = await launchCustomModel({
          worktreeId,
          modelId: plan.launchPreferences.model.slice(11),
          viewMode: args.viewModePreference,
          prompt: pick.opening?.prompt,
          onSessionCreated: contextCreated
        })
        started()
        if (tabId) {
          input.onLaunched?.(tabId)
        }
        return
      }
      const result = launchAgentInNewTab({
        ...args,
        worktreeId,
        launchSource: 'sidebar',
        groupId:
          state.activeGroupIdByWorktree[worktreeId] ?? state.groupsByWorktree[worktreeId]?.[0]?.id
      })
      if (result?.tabId) {
        input.onLaunched?.(result.tabId)
      }
      if (!result || (result.launchCompletion && !(await result.launchCompletion))) {
        throw new Error(
          translate(
            'conversations.startFailed',
            'Work could not start. Check the connection and try again.'
          )
        )
      }
      started()
      // Why: launching a conversation from the sidebar "+" must land the user on
      // it, the same as clicking its sidebar row would — otherwise the tab
      activateAndRevealWorkspace(worktreeId, { providesInitialSurface: true })
      if (result.tabId) {
        activateTabAndFocusPane(result.tabId, null, { flashFocusedPane: true })
      }
    } else if (company || input.defaultToWorkRoot) {
      // Why the raw binding: the company path may replace it, then adds the template itself.
      const companyArgs = {
        note: '',
        ...args,
        onSessionCreated: contextBinding,
        agentTemplate: pick.agentTemplate,
        launchManifest: pick.launchManifest,
        company: company ?? null,
        domain: null
      }
      let result = await startCompanySession(companyArgs)
      if (!result.ok && result.reason === 'folder-missing') {
        const created = await createCompanySessionFolder(result.path)
        if (!created.ok) {
          throw new Error(created.message)
        }
        result = await startCompanySession(companyArgs)
      }
      if (!result.ok) {
        throw new Error(
          result.reason === 'failed'
            ? result.message
            : translate(
                'conversationLauncher.companyFailed',
                'Could not prepare this company for work.'
              )
        )
      }
      started()
      if (result.tabId) {
        input.onLaunched?.(result.tabId)
      }
      if (company) {
        rememberLauncherCompany(input.scope, company)
      }
    }
    announceLaunchAccount(plan)
  }
  const start = async (pick?: LaunchPick, company?: LauncherCompany): Promise<void> => {
    if (busy.current) {
      return
    }
    busy.current = true
    setStarting(true)
    setLaunchError('')
    try {
      await launch(pick, company)
    } catch (error) {
      setLaunchError(error instanceof Error ? error.message : String(error))
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      // Keep the same guard through reservation, completion and a second pointer click.
      await new Promise<void>((resolve) => setTimeout(resolve, 300))
      busy.current = false
      setStarting(false)
    }
  }
  return {
    start,
    starting,
    launchError,
    prepareReviewPick: (pick?: LaunchPick) => prepareConversationReviewPick(input, pick),
    captureOwner: () => captureConversationLaunchOwner(input, () => latest.current)
  }
}
