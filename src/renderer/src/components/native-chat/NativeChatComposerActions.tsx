import { ArrowUp, AtSign, Plus, Square } from 'lucide-react'
import { DictationMicButton } from '@/components/dictation/DictationMicButton'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { AgentType } from '../../../../shared/agent-status-types'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../shared/native-chat-session-options'
import { ChatUsageButton } from './ChatUsageButton'
import { NativeChatSessionOptionPickers } from './NativeChatSessionOptionPickers'
import type { NativeChatOptionPickerRequest } from './native-chat-composer-types'
import type { CodexResumeRelaunchStatus } from './codex-resume-relaunch-state'

export type NativeChatComposerActionsProps = {
  agent?: AgentType
  attachDisabled: boolean
  dictationDisabled: boolean
  sendDisabled: boolean
  isWorking: boolean
  isDictating: boolean
  isDictationHoldMode: boolean
  promptEngineer?: React.ReactNode
  sendLabel?: string
  stopDisabled?: boolean
  onTag?: () => void
  tagDisabled?: boolean
  onAttach: () => void
  onDictationToggle: () => void
  onDictationHoldStart: () => void
  onDictationHoldEnd: () => void
  onSend: () => void
  onStop?: () => void
  sessionOptionsSurface: SessionOptionsSurface | null
  sessionOptionsSnapshot: SessionOptionDescriptor[]
  sessionOptionsPickerRequest?: NativeChatOptionPickerRequest | null
  sessionOptionsApplyStatus?: CodexResumeRelaunchStatus | null
}

export function NativeChatComposerActions({
  agent,
  attachDisabled,
  dictationDisabled,
  sendDisabled,
  isWorking,
  isDictating,
  isDictationHoldMode,
  promptEngineer,
  sendLabel,
  stopDisabled,
  onTag,
  tagDisabled,
  onAttach,
  onDictationToggle,
  onDictationHoldStart,
  onDictationHoldEnd,
  onSend,
  onStop,
  sessionOptionsSurface,
  sessionOptionsSnapshot,
  sessionOptionsPickerRequest,
  sessionOptionsApplyStatus
}: NativeChatComposerActionsProps): React.JSX.Element {
  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-0.5">
        {onTag && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={onTag}
                disabled={tagDisabled}
                aria-label={translate('chatDelivery.tagPersonOrAgent', 'Tag a person or agent')}
              >
                <AtSign className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {translate('chatDelivery.tagPersonOrAgent', 'Tag a person or agent')}
            </TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={translate('components.native-chat.composer.attach', 'Attach file')}
              disabled={attachDisabled}
              onClick={onAttach}
              className="pointer-coarse:size-11"
            >
              <Plus className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {translate('components.native-chat.composer.attach', 'Attach file')}
          </TooltipContent>
        </Tooltip>
        {promptEngineer}
        <ChatUsageButton agent={agent} />
      </div>
      <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-1.5">
        {/* Why: keep session controls beside the actions they affect; the
        model trigger is ordered last so it sits directly next to dictation. */}
        <NativeChatSessionOptionPickers
          surface={sessionOptionsSurface}
          snapshot={sessionOptionsSnapshot}
          isWorking={isWorking}
          pickerRequest={sessionOptionsPickerRequest}
          applyStatus={sessionOptionsApplyStatus}
        />
        <DictationMicButton
          isDictating={isDictating}
          holdMode={isDictationHoldMode}
          disabled={dictationDisabled}
          onToggle={onDictationToggle}
          onHoldStart={onDictationHoldStart}
          onHoldEnd={onDictationHoldEnd}
          className="pointer-coarse:size-11"
        />
        <Button
          type="button"
          aria-label={sendLabel ?? translate('components.native-chat.composer.send', 'Send')}
          disabled={sendDisabled}
          onClick={(event) => {
            if (event.detail <= 1) {
              onSend()
            }
          }}
          size={sendLabel ? 'sm' : 'icon'}
          className={
            sendLabel
              ? 'h-8 gap-1.5 pointer-coarse:h-10'
              : 'size-8 rounded-full pointer-coarse:size-10'
          }
        >
          <ArrowUp className="size-4" />
          {sendLabel}
        </Button>
        {isWorking ? (
          <Button
            type="button"
            data-native-chat-critical-action="stop"
            aria-label={translate('components.native-chat.stop', 'Stop the agent')}
            disabled={stopDisabled || !onStop}
            onClick={(event) => {
              if (event.detail <= 1) {
                onStop?.()
              }
            }}
            variant="secondary"
            size="icon"
            className="size-8 rounded-full pointer-coarse:size-10"
          >
            <Square className="size-3.5 fill-current" />
          </Button>
        ) : null}
      </div>
    </div>
  )
}
