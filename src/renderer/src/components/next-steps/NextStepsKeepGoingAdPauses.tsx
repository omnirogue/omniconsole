import { useState } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import type { ConversationSource } from '../../../../shared/conversation-source'
import {
  resolveAdPauses,
  type NextStepAdPauses
} from '../../../../shared/next-step-ad-pauses'
import type { NextStepKeepGoingState } from '../../../../shared/next-step-keep-going'
import { normalizeNextStepSuggestionSettings } from '../../../../shared/next-step-suggestion-settings'
import { setNextStepAdPauses } from './next-steps-client'
import { noteNextStepKeepGoing } from './next-steps-pending-store'

const DEFAULT = 'default'

function choiceWords(choice: NextStepAdPauses): string {
  return choice === 'ask-first'
    ? translate('nextSteps.keepGoing.adPause.askFirst', 'Ad pauses: ask me first')
    : translate('nextSteps.keepGoing.adPause.allowed', 'Ad pauses: allowed')
}

/** This session's "Ad pauses: allowed / ask me first"; its default follows the global setting. */
export function KeepGoingAdPausesSelect({
  conversation,
  state,
  disabled
}: {
  conversation: ConversationSource
  state: NextStepKeepGoingState | null | undefined
  disabled: boolean
}) {
  const raw = useAppStore((store) => store.settings?.nextStepSuggestions)
  const global = resolveAdPauses(normalizeNextStepSuggestionSettings(raw).adPauses, undefined)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const change = async (value: string): Promise<void> => {
    setPending(true)
    setError(null)
    try {
      const next = value === DEFAULT ? null : (value as NextStepAdPauses)
      noteNextStepKeepGoing(await setNextStepAdPauses(conversation, next))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setPending(false)
    }
  }
  return (
    <Select
      value={state?.adPauses ?? DEFAULT}
      disabled={disabled || pending}
      onValueChange={(value) => void change(value)}
    >
      <SelectTrigger
        size="sm"
        className={cn('h-6 px-1.5 text-xs', error && 'text-destructive')}
        title={error ?? undefined}
        aria-label={translate('nextSteps.keepGoing.adPause.label', 'Ad pauses in this session')}
        data-next-steps-keep-going-ad-pauses
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" align="end">
        <SelectItem value={DEFAULT}>
          {global === 'ask-first'
            ? translate(
                'nextSteps.keepGoing.adPause.defaultAskFirst',
                'Ad pauses: default (ask me first)'
              )
            : translate('nextSteps.keepGoing.adPause.defaultAllowed', 'Ad pauses: default (allowed)')}
        </SelectItem>
        {(['allowed', 'ask-first'] as const).map((choice) => (
          <SelectItem key={choice} value={choice}>
            {choiceWords(choice)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** The latest round that paused ads without asking, so the person sees it happened. */
export function KeepGoingAdPauseLine({ state }: { state: NextStepKeepGoingState }) {
  const pause = state.lastAdPause
  if (!pause) {
    return null
  }
  return (
    <span className="truncate" title={pause.title} data-next-steps-keep-going-ad-pause>
      {translate('nextSteps.keepGoing.adPause.ran', 'Round {{n}} paused ads: {{title}}', {
        n: pause.round,
        title: pause.title
      })}
    </span>
  )
}
