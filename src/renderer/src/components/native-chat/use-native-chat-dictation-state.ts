import { useAppStore } from '@/store'

export function useNativeChatDictationState(dictationPressed: boolean) {
  const dictationState = useAppStore((store) => store.dictationState)
  const voiceSettings = useAppStore((store) => store.settings?.voice)
  const dictationDisabled = false
  const isDictating =
    dictationPressed ||
    dictationState === 'starting' ||
    dictationState === 'listening' ||
    dictationState === 'stopping'

  return { dictationDisabled, isDictating, voiceSettings }
}
