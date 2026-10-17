import { recordingAgentTemplate } from '@/lib/session-agent-template-record'
import { sessionAgentTemplateFor } from '../../../../../../../shared/session-agent-template'
import { toast } from 'sonner'
import { sessionContextLaunchBinding } from '@/lib/session-context-store'
import { recordingSessionLaunch } from '@/lib/session-launch-record'
import { consumeLaunchSessionContext, readLaunchSessionContext } from '@/lib/launch-session-context'
import { sessionContextText } from '../../../../../../../shared/session-context-attachments'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { createCompanySessionFolder, startCompanySession } from '@/lib/start-company-session'
import { resolveTuiAgentLaunchArgs } from '../../../../../../../shared/tui-agent-launch-defaults'
import {
  AGENT_TEMPLATE_DEFAULT_ID,
  agentTemplateDigest,
  findAgentTemplate,
  resolveAgentTemplates
} from '../../../../../../../shared/agent-templates'
import { openCodeOllamaModelId } from '../../../../../../../shared/local-ollama-launch'
import {
  launchManifestPrompt,
  sentLaunchAttachments,
  type LaunchManifest
} from '../../../../../../../shared/launch-manifest'

import type { LaunchTarget } from '../LaunchTargetColumn'
import { launchContextKey, rememberLaunchContextEntry } from '../launch-context'

export type LocalOllamaLaunchTarget = LaunchTarget

/**
 * Starts OpenCode on a local Ollama model with an optional agent template, in a
 * workspace or the Work root. Remembers the pick for that target first, so a launch
 * that fails half-way still leaves the row showing what was chosen. The launcher's
 * one-shot session context is cleared only once the session has started.
 */
export async function launchLocalOllama(args: {
  templateId: string
  model: string
  target: LocalOllamaLaunchTarget
  onLaunched?: (tabId: string) => void
  /** The list the review panel showed (a project's chat): the launch sends exactly that. */
  reviewed?: { manifest: LaunchManifest; removed: readonly string[] }
}): Promise<boolean> {
  const api = window.api?.localOllama
  if (!api) {
    toast.error(
      translate(
        'localOllama.desktopOnly',
        'Local Ollama sessions can only start from the OmniConsole desktop app.'
      )
    )
    return false
  }
  const state = useAppStore.getState()
  const settings = state.settings
  const templates = resolveAgentTemplates(settings?.agentTemplates)
  const template = findAgentTemplate(templates, args.templateId)
  const reviewed = args.reviewed
  const reviewedAgent = reviewed?.manifest.agent
  const agentTemplate = reviewed
    ? reviewedAgent
      ? {
          id: reviewedAgent.templateId,
          name: reviewedAgent.name,
          digest: agentTemplateDigest(reviewedAgent.instructions)
        }
      : undefined
    : sessionAgentTemplateFor(template)
  let prepared: Awaited<ReturnType<typeof api.prepareLaunch>>
  try {
    // Why: reviewed instructions can be edited or removed; only the reviewed prompt carries them.
    prepared = await api.prepareLaunch({
      model: args.model,
      templateId: reviewed ? AGENT_TEMPLATE_DEFAULT_ID : template.id
    })
  } catch (error) {
    prepared = { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
  if (!prepared.ok) {
    toast.error(translate('localOllama.prepareFailed', 'Could not prepare the OpenCode launch.'), {
      description: prepared.message
    })
    return false
  }
  void rememberLaunchContextEntry(
    launchContextKey(args.target.kind === 'workspace' ? args.target.worktreeId : null),
    { templateId: template.id, ollamaModel: args.model }
  ).catch(() => undefined)
  const launchPreferences = { model: openCodeOllamaModelId(args.model) }
  const worktreeId = args.target.kind === 'workspace' ? args.target.worktreeId : null
  const { items: launcherContext, claim } = readLaunchSessionContext(worktreeId)
  const context = reviewed ? sentLaunchAttachments(reviewed.manifest) : launcherContext
  const removed = reviewed?.removed ?? []
  const prompt = reviewed ? launchManifestPrompt(reviewed.manifest) : sessionContextText(context)
  const bindContext = recordingSessionLaunch(
    sessionContextLaunchBinding(context, worktreeId, removed),
    reviewed?.manifest
  )
  try {
    if (args.target.kind === 'workspace') {
      const worktreeId = args.target.worktreeId
      const result = launchAgentInNewTab({
        agent: 'opencode',
        onSessionCreated: recordingAgentTemplate(bindContext, agentTemplate),
        ...(prompt ? { prompt, promptDelivery: 'submit-after-ready' as const } : {}),
        worktreeId,
        groupId:
          state.activeGroupIdByWorktree[worktreeId] ?? state.groupsByWorktree[worktreeId]?.[0]?.id,
        launchSource: 'sidebar',
        conversationLauncher: true,
        agentArgs: resolveTuiAgentLaunchArgs('opencode', settings?.agentDefaultArgs),
        launchEnv: prepared.env,
        launchPreferences,
        // Why: the ACP chat path drops argv, and with it the model and agent.
        viewModePreference: 'terminal'
      })
      if (result?.tabId) {
        args.onLaunched?.(result.tabId)
      }
      if (!result || (result.launchCompletion && !(await result.launchCompletion))) {
        throw new Error(
          translate(
            'conversations.startFailed',
            'Work could not start. Check the connection and try again.'
          )
        )
      }
      consumeLaunchSessionContext(claim)
      activateAndRevealWorkspace(worktreeId, { providesInitialSurface: true })
      if (result.tabId) {
        activateTabAndFocusPane(result.tabId, null, { flashFocusedPane: true })
      }
      return true
    }
    const companyArgs = {
      company: null,
      domain: null,
      agent: 'opencode' as const,
      note: prompt,
      sessionContext: context,
      ...(removed.length ? { sessionContextRemoved: removed } : {}),
      ...(reviewed ? { launchManifest: reviewed.manifest } : {}),
      agentTemplate,
      promptDelivery: 'submit-after-ready' as const,
      launchEnv: prepared.env,
      conversationLauncher: true,
      launchPreferences,
      viewModePreference: 'terminal' as const
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
    consumeLaunchSessionContext(claim)
    if (result.tabId) {
      args.onLaunched?.(result.tabId)
    }
    return true
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error))
    return false
  }
}
