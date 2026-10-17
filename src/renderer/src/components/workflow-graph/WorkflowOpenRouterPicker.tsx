import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { WorkflowModelLogo } from '@/lib/workflow-model-logo'
import { WorkflowModelList } from './WorkflowModelList'
import type { WorkflowModelSource } from './workflow-model-sources'

const OPENROUTER_ONLY: WorkflowModelSource[] = [{ route: 'openrouter', models: [] }]

/** An OpenRouter model alone: the shared model list, with its logos and price filter. */
export function WorkflowOpenRouterPicker({
  model,
  judge = false,
  onChange
}: {
  model?: string
  judge?: boolean
  onChange: (model: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="max-w-72 gap-1.5">
          {model && <WorkflowModelLogo route="openrouter" model={model} size={13} />}
          <span className="truncate">
            {model ?? translate('workflowGraph.models.choose', 'Choose OpenRouter model')}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-96 p-0" align="start">
        <WorkflowModelList
          sources={OPENROUTER_ONLY}
          judge={judge}
          isSelected={(entry) => entry.model === model}
          onPick={(entry) => {
            if (entry.model) {
              onChange(entry.model)
            }
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
