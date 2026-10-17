import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { workflowModelClient } from '@/lib/workflow-model-client'
import {
  applyWorkflowModelPreset,
  workflowCurrentModels,
  type WorkflowModelPreset
} from '../../../../shared/workflow-model-presets'
import type { WorkflowSpec } from '../../../../shared/workflow-graph'

export function WorkflowModelPresets({
  spec,
  label,
  onChange
}: {
  spec: WorkflowSpec
  /** The trigger's text; "Models" when it stands alone. */
  label?: string
  onChange: (spec: WorkflowSpec) => void
}) {
  const [open, setOpen] = useState(false)
  const [presets, setPresets] = useState<WorkflowModelPreset[]>([])
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const load = async (next: boolean) => {
    setOpen(next)
    if (!next) {
      return
    }
    setBusy(true)
    try {
      setPresets((await workflowModelClient.list()).presets)
      setNote('')
    } catch {
      setNote(
        translate(
          'workflowGraph.models.presetsError',
          'Model presets are unavailable on this host.'
        )
      )
    } finally {
      setBusy(false)
    }
  }
  const save = async () => {
    if (busy || !name.trim()) {
      return
    }
    setBusy(true)
    try {
      setPresets(
        (await workflowModelClient.save({ name, models: workflowCurrentModels(spec) })).presets
      )
      setSaving(false)
      setName('')
      setOpen(false)
      setNote('')
    } catch {
      setNote(
        translate(
          'workflowGraph.models.saveError',
          'Could not save the preset. Choose a model for every OpenRouter seat and try again.'
        )
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-1">
      <Popover
        open={open}
        onOpenChange={(next) => {
          void load(next)
        }}
      >
        <PopoverTrigger asChild>
          <Button variant="outline" size={label ? 'xs' : 'sm'}>
            {label ?? translate('workflowGraph.models.menu', 'Models')}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 space-y-2 p-3">
          <p className="text-xs font-medium">
            {translate('workflowGraph.models.apply', 'Apply preset')}
          </p>
          {presets.map((preset) => (
            <Button
              key={preset.id}
              variant="ghost"
              size="sm"
              disabled={busy}
              className="w-full justify-start"
              onClick={() => {
                const applied = applyWorkflowModelPreset(spec, preset.models)
                onChange(applied.spec)
                setOpen(false)
                setNote(
                  applied.unchanged.length
                    ? translate(
                        'workflowGraph.models.unchanged',
                        'Some judging steps were unchanged because this preset has no eligible judge.'
                      )
                    : ''
                )
              }}
            >
              {preset.name}
            </Button>
          ))}
          {!presets.length && (
            <p className="text-xs text-muted-foreground">
              {translate('workflowGraph.models.empty', 'No saved model presets.')}
            </p>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || !spec.steps.length}
            onClick={() => setSaving(true)}
          >
            {translate('workflowGraph.models.saveCurrent', 'Save current as preset…')}
          </Button>
          {saving && (
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                void save()
              }}
            >
              <Input
                autoFocus
                aria-label={translate('workflowGraph.models.name', 'Preset name')}
                value={name}
                maxLength={100}
                onChange={(event) => setName(event.target.value)}
              />
              <Button type="submit" size="sm" disabled={busy || !name.trim()}>
                {translate('workflowGraph.models.save', 'Save')}
              </Button>
            </form>
          )}
        </PopoverContent>
      </Popover>
      {note && (
        <p role="status" className="text-xs text-muted-foreground">
          {note}
        </p>
      )}
    </div>
  )
}
