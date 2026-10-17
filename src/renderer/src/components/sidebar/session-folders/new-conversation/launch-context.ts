import { create } from 'zustand'
import { getSessionContext, launchSessionContextKey } from '@/lib/session-context-store'
import { readLaunchSessionContext } from '@/lib/launch-session-context'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { nativeChatEnabledByPreference } from '../../../../../../shared/native-chat-preference'
import {
  AGENT_TEMPLATE_DEFAULT_ID,
  agentTemplateDigest,
  findAgentTemplate,
  resolveAgentTemplates,
  type AgentTemplate
} from '../../../../../../shared/agent-templates'
import {
  LOCAL_OLLAMA_MEMORY_ROOT_KEY,
  mergeLaunchContextEntry,
  type LaunchContextPatch
} from '../../../../../../shared/local-ollama-launch'
import type { LaunchPick } from './resolve-launch-plan'
import { resolveLaunchProject, useLaunchProject } from '@/lib/project-launch'
import { projectLaunchManifest } from '../../../../../../shared/project-launch-inheritance'
import {
  dedupeLaunchAttachments,
  emptyLaunchManifest,
  launchManifestPrompt,
  sentLaunchAttachments,
  type LaunchManifest
} from '../../../../../../shared/launch-manifest'
import type { LaunchTarget } from './LaunchTargetColumn'

/**
 * A palette drop waiting for its launcher. It carries its own target, captured when it was
 * requested, so no other launch settling (and resetting the shared target) can move it. `folderId`
 * names the folder whose own "+" starts and files it; without one the toolbar "+" starts it.
 */
export type PendingLaunch = {
  id: number
  pick: LaunchPick
  folderId?: string
  target: LaunchTarget | undefined
}

let nextPendingLaunchId = 1

/**
 * The launcher's shared context: where the next conversation starts and which agent
 * template opens it. Both apply to every provider row. The target override lives only
 * for the open window (the sidebar selection is the default); the template choice is
 * remembered per target in settings.
 */
export const useLaunchContext = create<{
  /** `undefined` follows the sidebar; otherwise an explicit pick from the target column. */
  target: LaunchTarget | undefined
  setTarget: (target: LaunchTarget | undefined) => void
  pendingLaunch: PendingLaunch | undefined
  /**
   * Queues a palette drop; `target`, when given, also becomes the shared target in the same
   * update. One drop waits at a time: a second is refused with a message, never swapped in.
   */
  requestLaunch: (pick: LaunchPick, folderId?: string, target?: LaunchTarget) => boolean
  /** Removes the pending drop, only if it is still the one with this id. */
  takePendingLaunch: (id: number) => void
  /** Clears the shared target only while it is still the one this toolbar drop set or saw. */
  releaseLaunchTarget: (launch: PendingLaunch) => void
  /** The template Settings › Agents should open on, set by "Edit instructions…"; each request remounts the editor. */
  editTemplate: { id: string; nonce: number } | undefined
  requestEditTemplate: (id: string | undefined) => void
}>()((set, get) => ({
  pendingLaunch: undefined,
  requestLaunch: (pick, folderId, target) => {
    if (get().pendingLaunch) {
      toast.info(
        translate(
          'launcherPalette.alreadyStarting',
          'Launch already starting. Drop again once it has opened.'
        )
      )
      return false
    }
    const launchTarget = target ?? get().target
    set({
      target: launchTarget,
      pendingLaunch: { id: nextPendingLaunchId++, pick, folderId, target: launchTarget }
    })
    return true
  },
  takePendingLaunch: (id) => {
    if (get().pendingLaunch?.id === id) {
      set({ pendingLaunch: undefined })
    }
  },
  releaseLaunchTarget: (launch) => {
    // Why: a folder drop only borrowed the current target; only a toolbar drop owns it.
    if (!launch.folderId && launch.target !== undefined && get().target === launch.target) {
      set({ target: undefined })
    }
  },
  target: undefined,
  setTarget: (target) => set({ target }),
  editTemplate: undefined,
  requestEditTemplate: (id) =>
    set({ editTemplate: id ? { id, nonce: (get().editTemplate?.nonce ?? 0) + 1 } : undefined })
}))

