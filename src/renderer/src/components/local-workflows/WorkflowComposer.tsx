import type { ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import type { LocalWorkflowPreset } from '../../../../shared/local-workflow-draft'
import {
  WorkflowPresetIcon,
  workflowPresetDescription,
  workflowPresetLabel
} from './workflow-presets'

/** The quiet title above a setup: icon, name and one line of what it does. */
export function WorkflowSetupHeading({ preset }: { preset: LocalWorkflowPreset }) {
  return (
    <div className="flex flex-col items-center gap-2 text-center">
      <span className="grid size-10 place-items-center rounded-xl border bg-muted/40 text-muted-foreground">
        <WorkflowPresetIcon preset={preset} className="size-5" />
      </span>
      <h2 className="text-lg font-semibold">{workflowPresetLabel(preset)}</h2>
      <p className="text-sm text-muted-foreground">{workflowPresetDescription(preset)}</p>
    </div>
  )
}

/** Prompt-first composer: Enter starts when valid, Shift+Enter adds a line. */
export function WorkflowComposer({
  preset,
  label,
  placeholder,
  value,
  disabled,
  canStart,
  pending,
  startLabel,
  footer,
  onChange,
  onStart
}: {
  preset: LocalWorkflowPreset
  label: string
  placeholder: string
  value: string
  disabled: boolean
  canStart: boolean
  pending: boolean
  startLabel: string
  footer?: ReactNode
  onChange: (value: string) => void
  onStart: () => void
}) {
  const id = `local-workflow-${preset}-prompt`
  return (
    <div className="rounded-xl border bg-card shadow-xs transition-colors focus-within:border-ring/60">
      <Label htmlFor={id} className="sr-only">
        {label}
      </Label>
      <Textarea
        id={id}
        rows={3}
        autoFocus
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        maxLength={32_000}
        className="min-h-24 resize-none border-0 bg-transparent px-4 pt-3.5 text-[15px] leading-relaxed shadow-none focus-visible:ring-0 dark:bg-transparent md:text-[15px]"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
            return
          }
          event.preventDefault()
          if (canStart) {
            onStart()
          }
        }}
      />
      <div className="flex flex-wrap items-center justify-between gap-2 px-2.5 pb-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1">{footer}</div>
        <Button type="submit" size="sm" disabled={!canStart || pending} className="gap-1.5">
          {pending ? (
            <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
          ) : (
            <WorkflowPresetIcon preset={preset} className="size-3.5" />
          )}
          {startLabel}
        </Button>
      </div>
    </div>
  )
}

/** One status line under the composer: a refusal, or why Start is unavailable. */
export function WorkflowSetupStatus({
  error,
  problem,
  hasPrompt
}: {
  error?: string
  problem?: string
  hasPrompt: boolean
}) {
  if (error) {
    return (
      <p role="alert" className="px-1 text-xs text-destructive">
        {error}
      </p>
    )
  }
  if (!problem && hasPrompt) {
    return null
  }
  return (
    <p role="status" className="px-1 text-xs text-muted-foreground">
      {problem ??
        translate(
          'localWorkflow.setup.enterToStart',
          'Press Enter to start, Shift+Enter for a new line.'
        )}
    </p>
  )
}
