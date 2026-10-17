import { useAppStore } from '@/store'

export function useNativeChatDictationState(dictationPressed: boolean) {
  const dictationState = useAppStore((store) => store.dictationState)
  const voiceSettings = useAppStore((store) => store.settings?.voice)
  const dictationDisabled = voiceSettings?.enabled !== true || !voiceSettings.sttModel
  const isDictating =
    dictationPressed ||
    dictationState === 'starting' ||
    dictationState === 'listening' ||
    dictationState === 'stopping'

  return { dictationDisabled, isDictating, voiceSettings }
}
