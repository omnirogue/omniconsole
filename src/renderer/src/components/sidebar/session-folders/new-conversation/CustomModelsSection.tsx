import { useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { Input } from '@/components/ui/input'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import type { HoverOpenContentProps } from '@/components/next-step/use-hover-open-popover'
import {
  customModelMatches,
  normalizeCustomModelPresets,
  MAX_CUSTOM_MODEL_PRESETS,
  type CustomModelPreset
} from '../../../../../../shared/custom-model-presets'
import { LauncherMenuRow } from './LauncherMenuRow'
import { CustomModelPresetEditor } from './CustomModelPresetEditor'
import { useOpenRouterModelCatalog } from './use-openrouter-model-catalog'
import type { LaunchPick } from './resolve-launch-plan'

export function CustomModelsSection({
  start,
  hover,
  starting,
  launchError
}: {
  start: (pick: LaunchPick) => void
  hover: HoverOpenContentProps
  starting?: boolean
  launchError?: string
}) {
  const raw = useAppStore((state) => state.settings?.customModelPresets)
  const loaded = useAppStore((state) => state.settings !== null)
  const presets = normalizeCustomModelPresets(raw)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<CustomModelPreset | 'new' | null>(null)
  const [saving, setSaving] = useState(false)
  const catalog = useOpenRouterModelCatalog()
  // Only a successfully loaded catalog can call a model unavailable.
  const unavailable = (preset: CustomModelPreset): boolean =>
    Boolean(catalog.ids && !catalog.ids.has(preset.modelId))
  const readPresets = () =>
    normalizeCustomModelPresets(useAppStore.getState().settings?.customModelPresets)
  const save = async (preset: CustomModelPreset) => {
    const current = readPresets()
    const exists = current.some((entry) => entry.id === preset.id)
    if (!exists && current.length >= MAX_CUSTOM_MODEL_PRESETS) {
      throw new Error(translate('customModels.limit', 'Remove a preset before adding another.'))
    }
    await useAppStore.getState().updateSettingsOrThrow({
      customModelPresets: exists
        ? current.map((entry) => (entry.id === preset.id ? preset : entry))
        : [...current, preset]
    })
    setEditing(null)
    setQuery('')
  }
  const remove = async (removed: CustomModelPreset[]) => {
    if (saving || !removed.length) {
      return
    }
    const ids = new Set(removed.map((preset) => preset.id))
    setSaving(true)
    try {
      await useAppStore.getState().updateSettingsOrThrow({
        customModelPresets: readPresets().filter((entry) => !ids.has(entry.id))
      })
      toast.success(
        removed.length === 1
          ? translate('customModels.deleted', 'Preset deleted.')
          : translate('customModels.deletedMany', '{{count}} presets deleted.', {
              count: removed.length
            })
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }
  const matching = presets.filter((preset) => customModelMatches(preset, query))
  const unavailablePresets = presets.filter(unavailable)
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>{translate('customModels.heading', 'Custom models')}</DropdownMenuLabel>
      {editing ? (
        <CustomModelPresetEditor
          key={editing === 'new' ? 'new' : editing.id}
          preset={editing === 'new' ? undefined : editing}
          catalog={catalog}
          save={save}
          cancel={() => setEditing(null)}
        />
      ) : (
        <>
          <div className="px-2 pb-2">
            <Input
              aria-label={translate('customModels.search', 'Search custom models')}
              placeholder={translate('customModels.searchPlaceholder', 'Search name or model ID…')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') {
                  event.stopPropagation()
                }
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  const input = event.currentTarget
                  const items = input
                    .closest('[role="menu"]')
                    ?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([data-disabled])')
                  Array.from(items ?? [])
                    .find(
                      (item) =>
                        input.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING
                    )
                    ?.focus()
                }
              }}
            />
          </div>
          {matching.map((preset) => (
            <LauncherMenuRow
              key={preset.id}
              hover={hover}
              disabled={!loaded || starting || saving}
              onLaunch={() => start({ agent: 'omp', customModelId: preset.modelId })}
              onRemove={() => void remove([preset])}
              removeLabel={translate('customModels.deleteNamed', 'Delete {{name}}', {
                name: preset.name
              })}
              submenu={
                <>
                  <DropdownMenuItem
                    onSelect={(event) => {
                      event.preventDefault()
                      setEditing(preset)
                    }}
                  >
                    {translate('customModels.edit', 'Edit preset…')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={(event) => {
                      event.preventDefault()
                      void remove([preset])
                    }}
                  >
                    {translate('customModels.delete', 'Delete preset')}
                  </DropdownMenuItem>
                </>
              }
            >
              <div className="flex items-center gap-1">
                <span className="truncate">{preset.name}</span>
                {unavailable(preset) && (
                  <span
                    className="shrink-0 rounded bg-destructive/10 px-1 text-[10px] text-destructive"
                    title={translate(
                      'customModels.unavailableHint',
                      'OpenRouter no longer lists this model.'
                    )}
                  >
                    {translate('customModels.unavailableBadge', 'Unavailable')}
                  </span>
                )}
              </div>
              <div className="truncate text-xs text-muted-foreground">{preset.modelId}</div>
            </LauncherMenuRow>
          ))}
          {!matching.length && (
            <p className="px-2 py-1 text-xs text-muted-foreground">
              {presets.length
                ? translate('customModels.empty', 'No matching custom models.')
                : translate('customModels.none', 'No custom models yet.')}
            </p>
          )}
          {unavailablePresets.length > 0 && (
            <DropdownMenuItem
              variant="destructive"
              disabled={!loaded || starting || saving}
              onSelect={(event) => {
                event.preventDefault()
                void remove(unavailablePresets)
              }}
            >
              {translate(
                'customModels.removeUnavailable',
                'Remove unavailable models ({{count}})',
                {
                  count: unavailablePresets.length
                }
              )}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            disabled={!loaded || starting || saving || presets.length >= MAX_CUSTOM_MODEL_PRESETS}
            onSelect={(event) => {
              event.preventDefault()
              setEditing('new')
            }}
          >
            {translate('customModels.add', 'Add custom model…')}
          </DropdownMenuItem>
        </>
      )}
      {starting && (
        <p role="status" className="px-2 py-1 text-xs text-muted-foreground">
          {translate('customModels.checking', 'Checking the execution host…')}
        </p>
      )}
      {launchError && (
        <p role="alert" className="px-2 py-1 text-xs text-destructive">
          {launchError}
        </p>
      )}
    </>
  )
}
