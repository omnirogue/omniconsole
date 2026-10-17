import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import {
  NEXT_STEP_KEEP_GOING_PUSH_PROMPT_MAX_LENGTH,
  normalizeKeepGoingPushPrompt,
  type NextStepKeepGoingMode
} from '../../../../shared/next-step-keep-going'
import { keepGoingModeLabel } from './next-steps-keep-going-mode'

export function KeepGoingModeSelect({
  mode,
  disabled,
  onChange
}: {
  mode: NextStepKeepGoingMode
  disabled: boolean
  onChange: (mode: NextStepKeepGoingMode) => void
}) {
  return (
    <Select
      value={mode}
      disabled={disabled}
      onValueChange={(value) => onChange(value as NextStepKeepGoingMode)}
    >
      <SelectTrigger
        size="sm"
        className="h-6 px-1.5 text-xs"
        aria-label={translate('nextSteps.keepGoing.mode.label', 'What Keep going sends')}
        data-next-steps-keep-going-mode
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" align="end">
        {(['next-step', 'push-for-better'] as const).map((choice) => (
          <SelectItem key={choice} value={choice}>
            {keepGoingModeLabel(choice)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** "Push for better"'s prompt, sent each round; edited here, kept with the conversation's run. */
export function KeepGoingPushPromptField({
  prompt,
  disabled,
  onChange
}: {
  prompt: string
  disabled: boolean
  onChange: (prompt: string) => void
}) {
  const [open, setOpen] = useState(false)
  const fieldId = useId()
  const label = translate('nextSteps.keepGoing.pushPrompt.label', 'Push prompt')
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="xs"
          variant="ghost"
          className="h-6 px-1.5 text-xs"
          title={prompt}
          data-next-steps-keep-going-prompt-trigger
        >
          {translate('nextSteps.keepGoing.pushPrompt.edit', 'Prompt…')}
        </Button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-[26rem] max-w-[90vw] space-y-1.5">
        <Label htmlFor={fieldId}>{label}</Label>
        <Textarea
          id={fieldId}
          value={prompt}
          disabled={disabled}
          maxLength={NEXT_STEP_KEEP_GOING_PUSH_PROMPT_MAX_LENGTH}
          rows={4}
          autoFocus
          aria-invalid={normalizeKeepGoingPushPrompt(prompt) === null}
          data-next-steps-keep-going-prompt
          onChange={(event) => onChange(event.target.value)}
        />
        <p className="text-[11px] text-muted-foreground">
          {disabled
            ? translate(
                'nextSteps.keepGoing.pushPrompt.locked',
                'Stop Keep going to change what it sends.'
              )
            : translate(
                'nextSteps.keepGoing.pushPrompt.help',
                'Sent after each finished turn instead of the top suggestion.'
              )}
        </p>
      </PopoverContent>
    </Popover>
  )
}
