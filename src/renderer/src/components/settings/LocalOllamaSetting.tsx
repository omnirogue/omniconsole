import { useMemo, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { resolveAgentTemplates, findAgentTemplate } from '../../../../shared/agent-templates'
import {
  formatModelSize,
  isOllamaModelTag,
  normalizeLaunchContextMemory,
  LOCAL_OLLAMA_MEMORY_ROOT_KEY
} from '../../../../shared/local-ollama-launch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettingsSubsectionHeader } from './SettingsFormControls'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { useLocalOllamaInventory } from '../sidebar/session-folders/new-conversation/local-ollama/use-local-ollama-inventory'
import { rememberLaunchContextEntry } from '../sidebar/session-folders/new-conversation/launch-context'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'

const EMPTY_LIST: never[] = []
const EMPTY_MAP: Record<string, never[]> = {}

type Props = {
  settings: GlobalSettings
}

/** The local model server the Local Ollama route uses: connection, models, pulls, remembered picks. */
export function LocalOllamaSetting({ settings }: Props): React.JSX.Element {
  const inventory = useLocalOllamaInventory(true)
  const [pullName, setPullName] = useState('')
  const memory = useMemo(
    () => normalizeLaunchContextMemory(settings.launchContextMemory),
    [settings.launchContextMemory]
  )
  const templates = useMemo(
    () => resolveAgentTemplates(settings.agentTemplates),
    [settings.agentTemplates]
  )
  const repos = useAppStore((state) => state.repos ?? EMPTY_LIST)
  const worktreesByRepo = useAppStore((state) => state.worktreesByRepo ?? EMPTY_MAP)
  const folderWorkspaces = useAppStore((state) => state.folderWorkspaces ?? EMPTY_LIST)
  const nameFor = (key: string): string => {
    if (key === LOCAL_OLLAMA_MEMORY_ROOT_KEY) {
      return translate('localOllama.target.workRoot', 'Work root')
    }
    for (const repo of repos) {
      const worktree = (worktreesByRepo[repo.id] ?? []).find((entry) => entry.id === key)
      if (worktree) {
        return `${repo.displayName} · ${worktree.displayName}`
      }
    }
    const folder = folderWorkspaces.find((entry) => folderWorkspaceKey(entry.id) === key)
    return folder
      ? folder.name
      : translate('components.settings.localOllama.removedWorkspace', 'Removed workspace')
  }
  const forget = (key: string): void => {
    // Why: through the serialized writer, so a launcher pick saved meanwhile survives.
    void rememberLaunchContextEntry(key, null).catch((error: unknown) =>
      toast.error(
        translate('components.settings.localOllama.forgetFailed', 'Could not forget it.'),
        {
          description: error instanceof Error ? error.message : String(error)
        }
      )
    )
  }
  const current = inventory.inventory
  const connected = current?.status === 'connected'
  const rowClass =
    'flex items-center gap-3 border-t border-border px-3 py-2 text-[13px] first:border-t-0'

  return (
    <section id="local-ollama" data-settings-section="local-ollama" className="space-y-4">
      <SettingsSubsectionHeader
        title={translate('components.settings.localOllama.title', 'Local Ollama')}
        description={translate(
          'components.settings.localOllama.descriptionModelContext',
          'The Local Ollama launcher uses the model’s reported context limit. Configure Ollama with enough context for your prompts and connected tools, within the model’s supported limit.'
        )}
        action={
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={inventory.checking}
            onClick={() => void inventory.refresh()}
          >
            {inventory.checking ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {translate('conversations.refreshAgents', 'Refresh')}
          </Button>
        }
      />
      <div className="rounded-lg border border-border">
        <div className={rowClass}>
          <span
            className={cn(
              'size-2 shrink-0 rounded-full',
              connected ? 'bg-status-success' : current ? 'bg-destructive' : 'bg-muted-foreground'
            )}
          />
          <div className="min-w-0 flex-1">
            <div>
              {!current
                ? translate('localOllama.checking', 'Checking Ollama…')
                : connected
                  ? translate('components.settings.localOllama.connected', 'Connected')
                  : translate('localOllama.notRunning', 'Cannot reach Ollama')}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {current?.baseUrl ?? ''}
              {connected
                ? ` · ${translate('components.settings.localOllama.installedCount', 'Installed: {{count}}', { count: current.models.length })}`
                : current?.status === 'disconnected'
                  ? ` · ${current.message}`
                  : ''}
            </div>
          </div>
        </div>
        {connected
          ? current.models.map((model) => (
              <div key={model.name} className={rowClass}>
                <div className="min-w-0 flex-1">
                  <div className="truncate">{model.name}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {[
                      model.parameterSize,
                      model.family,
                      model.quantization,
                      formatModelSize(model.sizeBytes)
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </div>
              </div>
            ))
          : null}
        {Object.values(inventory.pulls).map((progress) => (
          <div key={progress.model} className={rowClass}>
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            <div className="min-w-0 flex-1 truncate">
              {progress.model} · {progress.status}
              {progress.totalBytes && progress.completedBytes
                ? ` ${Math.floor((progress.completedBytes / progress.totalBytes) * 100)}%`
                : ''}
            </div>
          </div>
        ))}
        <div className={rowClass}>
          <Input
            aria-label={translate('localOllama.pullByName', 'Pull a model by name')}
            placeholder={translate('localOllama.pullPlaceholder', 'Pull by name, e.g. mistral:7b')}
            value={pullName}
            disabled={!connected}
            onChange={(event) => setPullName(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                connected &&
                isOllamaModelTag(pullName.trim()) &&
                !inventory.pulls[pullName.trim()]
              ) {
                event.preventDefault()
                const name = pullName.trim()
                setPullName('')
                void inventory.pull(name)
              }
            }}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={
              !connected ||
              !isOllamaModelTag(pullName.trim()) ||
              Boolean(inventory.pulls[pullName.trim()])
            }
            onClick={() => {
              const name = pullName.trim()
              setPullName('')
              void inventory.pull(name)
            }}
          >
            {translate('components.settings.localOllama.pull', 'Pull')}
          </Button>
        </div>
      </div>
      <SettingsSubsectionHeader
        title={translate(
          'components.settings.localOllama.rememberedTitle',
          'Remembered per workspace'
        )}
        description={translate(
          'components.settings.localOllama.rememberedDescription',
          'The agent every provider starts with here, and the model the Local Ollama row uses. Any pick in the launcher updates it.'
        )}
      />
      <div className="rounded-lg border border-border">
        {Object.entries(memory).length ? (
          Object.entries(memory).map(([key, entry]) => (
            <div key={key} className={rowClass}>
              <div className="min-w-0 flex-1">
                <div className="truncate">{nameFor(key)}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {findAgentTemplate(templates, entry.templateId).name}
                  {entry.ollamaModel ? ` · ${entry.ollamaModel}` : ''}
                </div>
              </div>
              <Button type="button" size="xs" variant="ghost" onClick={() => forget(key)}>
                {translate('components.settings.localOllama.forget', 'Forget')}
              </Button>
            </div>
          ))
        ) : (
          <div className={`${rowClass} text-muted-foreground`}>
            {translate(
              'components.settings.localOllama.nothingRemembered',
              'Nothing remembered yet.'
            )}
          </div>
        )}
      </div>
    </section>
  )
}
