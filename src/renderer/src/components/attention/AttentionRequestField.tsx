import React, { useRef, useState } from 'react'
import { DictationMicButton } from '@/components/dictation/DictationMicButton'
import { useNativeChatDictationActions } from '@/components/native-chat/use-native-chat-dictation-actions'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

/**
 * The launcher's request box. When voice is set up, the existing dictation fills it the
 * same way it fills the chat composer; typing always works.
 */
export function AttentionRequestField({
  value,
  onChange
}: {
  value: string
  onChange: (value: string) => void
}): React.JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const [dictationPressed, setDictationPressed] = useState(false)
  const dictationState = useAppStore((state) => state.dictationState)
  const voice = useAppStore((state) => state.settings?.voice)
  const { toggleDictation, startHoldDictation, stopHoldDictation } = useNativeChatDictationActions({
    textareaRef,
    setDictationPressed
  })
  const voiceConfigured = voice?.enabled === true && Boolean(voice.sttModel)
  const isDictating =
    dictationPressed ||
    dictationState === 'starting' ||
    dictationState === 'listening' ||
    dictationState === 'stopping'
  return (
    <div className="flex items-start gap-1.5">
      <Textarea
        ref={textareaRef}
        value={value}
        rows={1}
        onChange={(event) => onChange(event.target.value)}
        placeholder={translate(
          'attentionLauncher.requestPlaceholder',
          'Describe the outcome you want (optional), then pick who starts it.'
        )}
        aria-label={translate('attentionLauncher.requestLabel', 'Request for the new session')}
        className="max-h-28 min-h-8 flex-1 resize-none py-1.5 text-sm"
      />
      {voiceConfigured ? (
        <DictationMicButton
          isDictating={isDictating}
          holdMode={voice?.dictationMode === 'hold'}
          disabled={false}
          onToggle={toggleDictation}
          onHoldStart={startHoldDictation}
          onHoldEnd={stopHoldDictation}
        />
      ) : null}
    </div>
  )
}
