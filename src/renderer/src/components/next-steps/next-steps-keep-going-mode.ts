import { useState } from 'react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type {
  NextStepKeepGoingMode,
  NextStepKeepGoingState
} from '../../../../shared/next-step-keep-going'
import {
  keepGoingDefaultPushPrompt,
  normalizeNextStepSuggestionSettings
} from '../../../../shared/next-step-suggestion-settings'

export function keepGoingModeLabel(mode: NextStepKeepGoingMode): string {
  return mode === 'push-for-better'
    ? translate('nextSteps.keepGoing.mode.push', 'Push for better')
    : translate('nextSteps.keepGoing.mode.nextStep', 'Next steps')
}

export type KeepGoingRunChoice = {
  mode: NextStepKeepGoingMode
  setMode: (mode: NextStepKeepGoingMode) => void
  pushPrompt: string
  setPushPrompt: (prompt: string) => void
}

/** The person's mode and push prompt: this conversation's last run, else the settings' defaults. */
export function useKeepGoingRunChoice(
  state: NextStepKeepGoingState | null | undefined
): KeepGoingRunChoice {
  const raw = useAppStore((store) => store.settings?.nextStepSuggestions)
  const settings = normalizeNextStepSuggestionSettings(raw)
  const [mode, setMode] = useState<NextStepKeepGoingMode | null>(null)
  const [pushPrompt, setPushPrompt] = useState<string | null>(null)
  return {
    mode: mode ?? state?.mode ?? settings.keepGoingDefaultMode ?? 'next-step',
    setMode,
    pushPrompt: pushPrompt ?? state?.pushPrompt ?? keepGoingDefaultPushPrompt(settings),
    setPushPrompt
  }
}
