import { useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Input } from '@/components/ui/input'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import type { HoverOpenContentProps } from '@/components/next-step/use-hover-open-popover'
import type { AgentTemplate } from '../../../../../../../shared/agent-templates'
import {
  formatModelSize,
  isOllamaModelTag,
  type LocalOllamaPick
} from '../../../../../../../shared/local-ollama-launch'
import { LauncherMenuRow } from '../LauncherMenuRow'
import type { LocalOllamaInventoryState } from './use-local-ollama-inventory'

function pullPercent(progress: { completedBytes?: number; totalBytes?: number }): string {
  if (!progress.totalBytes || !progress.completedBytes) {
    return ''
  }
  return ` ${Math.floor((progress.completedBytes / progress.totalBytes) * 100)}%`
}

/** Installed Ollama models for one template, plus a way back when one is missing. */
export function LocalOllamaModelColumn({
  template,
  pick,
  inventory,
  hover,
  onLaunch,
  onRemember
}: {
  template: AgentTemplate
  pick: LocalOllamaPick
  inventory: LocalOllamaInventoryState
  hover: HoverOpenContentProps
  onLaunch: (model: string) => void
  onRemember: (model: string) => void
}): React.JSX.Element {
  const [pullName, setPullName] = useState('')
  const current = inventory.inventory
  if (!current || current.status !== 'connected') {
    return (
      <>
        <DropdownMenuLabel>
          {inventory.checking || !current
            ? translate('localOllama.checking', 'Checking Ollama…')
            : translate('localOllama.notRunning', 'Cannot reach Ollama')}
        </DropdownMenuLabel>
        {current && current.status === 'disconnected' ? (
          <p className="px-2 pb-1 text-[11px] leading-4 whitespace-normal text-muted-foreground">
            {translate(
              'localOllama.notRunningHint',
              'Start the Ollama app or run `ollama serve`, then retry. {{baseUrl}}: {{message}}',
              { baseUrl: current.baseUrl, message: current.message }
            )}
          </p>
        ) : null}
        <DropdownMenuItem
          disabled={inventory.checking}
          onSelect={(event) => {
            event.preventDefault()
            void inventory.refresh()
          }}
        >
          {inventory.checking ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          {translate('localOllama.retry', 'Retry')}
        </DropdownMenuItem>
      </>
    )
  }
  const installed = current.models
  const missingRemembered =
    pick.model && !pick.installed && pick.modelSource === 'remembered' ? pick.model : null
  const pulling = inventory.pulls
  return (
    <>
      <DropdownMenuLabel>
        {translate('localOllama.modelFor', 'Model · {{template}}', { template: template.name })}
      </DropdownMenuLabel>
      {installed.map((model) => {
        const selected = model.name === pick.model
        const why =
          selected && pick.modelSource === 'remembered'
            ? translate('localOllama.lastUsed', 'Last used')
            : selected && pick.modelSource === 'template'
              ? translate('localOllama.preferred', 'Preferred')
              : selected
                ? translate('conversationLauncher.default', 'Default')
                : undefined
        return (
          <LauncherMenuRow
            key={model.name}
            hover={hover}
            isDefault={selected}
            defaultLabel={why}
            onDefault={() => onRemember(model.name)}
            onLaunch={() => onLaunch(model.name)}
          >
            <div className="truncate">{model.name}</div>
            <div className="truncate text-xs text-muted-foreground">
              {[model.parameterSize, model.family, formatModelSize(model.sizeBytes)]
                .filter(Boolean)
                .join(' · ')}
            </div>
          </LauncherMenuRow>
        )
      })}
      {!installed.length ? (
        <p className="px-2 py-1 text-xs text-muted-foreground">
          {translate('localOllama.noneInstalled', 'No models installed yet. Pull one below.')}
        </p>
      ) : null}
      {missingRemembered ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>
            {translate('localOllama.notInstalled', 'Not installed')}
          </DropdownMenuLabel>
          <DropdownMenuItem
            disabled={Boolean(pulling[missingRemembered])}
            onSelect={(event) => {
              event.preventDefault()
              void inventory.pull(missingRemembered)
            }}
          >
            {pulling[missingRemembered] ? <Loader2 className="size-3.5 animate-spin" /> : null}
            <div className="min-w-0 flex-1">
              <div className="truncate">{missingRemembered}</div>
              <div className="truncate text-xs text-muted-foreground">
                {pulling[missingRemembered]
                  ? `${pulling[missingRemembered]!.status}${pullPercent(pulling[missingRemembered]!)}`
                  : translate(
                      'localOllama.pullLastUsed',
                      'Last used here · pull it to use it again'
                    )}
              </div>
            </div>
          </DropdownMenuItem>
        </>
      ) : null}
      <DropdownMenuSeparator />
      <div className="px-2 pb-2">
        <Input
          aria-label={translate('localOllama.pullByName', 'Pull a model by name')}
          placeholder={translate('localOllama.pullPlaceholder', 'Pull by name, e.g. mistral:7b')}
          value={pullName}
          onChange={(event) => setPullName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') {
              event.stopPropagation()
            }
            if (event.key === 'Enter') {
              event.preventDefault()
              const name = pullName.trim()
              if (isOllamaModelTag(name) && !pulling[name]) {
                setPullName('')
                void inventory.pull(name)
              }
            }
          }}
        />
      </div>
      {Object.values(pulling)
        .filter((progress) => progress.model !== missingRemembered)
        .map((progress) => (
          <p key={progress.model} className="px-2 pb-1 text-xs text-muted-foreground">
            <Loader2 className="mr-1 inline size-3 animate-spin" />
            {progress.model}: {progress.status}
            {pullPercent(progress)}
          </p>
        ))}
    </>
  )
}
