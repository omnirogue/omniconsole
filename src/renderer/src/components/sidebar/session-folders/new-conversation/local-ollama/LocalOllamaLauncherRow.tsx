import { useMemo } from 'react'
import { Cpu } from 'lucide-react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { Badge } from '@/components/ui/badge'
import { useAppStore } from '@/store'
import type { HoverOpenContentProps } from '@/components/next-step/use-hover-open-popover'
import { resolveAgentTemplates } from '../../../../../../../shared/agent-templates'
import { resolveLocalOllamaPick } from '../../../../../../../shared/local-ollama-launch'
import { LauncherMenuRow } from '../LauncherMenuRow'
import type { LauncherCapability } from '../resolve-launch-plan'
import { launchContextKey, rememberedTemplate, rememberLaunchContextEntry } from '../launch-context'
import { useLocalOllamaInventory } from './use-local-ollama-inventory'
import { reviewedLocalOllamaLaunch } from './reviewed-local-ollama-launch'
import { LocalOllamaModelColumn } from './LocalOllamaModelColumn'
import { isLocalLaunchTarget } from '../LaunchTargetColumn'

/**
 * The Local Ollama row of the Model menu: click starts OpenCode on the model this target
 * used last, with the agent template chosen in the rows above; the submenu lists the
 * installed models and pulls more.
 */
export function LocalOllamaLauncherRow({
  hover,
  enabled,
  runner,
  launchWorktreeId,
  onClose,
  onLaunched
}: {
  hover: HoverOpenContentProps
  /** Desktop only: the browser client cannot reach a local model server. */
  enabled: boolean
  /** OpenCode's detected capability for this target; the row launches only when it is usable. */
  runner?: LauncherCapability
  launchWorktreeId: string | null
  onClose: () => void
  onLaunched?: (tabId: string) => void
}): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  const inventory = useLocalOllamaInventory(enabled)
  const template = rememberedTemplate(settings, launchWorktreeId)
  const templates = useMemo(
    () => resolveAgentTemplates(settings?.agentTemplates),
    [settings?.agentTemplates]
  )
  const installedTags = useMemo(
    () =>
      inventory.inventory?.status === 'connected'
        ? inventory.inventory.models.map((model) => model.name)
        : [],
    [inventory.inventory]
  )
  const memoryKey = launchContextKey(launchWorktreeId)
  const pick = resolveLocalOllamaPick({
    memory: settings?.launchContextMemory,
    workspaceKey: memoryKey,
    templates,
    installedTags,
    templateId: template.id
  })
  const connected = inventory.inventory?.status === 'connected'
  const runnerUsable = runner?.status === 'usable'
  // Why: the sidebar can select a WSL-run repo that the resolver calls local; no Ollama row there.
  if (!enabled || !isLocalLaunchTarget(launchWorktreeId)) {
    return null
  }
  // Why: sibling provider rows vanish for a missing or disabled CLI; only a transient state gets a row.
  if (!runner || runner.status === 'cli-missing' || runner.status === 'disabled') {
    return null
  }
  if (!runnerUsable) {
    return (
      <LauncherMenuRow hover={hover} disabled onLaunch={() => undefined}>
        <div className="flex items-center gap-2">
          <Cpu className="size-4" />
          {translate('localOllama.title', 'Local Ollama')}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {runner.status === 'work-plan-required'
            ? translate(
                'localOllama.runnerWorkPlan',
                'This task needs a work plan before OpenCode can start'
              )
            : runner.status === 'unverified'
              ? translate('localOllama.runnerChecking', 'Checking whether OpenCode can run here…')
              : translate('localOllama.runnerUnavailable', 'OpenCode cannot start here')}
        </div>
      </LauncherMenuRow>
    )
  }
  const launch = (model: string | null, installed: boolean): void => {
    if (!connected) {
      toast.error(translate('localOllama.notRunning', 'Cannot reach Ollama'))
      return
    }
    if (!model || !installed) {
      toast.error(translate('localOllama.pickInstalled', 'Pick an installed model first.'))
      return
    }
    onClose()
    reviewedLocalOllamaLaunch({
      worktreeId: launchWorktreeId,
      folder: null,
      templateId: template.id,
      tag: model,
      onLaunched
    })
  }
  const remember = (model: string): void => {
    // Why: only the model; the template saved a moment ago must not be overwritten by this render's.
    void rememberLaunchContextEntry(memoryKey, { ollamaModel: model }).catch(() => undefined)
  }
  const subtitle = !inventory.inventory
    ? translate('localOllama.checking', 'Checking Ollama…')
    : !connected
      ? translate('localOllama.notRunning', 'Cannot reach Ollama')
      : pick.model
        ? `${pick.model}${pick.installed ? '' : ` · ${translate('localOllama.notInstalled', 'Not installed')}`}`
        : translate('localOllama.noneInstalled', 'No models installed yet. Pull one below.')

  return (
    <LauncherMenuRow
      hover={hover}
      onLaunch={() => launch(pick.model, pick.installed)}
      submenu={
        <LocalOllamaModelColumn
          template={template}
          pick={pick}
          inventory={inventory}
          hover={hover}
          onLaunch={(model) => launch(model, true)}
          onRemember={remember}
        />
      }
    >
      <div className="flex items-center gap-2">
        <Cpu className="size-4" />
        {translate('localOllama.title', 'Local Ollama')}
        <Badge variant="secondary">{translate('localOllama.runnerBadge', 'OpenCode')}</Badge>
      </div>
      <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
    </LauncherMenuRow>
  )
}
