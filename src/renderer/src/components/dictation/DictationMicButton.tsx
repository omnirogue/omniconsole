import React from 'react'
import { Mic, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'

/**
 * The dictation control shared by the chat composer and other text fields: a click
 * toggles, or press-and-hold in hold mode. Transcribed text lands in the focused field.
 */
export function DictationMicButton({
  isDictating,
  holdMode,
  disabled,
  onToggle,
  onHoldStart,
  onHoldEnd,
  className
}: {
  isDictating: boolean
  holdMode: boolean
  disabled: boolean
  onToggle: () => void
  onHoldStart: () => void
  onHoldEnd: () => void
  className?: string
}): React.JSX.Element {
  const label = isDictating
    ? translate('components.native-chat.composer.stopDictation', 'Stop dictation')
    : translate('components.native-chat.composer.startDictation', 'Start dictation')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={isDictating ? 'secondary' : 'ghost'}
          size="icon-sm"
          aria-label={label}
          disabled={disabled}
          onClick={holdMode ? undefined : onToggle}
          onPointerDown={(event) => {
            if (!holdMode || disabled) {
              return
            }
            event.preventDefault()
            onHoldStart()
          }}
          onPointerUp={() => {
            if (holdMode && !disabled) {
              onHoldEnd()
            }
          }}
          onPointerCancel={() => {
            if (holdMode && !disabled) {
              onHoldEnd()
            }
          }}
          onPointerLeave={(event) => {
            if (holdMode && event.buttons === 1 && !disabled) {
              onHoldEnd()
            }
          }}
          className={className}
        >
          {isDictating ? <Square className="size-3.5 fill-current" /> : <Mic className="size-4" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
