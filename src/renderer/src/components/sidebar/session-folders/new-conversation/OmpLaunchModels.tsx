import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DropdownMenuItem, DropdownMenuLabel } from '@/components/ui/dropdown-menu'
import { workflowModelClient } from '@/lib/workflow-model-client'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { WorkflowOpenRouterModel } from '../../../../../../shared/workflow-openrouter-models'
import {
  DEFAULT_OMP_OPENROUTER_MODEL,
  openRouterModelFamily
} from '../../../../../../shared/omp-launch-model'
import type { LaunchPick } from './resolve-launch-plan'

export function OmpLaunchModels({
  start,
  starting,
  launchError
}: {
  start: (pick: LaunchPick) => void
  starting?: boolean
  launchError?: string
}): React.JSX.Element {
  const saved = useAppStore((state) => state.settings?.conversationLaunchDefaults?.omp?.model)
  const [selected, setSelected] = useState(
    saved?.startsWith('openrouter/') ? saved.slice(11) : DEFAULT_OMP_OPENROUTER_MODEL
  )
  const [query, setQuery] = useState('')
  const [models, setModels] = useState<WorkflowOpenRouterModel[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    workflowModelClient
      .models()
      .then((result) => {
        if (active) {
          setModels(result.models)
        }
      })
      .catch(() => {
        if (active) {
          setError(translate('ompLauncher.loadError', 'Could not load OpenRouter models.'))
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false)
        }
      })
    return () => {
      active = false
    }
  }, [attempt])
  const groups = new Map<string, WorkflowOpenRouterModel[]>()
  for (const model of models) {
    const family = openRouterModelFamily(model.id)
    if (!`${family} ${model.name} ${model.id}`.toLowerCase().includes(query.toLowerCase().trim())) {
      continue
    }
    const entries = groups.get(family)
    if (entries) {
      entries.push(model)
    } else {
      groups.set(family, [model])
    }
  }
  const chosen = models.find((model) => model.id === selected)
  return (
    <div className="w-80 space-y-2">
      <div className="space-y-2 p-2">
        <Input
          autoFocus
          aria-label={translate('ompLauncher.search', 'Search OpenRouter models or families')}
          placeholder={translate('ompLauncher.search', 'Search OpenRouter models or families')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') {
              event.stopPropagation()
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              event.currentTarget
                .closest('[role="menu"]')
                ?.querySelector<HTMLElement>('[role="menuitem"]:not([data-disabled])')
                ?.focus()
            }
          }}
        />
        <p className="text-xs text-muted-foreground">{chosen?.name ?? selected}</p>
        <Button
          size="sm"
          className="w-full"
          disabled={loading || Boolean(error) || !chosen?.tools || starting}
          onClick={() => start({ agent: 'omp', customModelId: selected })}
        >
          {translate('ompLauncher.launch', 'Launch selected model')}
        </Button>
      </div>
      {launchError && (
        <p role="alert" className="px-2 text-xs text-destructive">
          {launchError}
        </p>
      )}
      {loading ? (
        <p role="status" className="px-2 text-xs text-muted-foreground">
          {translate('ompLauncher.loading', 'Loading OpenRouter models…')}
        </p>
      ) : error ? (
        <div className="px-2">
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
          <Button variant="ghost" size="sm" onClick={() => setAttempt((value) => value + 1)}>
            {translate('ompLauncher.retry', 'Retry')}
          </Button>
        </div>
      ) : (
        <div className="max-h-64 overflow-y-auto scrollbar-sleek">
          {!groups.size && (
            <DropdownMenuLabel>
              {translate('ompLauncher.empty', 'No matching models.')}
            </DropdownMenuLabel>
          )}
          {[...groups]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([family, entries]) => (
              <div key={family}>
                <DropdownMenuLabel>{family}</DropdownMenuLabel>
                {entries
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((model) => (
                    <DropdownMenuItem
                      key={model.id}
                      disabled={!model.tools || starting}
                      data-current={selected === model.id}
                      className={selected === model.id ? 'bg-accent' : undefined}
                      onSelect={(event) => {
                        event.preventDefault()
                        setSelected(model.id)
                      }}
                    >
                      <div className="min-w-0">
                        <div>{model.name}</div>
                        <div className="break-all text-xs text-muted-foreground">{model.id}</div>
                        {!model.tools && (
                          <div className="text-xs text-muted-foreground">
                            {translate(
                              'ompLauncher.noTools',
                              'No tool support — unavailable for OMP'
                            )}
                          </div>
                        )}
                      </div>
                    </DropdownMenuItem>
                  ))}
              </div>
            ))}
        </div>
      )}
    </div>
  )
}
