import { useState } from 'react'
import { Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { translate } from '@/i18n/i18n'
import { WorkflowModelLogo } from '@/lib/workflow-model-logo'
import { cn } from '@/lib/utils'
import { localWorkflowProviderLabel } from '../../../../shared/local-workflow-model-label'
import { mayIssueVerdict } from '../../../../shared/model-lineage'
import type { WorkflowPresetModel } from '../../../../shared/workflow-model-presets'
import {
  workflowOpenRouterPriceBand,
  workflowOpenRouterWithinBand,
  type WorkflowOpenRouterModel,
  type WorkflowOpenRouterPriceBand
} from '../../../../shared/workflow-openrouter-models'
import { useWorkflowOpenRouterModels } from './use-workflow-openrouter-models'
import { seatableOpenRouterModels, type WorkflowModelSource } from './workflow-model-sources'

const BANDS: WorkflowOpenRouterPriceBand[] = ['standard', 'free', 'very-low', 'low']

function bandLabel(band: WorkflowOpenRouterPriceBand): string {
  return band === 'free'
    ? translate('workflowGraph.models.bandFree', 'Free')
    : band === 'very-low'
      ? translate('workflowGraph.models.bandVeryLow', 'Very low cost')
      : band === 'low'
        ? translate('workflowGraph.models.bandLow', 'Low cost')
        : translate('workflowGraph.models.bandAll', 'All')
}

export function workflowOpenRouterPriceText(model: WorkflowOpenRouterModel): string {
  return workflowOpenRouterPriceBand(model) === 'free'
    ? translate('workflowGraph.models.free', 'Free')
    : translate('workflowGraph.models.price', '${{input}} in / ${{output}} out per 1M tokens', {
        input: (model.promptPrice * 1_000_000).toFixed(2),
        output: (model.completionPrice * 1_000_000).toFixed(2)
      })
}

function Row({
  model,
  label,
  note,
  selected,
  search,
  onPick
}: {
  model: WorkflowPresetModel
  label: string
  note?: string
  selected: boolean
  search: string
  onPick: (model: WorkflowPresetModel) => void
}) {
  return (
    <CommandItem value={search} onSelect={() => onPick(model)} className="gap-2">
      <WorkflowModelLogo route={model.route} model={model.model} size={14} />
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{label}</span>
        {note && <span className="truncate text-xs text-muted-foreground">{note}</span>}
      </span>
      <Check className={cn('ml-auto size-3.5 shrink-0', selected ? 'opacity-100' : 'opacity-0')} />
    </CommandItem>
  )
}

/**
 * Every model a workflow agent can run, each with its maker's logo: the signed-in families, the
 * Ollama models on this computer, and OpenRouter's catalog with a price filter (free, very low
 * cost, low cost). A judging step leaves out the models that never decide.
 */
export function WorkflowModelList({
  sources,
  judge = false,
  band: initialBand = 'standard',
  isSelected,
  onPick
}: {
  sources: readonly WorkflowModelSource[]
  judge?: boolean
  /** The OpenRouter price filter the list opens with. */
  band?: WorkflowOpenRouterPriceBand
  isSelected: (model: WorkflowPresetModel) => boolean
  onPick: (model: WorkflowPresetModel) => void
}) {
  const [band, setBand] = useState(initialBand)
  const hasOpenRouter = sources.some((source) => source.route === 'openrouter')
  const openrouter = useWorkflowOpenRouterModels(hasOpenRouter)
  const mayRun = (model: WorkflowPresetModel) => !judge || mayIssueVerdict(model.route, model.model)
  const priced = seatableOpenRouterModels(openrouter.models)
    .filter((model) => workflowOpenRouterWithinBand(model, band))
    .filter((model) => mayRun({ route: 'openrouter', model: model.id }))
  const listed =
    band === 'standard'
      ? priced
      : [...priced].sort((left, right) => left.promptPrice - right.promptPrice)
  return (
    <Command>
      <CommandInput
        placeholder={translate('workflowGraph.models.search', 'Search models or families…')}
      />
      {hasOpenRouter && (
        <div className="flex flex-wrap items-center gap-1 border-b px-2 py-1.5">
          <span className="mr-1 text-xs text-muted-foreground">
            {translate('workflowGraph.models.openrouterPrice', 'OpenRouter:')}
          </span>
          {BANDS.map((entry) => (
            <Button
              key={entry}
              type="button"
              size="xs"
              variant={entry === band ? 'secondary' : 'ghost'}
              aria-pressed={entry === band}
              onClick={() => setBand(entry)}
            >
              {bandLabel(entry)}
            </Button>
          ))}
        </div>
      )}
      <CommandList>
        <CommandEmpty>
          {translate('workflowGraph.models.noModels', 'No matching models available.')}
        </CommandEmpty>
        {sources
          .filter((source) => source.route !== 'openrouter' && source.models.length)
          .map((source) => (
            <CommandGroup
              key={source.route}
              heading={
                source.route === 'ollama'
                  ? translate('workflowGraph.models.ollamaGroup', 'Ollama · local models')
                  : localWorkflowProviderLabel(source.route)
              }
            >
              {source.models
                .map((entry) => ({ entry, model: { route: source.route, model: entry.id } }))
                .filter(({ model }) => mayRun(model))
                .map(({ entry, model }) => (
                  <Row
                    key={entry.id}
                    model={model}
                    label={entry.label}
                    note={entry.note}
                    selected={isSelected(model)}
                    search={`${source.route} ${entry.label} ${entry.id}`}
                    onPick={onPick}
                  />
                ))}
            </CommandGroup>
          ))}
        {hasOpenRouter && (
          <CommandGroup heading={localWorkflowProviderLabel('openrouter')}>
            {listed.map((entry) => {
              const model = { route: 'openrouter' as const, model: entry.id }
              return (
                <Row
                  key={entry.id}
                  model={model}
                  label={entry.name}
                  note={`${entry.id} · ${workflowOpenRouterPriceText(entry)}`}
                  selected={isSelected(model)}
                  search={`openrouter ${entry.id} ${entry.name}`}
                  onPick={onPick}
                />
              )
            })}
            {!listed.length && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                {openrouter.failed
                  ? translate(
                      'workflowGraph.models.catalogError',
                      'OpenRouter models could not be loaded. Close and reopen to retry.'
                    )
                  : openrouter.models.length
                    ? translate(
                        'workflowGraph.models.noneInBand',
                        'No OpenRouter model at this price can return the structured answers a workflow needs right now.'
                      )
                    : translate('workflowGraph.models.loading', 'Loading OpenRouter models…')}
              </p>
            )}
          </CommandGroup>
        )}
      </CommandList>
      {judge && (
        <p className="border-t px-2 py-1.5 text-xs text-muted-foreground">
          {translate(
            'workflowGraph.models.judgeNote',
            'This step decides, so Google-family models are left out: they never review, rank or synthesize.'
          )}
        </p>
      )}
    </Command>
  )
}