/** Chat when native chat is on and chosen as the default; otherwise the terminal. */
export function launcherViewModePreference(
  settings: GlobalSettings | null | undefined
): 'chat' | 'terminal' {
  return nativeChatEnabledByPreference(settings) && settings?.openAgentTabsInChatByDefault
    ? 'chat'
    : 'terminal'
}

export function launchContextKey(worktreeId: string | null): string {
  return worktreeId ?? LOCAL_OLLAMA_MEMORY_ROOT_KEY
}

export function launchTargetFor(worktreeId: string | null): LaunchTarget {
  return worktreeId ? { kind: 'workspace', worktreeId } : { kind: 'work-root' }
}

export function rememberedTemplate(
  settings: GlobalSettings | null | undefined,
  worktreeId: string | null
): AgentTemplate {
  const templates = resolveAgentTemplates(settings?.agentTemplates)
  return findAgentTemplate(templates, rememberedTemplateId(settings, worktreeId))
}

/** The saved id itself: a project's agent is found by it even when its template is not on this computer. */
export function rememberedTemplateId(
  settings: GlobalSettings | null | undefined,
  worktreeId: string | null
): string {
  return (
    settings?.launchContextMemory?.[launchContextKey(worktreeId)]?.templateId ??
    AGENT_TEMPLATE_DEFAULT_ID
  )
}

let memoryWrites: Promise<unknown> = Promise.resolve()

/**
 * The one way launch memory is written. On the desktop the main process merges the entry
 * on the settings as they are now and broadcasts the result to every window, so no renderer
 * snapshot is involved. The web client (no IPC) serializes whole-map writes instead.
 */
export function rememberLaunchContextEntry(key: string, entry: LaunchContextPatch): Promise<void> {
  const run = async (): Promise<void> => {
    const api = window.api?.localOllama
    const result = api ? await api.rememberLaunchContext({ key, entry }).catch(() => null) : null
    if (result?.ok) {
      // Why: a settings write still awaiting a slow side effect in main would later publish
      // its pre-merge snapshot over the broadcast; a fetch takes a newer fence and wins.
      await useAppStore.getState().fetchSettings()
      return
    }
    const state = useAppStore.getState()
    await state.updateSettingsOrThrow({
      launchContextMemory: mergeLaunchContextEntry(state.settings?.launchContextMemory, key, entry)
    })
  }
  const next = memoryWrites.then(run, run)
  memoryWrites = next.catch(() => undefined)
  return next
}

/** Saves the template for a target, keeping that target's remembered Ollama model. */
export function rememberTemplate(worktreeId: string | null, templateId: string): void {
  void rememberLaunchContextEntry(launchContextKey(worktreeId), { templateId }).catch(
    () => undefined
  )
}

/**
 * Everything a launch from this target would attach: the remembered template (or the project's
 * agent), the project's line, pointer and inherited items, and the target's own launch context.
 * The review panel shows this list and the launch is built only from it (pickFromLaunchManifest).
 */
