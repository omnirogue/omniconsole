import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { cn } from '@/lib/utils'
import {
  CustomModelPresetSchema,
  CUSTOM_MODEL_ID_PLACEHOLDER,
  filterOpenRouterModels,
  openRouterProviders,
  type CustomModelPreset
} from '../../../../../../shared/custom-model-presets'
import type { OpenRouterModelCatalog } from './use-openrouter-model-catalog'

const MAX_VISIBLE_MODELS = 200

export function CustomModelPresetEditor({
  preset,
  catalog,
  save,
  cancel
}: {
  preset?: CustomModelPreset
  catalog: OpenRouterModelCatalog
  save: (preset: CustomModelPreset) => Promise<void>
  cancel: () => void
}) {
  const [name, setName] = useState(preset?.name ?? '')
  const [modelId, setModelId] = useState(preset?.modelId ?? '')
  // Picking a model fills the name until the user types their own.
  const [nameFromPick, setNameFromPick] = useState(!preset)
  const [provider, setProvider] = useState('')
  const [search, setSearch] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [openedAt] = useState(() => Date.now())
  const providers = useMemo(() => openRouterProviders(catalog.models), [catalog.models])
  const matching = useMemo(
    () => filterOpenRouterModels(catalog.models, search, provider || undefined),
    [catalog.models, search, provider]
  )
  const pick = (id: string, modelName: string): void => {
    setModelId(id)
    if (nameFromPick || !name.trim()) {
      setName(modelName)
      setNameFromPick(true)
    }
    setError('')
  }
  const submit = async () => {
    if (saving) {
      return
    }
    const parsed = CustomModelPresetSchema.safeParse({
      id: preset?.id ?? createBrowserUuid(),
      name,
      modelId
    })
    if (!parsed.success) {
      setError(
        translate(
          'customModels.invalid',
          'Choose a model from the list, or enter an exact OpenRouter model ID such as provider/model, without spaces or a URL.'
        )
      )
      return
    }
    setSaving(true)
    setError('')
    try {
      await save(parsed.data)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setSaving(false)
    }
  }
  const moveFocus = (from: HTMLElement, step: 1 | -1): void => {
    const options = Array.from(
      from.closest('form')?.querySelectorAll<HTMLElement>('[data-model-option]') ?? []
    )
    const index = options.indexOf(from)
    options[index + step]?.focus()
  }
  const unlisted = catalog.ids && modelId && !catalog.ids.has(modelId)
  return (
    <form
      className="w-full space-y-3 p-2"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') {
          event.stopPropagation()
        }
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="custom-model-search">
          {translate('customModels.choose', 'Choose an OpenRouter model')}
        </Label>
        <div className="flex gap-2">
          <select
            aria-label={translate('customModels.provider', 'Provider')}
            value={provider}
            disabled={saving || !catalog.models.length}
            onChange={(event) => setProvider(event.target.value)}
            className="h-8 w-36 shrink-0 rounded-md border border-input bg-background px-2 text-xs text-foreground"
          >
            <option value="">
              {translate('customModels.allProviders', 'All providers ({{count}})', {
                count: providers.length
              })}
            </option>
            {providers.map((entry) => (
              <option key={entry.provider} value={entry.provider}>
                {entry.provider} ({entry.count})
              </option>
            ))}
          </select>
          <Input
            id="custom-model-search"
            className="h-8 text-xs"
            value={search}
            autoFocus
            disabled={saving}
            placeholder={translate('customModels.catalogSearch', 'Search models…')}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                event.currentTarget
                  .closest('form')
                  ?.querySelector<HTMLElement>('[data-model-option]')
                  ?.focus()
              }
            }}
          />
        </div>
        <div
          role="listbox"
          aria-label={translate('customModels.catalog', 'OpenRouter models')}
          className="max-h-56 overflow-y-auto rounded-md border border-input scrollbar-sleek"
        >
          {matching.slice(0, MAX_VISIBLE_MODELS).map((model) => (
            <button
              key={model.id}
              type="button"
              role="option"
              data-model-option
              aria-selected={model.id === modelId}
              disabled={saving}
              className={cn(
                'block w-full px-2 py-1 text-left text-xs hover:bg-accent focus:bg-accent focus:outline-none',
                model.id === modelId && 'bg-accent'
              )}
              onClick={() => pick(model.id, model.name)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  moveFocus(event.currentTarget, event.key === 'ArrowDown' ? 1 : -1)
                }
              }}
            >
              <div className="truncate">{model.name}</div>
              <div className="truncate text-muted-foreground">
                {model.id}
                {!model.tools && ` · ${translate('customModels.noTools', 'no tool calling')}`}
              </div>
            </button>
          ))}
          {!matching.length && (
            <p className="px-2 py-1 text-xs text-muted-foreground">
              {catalog.error && !catalog.models.length
                ? translate(
                    'customModels.catalogError',
                    'OpenRouter models could not be loaded. You can still enter an exact model ID below.'
                  )
                : catalog.fetchedAt
                  ? translate('customModels.noCatalogMatch', 'No matching OpenRouter models.')
                  : translate('customModels.catalogLoading', 'Loading OpenRouter models…')}
            </p>
          )}
        </div>
        {catalog.fetchedAt !== undefined && (
          <p className="text-xs text-muted-foreground">
            {translate(
              'customModels.catalogStatus',
              '{{shown}} of {{count}} models · updated {{when}}',
              {
                shown: Math.min(matching.length, MAX_VISIBLE_MODELS),
                count: catalog.models.length,
                when: formatUiRelativeTime(Math.min(0, catalog.fetchedAt - openedAt))
              }
            )}
          </p>
        )}
      </div>
      <div className="space-y-1">
        <Label htmlFor="custom-model-name">{translate('customModels.name', 'Preset name')}</Label>
        <Input
          id="custom-model-name"
          value={name}
          maxLength={100}
          disabled={saving}
          aria-invalid={Boolean(error)}
          onChange={(event) => {
            setName(event.target.value)
            setNameFromPick(false)
          }}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="custom-model-id">
          {translate('customModels.modelId', 'OpenRouter model ID')}
        </Label>
        <Input
          id="custom-model-id"
          value={modelId}
          maxLength={512}
          disabled={saving}
          placeholder={CUSTOM_MODEL_ID_PLACEHOLDER}
          aria-invalid={Boolean(error)}
          onChange={(event) => setModelId(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          {unlisted
            ? translate(
                'customModels.notListed',
                'OpenRouter does not list this model right now. It may be retired or private.'
              )
            : translate(
                'customModels.exactId',
                'Uses this exact model through OMP. Availability and authentication are checked on the execution host at launch.'
              )}
        </p>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={cancel}>
          {translate('customModels.cancel', 'Cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={saving}>
          {translate('customModels.save', 'Save preset')}
        </Button>
      </div>
    </form>
  )
}