export function launchManifestFor(
  pick: LaunchPick | undefined,
  worktreeId: string | null,
  /** The rows only render for local launches; elsewhere no template applies. */
  local = true,
  folder: LaunchManifest['folder'] = null,
  /** A template this launch opens with wherever it runs (a project's chat), over the remembered one. */
  templateId?: string
): LaunchManifest {
  const settings = useAppStore.getState().settings
  const template = templateId
    ? findAgentTemplate(resolveAgentTemplates(settings?.agentTemplates), templateId)
    : local
      ? rememberedTemplate(settings, worktreeId)
      : undefined
  const launcherAgent = template
    ? {
        templateId: template.id,
        name: template.name,
        instructions: template.instructions ?? '',
        from: 'launcher' as const
      }
    : null
  const prompt = pick?.opening?.prompt ?? ''
  // Why the saved id: a project agent applies by it even when its template is not on this computer.
  const project = resolveLaunchProject(
    worktreeId,
    templateId ?? (local ? rememberedTemplateId(settings, worktreeId) : null)
  )
  if (project) {
    return withTeamInstructions(
      projectLaunchManifest(project, {
        prompt,
        hostLabel: project.hostLabel,
        // Why: the project's agent carries its own text, so it reaches a host lacking the template.
        ...(project.agent ? {} : { agent: launcherAgent }),
        folder
      }),
      pick
    )
  }
  const attachments = dedupeLaunchAttachments(
    getSessionContext(launchSessionContextKey(worktreeId))
  )
  return withTeamInstructions(
    {
      ...emptyLaunchManifest(prompt),
      agent: launcherAgent,
      attachments,
      sources: Object.fromEntries(attachments.map((item) => [item.id, 'workspace' as const])),
      folder
    },
    pick
  )
}

function withTeamInstructions(manifest: LaunchManifest, pick?: LaunchPick): LaunchManifest {
  return pick?.teamInstructions
    ? {
        ...manifest,
        attachments: [
          ...manifest.attachments,
          {
            id: 'instructions:launch-team',
            kind: 'instructions',
            title: translate('launchReview.teamInstructions', 'Team instructions'),
            content: pick.teamInstructions
          }
        ]
      }
    : manifest
}

/**
 * The launch exactly as the manifest lists it: runners without an agent-config mechanism get the
 * text as the opening message, submitted once the TUI is ready. `removed` names project items the
 * person left out, so the session's context records them as removed rather than forgotten.
 */
export function pickFromLaunchManifest(
  pick: LaunchPick | undefined,
  manifest: LaunchManifest,
  removed: readonly string[] = []
): LaunchPick {
  const { agent } = manifest
  const prompt = launchManifestPrompt(manifest)
  return {
    ...pick,
    team: manifest.attachments.some((item) => item.id === 'instructions:launch-team'),
    templateId: agent?.templateId,
    agentTemplate: agent
      ? {
          id: agent.templateId,
          name: agent.name,
          digest: agent.digest ?? agentTemplateDigest(agent.instructions)
        }
      : undefined,
    sessionContext: sentLaunchAttachments(manifest),
    sessionContextRemoved: removed.length ? [...new Set(removed)] : undefined,
    launchManifest: manifest,
    opening: prompt ? { prompt, promptDelivery: 'submit-after-ready', note: prompt } : undefined
  }
}

/** Project items the person unticked in the launcher's project row, for a manifest in a project. */
export function launchRemovedFor(manifest: LaunchManifest): readonly string[] {
  return manifest.project ? useLaunchProject.getState().removed : []
}

/** The launch with everything its target attaches, unreviewed; the launcher reviews first. */
export function withLaunchTemplate(
  pick: LaunchPick | undefined,
  worktreeId: string | null,
  local = true
): LaunchPick {
  const manifest = launchManifestFor(pick, worktreeId, local)
  return pickFromLaunchManifest(
    { ...pick, launchContextClaim: readLaunchSessionContext(worktreeId).claim },
    manifest,
    launchRemovedFor(manifest)
  )
}

/** Custom-model sessions start through the runtime RPC, which carries no opening message. */
export function warnTemplateNotApplied(
  opening: { prompt: string } | undefined,
  route: 'custom-model' | 'reserved' = 'custom-model'
): void {
  if (!opening) {
    return
  }
  toast.info(
    route === 'reserved'
      ? translate(
          'launchContext.notAppliedToReserved',
          'Agent availability is still loading; this session starts without the agent template.'
        )
      : translate(
          'launchContext.notAppliedToCustomModel',
          'Agent templates are not applied to custom-model launches yet; this session starts without one.'
        )
  )
}
