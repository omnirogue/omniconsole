import { nativeChatPromptEngineerFields } from './native-chat-prompt-engineer-fields'
import { chatTagFieldState } from './chat-tag-field-state'
import { usePromptEngineer } from './use-prompt-engineer'
import { useNativeChatDictationState } from './use-native-chat-dictation-state'
import { forwardRef, useCallback, useImperativeHandle, useState } from 'react'
import { useNativeChatResolvedTarget } from './use-native-chat-resolved-target'
import { useNativeChatComposerCatalog } from './use-native-chat-composer-catalog'
import { EMPTY_HISTORY, type HistoryState } from './native-chat-composer-state'
import { useNativeChatDraft } from './use-native-chat-draft'
import { useNativeChatLaunchDraftAdoption } from './use-native-chat-launch-draft-adoption'
import { useNativeChatDraftChange } from './use-native-chat-draft-change'
import { NativeChatComposerField } from './NativeChatComposerField'
import { useNativeChatComposerAttachments } from './use-native-chat-composer-attachments'
import { useNativeChatComposerPaste } from './use-native-chat-composer-paste'
import { useNativeChatExternalAttachments } from './use-native-chat-external-attachments'
import { useNativeChatComposerKeyDown } from './use-native-chat-composer-keydown'
import { useNativeChatSendLifecycle } from './use-native-chat-send-lifecycle'
import { useNativeChatFileAttachmentActions } from './use-native-chat-file-attachment-actions'
import { useNativeChatDictationActions } from './use-native-chat-dictation-actions'
import { useNativeChatComposerSessionOptions } from './use-native-chat-composer-session-options'
import { useNativeChatPickerState } from './use-native-chat-picker-state'
import { useNativeChatPickerCommandDispatch } from './use-native-chat-picker-command-dispatch'
import { useNativeChatTypedInsertion } from './use-native-chat-typed-insertion'
import type {
  NativeChatComposerHandle,
  NativeChatComposerProps
} from './native-chat-composer-types'
import { useNativeChatStructuredSend } from './use-native-chat-structured-send'
import { useNativeChatPtyComposerSend } from './use-native-chat-pty-composer-send'
import { useImeEnterGestureOwnership } from '@/lib/ime-composition-keyboard-event'
import { useNativeChatComposerAppMenuSelection } from './use-native-chat-composer-app-menu-selection'
import { useChatTagComposer } from './use-chat-tag-composer'
import { useHandoffScope } from '@/components/handoffs/handoff-scope'
import { useNativeChatWorkPlanSendActions } from './use-native-chat-work-plan-send-actions'
import { useNativeChatInterrupt } from './use-native-chat-interrupt'
import { usePromptQueueCommand } from '@/components/prompt-queue/use-prompt-queue-command'
import { useNativeChatSessionPrepFields } from './use-native-chat-session-prep-fields'

// Re-exported from the type module this file already imports them from.
export type { NativeChatComposerHandle, NativeChatComposerProps }

/**
 * Rich native input for the chat view. Sends prompts into the running agent
 * through the same verified runtime path as typed input (KTD4), so the agent
 * cannot distinguish native input from keystrokes. Enter sends; Shift+Enter
 * inserts a newline; multi-line is bracketed-paste wrapped; Esc interrupts.
 * Slash-command and `@file` autocomplete are agent-aware; image paste persists a
 * temp file and injects the agent-appropriate path (or reports unsupported).
 */
const NativeChatComposerPane = forwardRef<NativeChatComposerHandle, NativeChatComposerProps>(
  function NativeChatComposerPane(
    {
      terminalTabId,
      paneKey,
      targetPtyId,
      agent,
      reportedModel,
      canSend = true,
      isWorking = false,
      onStop,
      onOptimisticSend,
      onOptimisticSendCanceled,
      onSlashCommand,
      onSwitchToTerminal,
      readTerminalScreen,
      launchSeed,
      structuredTransport,
      getConversationContext
    },
    ref
  ): React.JSX.Element {
    // Scope key shared with image attachments so an unsent draft + its attached
    // images survive both TUI/GUI toggles and PTY replacement on reconnect.
    // Why: local, SSH, and runtime reconnects can replace or temporarily clear
    // the PTY id. Pane identity is the stable ownership key for unsent input.
    const composerScope = `${useHandoffScope()}:${paneKey}`
    const { draft, setDraft } = useNativeChatDraft(composerScope)
    const [caret, setCaret] = useState(draft.length)
    const engineer = usePromptEngineer(paneKey)
    useNativeChatLaunchDraftAdoption({
      terminalTabId,
      agent,
      launchDraft: launchSeed?.launchDraft,
      launchDraftResolved: launchSeed?.launchDraftResolved === true,
      ownsTabWideLaunchDraft: launchSeed?.ownsTabWideLaunchDraft === true,
      draft,
      setDraft,
      setCaret
    })
    const [history, setHistory] = useState<HistoryState>(EMPTY_HISTORY)
    const [activeSuggestion, setActiveSuggestion] = useState(0)
    const [notice, setNotice] = useState<string | null>(null)
    const [dictationPressed, setDictationPressed] = useState(false)
    const imeEnterGesture = useImeEnterGestureOwnership()
    const { textareaRef } = useNativeChatComposerAppMenuSelection(imeEnterGesture.isComposing)
    const { cancelPendingSends, trackPendingSend } = useNativeChatSendLifecycle(
      terminalTabId,
      targetPtyId,
      onOptimisticSendCanceled
    )
    const { dictationDisabled, isDictating, voiceSettings } =
      useNativeChatDictationState(dictationPressed)

    const agentCommands = useNativeChatComposerCatalog(agent, structuredTransport)
    const picker = useNativeChatPickerState({
      agent,
      terminalTabId,
      draftScopeKey: composerScope,
      draft,
      caret,
      agentCommands,
      textareaRef,
      setDraft,
      setCaret,
      setActiveSuggestion
    })
    const {
      autocomplete,
      classifySend,
      clearSkillOrigin,
      completeItem,
      dismiss,
      handleDraftOrCaretChange
    } = picker

    const resolveTarget = useNativeChatResolvedTarget(targetPtyId, terminalTabId)

    const {
      hasPty,
      disabled,
      isDispatchingSessionOption,
      ptySessionOptionsSurface,
      sessionOptionsSurface,
      sessionOptionsSnapshot: optionSnapshot,
      relaunchStatus
    } = useNativeChatComposerSessionOptions({
      agent,
      reportedModel,
      terminalTabId,
      paneKey,
      targetPtyId,
      isWorking,
      canSend,
      structuredTransport,
      onSlashCommand,
      onSwitchToTerminal,
      resolveTarget,
      setHistory,
      readTerminalScreen
    })

    const attachments = useNativeChatComposerAttachments({
      attachmentScopeKey: composerScope,
      allowWithoutTarget: Boolean(structuredTransport),
      caret,
      disabled,
      isComposing: imeEnterGesture.isComposing,
      resolveTarget,
      textareaRef,
      setCaret,
      setDraft,
      setNotice
    })
    const { imageAttachments, attachResolvedPaths, clearImageAttachments, removeImageAttachment } =
      attachments
    const sendButtonDisabled =
      disabled ||
      (Boolean(structuredTransport?.sendUnavailableReason) && !draft.trimStart().startsWith('/')) ||
      (draft.trim() === '' && imageAttachments.length === 0)

    const { insertTypedText, focus } = useNativeChatTypedInsertion({
      textareaRef,
      caret,
      draft,
      setDraft,
      setCaret,
      setHistory,
      setActiveSuggestion
    })

    const { attachExternalPaths, resolveAttachmentOwner } = useNativeChatExternalAttachments({
      terminalTabId,
      structuredWorktreeId: structuredTransport?.worktreeId,
      disabled,
      attachResolvedPaths,
      setNotice
    })

    const tags = useChatTagComposer({
      paneKey,
      draft,
      caret,
      setDraft,
      setCaret,
      textareaRef,
      autocomplete,
      activeSuggestion,
      setActiveSuggestion,
      listboxId: picker.listboxId,
      onSent: clearImageAttachments,
      onAttachUntagged: attachExternalPaths,
      onRemoveImage: removeImageAttachment,
      imageAttachments,
      referencedAttachments: attachments.referencedAttachments
    })
    const { handlePaste, pasteFromClipboard } = useNativeChatComposerPaste({
      agent,
      disabled: tags.active ? tags.pending || tags.retrySaved || tags.attaching : disabled,
      directDelivery: tags.active,
      caret,
      resolveAttachmentOwner: tags.active ? () => ({ kind: 'local' }) : resolveAttachmentOwner,
      attachResolvedPaths: tags.active ? tags.attach : attachResolvedPaths,
      insertTypedText,
      setCaret,
      setNotice
    })
    useImperativeHandle(
      ref,
      () => ({ focus, insertTypedText, handlePasteEvent: handlePaste, pasteFromClipboard }),
      [focus, insertTypedText, handlePaste, pasteFromClipboard]
    )
    const { pickAttachment } = useNativeChatFileAttachmentActions(tags.attach)
    const { toggleDictation, startHoldDictation, stopHoldDictation } =
      useNativeChatDictationActions({ textareaRef, setDictationPressed })
    const sendStructured = useNativeChatStructuredSend({
      agent,
      draft,
      structuredTransport,
      imageAttachments,
      setHistory,
      setDraft,
      setCaret,
      clearSkillOrigin,
      clearImageAttachments
    })

    const sendPty = useNativeChatPtyComposerSend({
      agent,
      draft,
      imageAttachments,
      disabled,
      isDispatchingSessionOption,
      launchDraft: launchSeed?.launchDraft,
      launchDraftResolved: launchSeed?.launchDraftResolved === true,
      readTerminalScreen,
      resolveTarget,
      classifySend,
      onOptimisticSend,
      onSlashCommand,
      sessionOptionsSurface: ptySessionOptionsSurface,
      terminalTabId,
      trackPendingSend,
      setHistory,
      setDraft,
      setCaret,
      clearSkillOrigin,
      clearImageAttachments,
      setNotice
    })
    const queuePrompt = usePromptQueueCommand(paneKey, terminalTabId, setDraft, setNotice)
    const sessionPrep = useNativeChatSessionPrepFields(
      { paneKey, terminalTabId, agent, getConversationContext },
      draft,
      setDraft,
      setNotice
    )
    // `historyText` keeps up-arrow recall on the raw draft when the wizard wraps it.
    const deliver = (text: string, historyText = text) =>
      structuredTransport
        ? sendStructured(text, imageAttachments, historyText)
        : sendPty(text, historyText)
    const deliverDraft = (text: string) => deliver(text, draft)
    const { send, sendNow, go, engineerDisabled } = useNativeChatWorkPlanSendActions({
      tags,
      disabled,
      isWorking,
      hasImageAttachments: imageAttachments.length > 0,
      draft,
      queuePrompt,
      classifySend,
      deliver,
      engineerSend: engineer.send,
      prepareSessions: sessionPrep.prepareSessions,
      deliverDraft
    })

    const interrupt = useNativeChatInterrupt({
      cancelPendingSends,
      isWorking,
      onStop,
      resolveTarget
    })

    const dispatchPtyPickerCommand = useNativeChatPickerCommandDispatch({
      agent,
      disabled,
      isDispatchingSessionOption,
      resolveTarget,
      onSlashCommand,
      sessionOptionsSurface: ptySessionOptionsSurface,
      trackPendingSend,
      setHistory,
      setDraft,
      setCaret,
      setActiveSuggestion,
      clearSkillOrigin,
      clearImageAttachments,
      setNotice
    })
    const dispatchPickerCommand = useCallback(
      (command: Parameters<typeof dispatchPtyPickerCommand>[0]) => {
        if (structuredTransport) {
          sendStructured(`/${command.name}`)
          return
        }
        dispatchPtyPickerCommand(command)
      },
      [dispatchPtyPickerCommand, sendStructured, structuredTransport]
    )

    const handleKeyDown = useNativeChatComposerKeyDown({
      autocomplete,
      activeSuggestion,
      draft,
      history,
      isComposing: imeEnterGesture.isComposing,
      completePickerItem: completeItem,
      dispatchPickerCommand,
      dismissPicker: dismiss,
      interrupt,
      send,
      sendNow,
      setActiveSuggestion,
      setDraft,
      setCaret,
      setHistory
    })

    const { syncCaret, handleDraftChange } = useNativeChatDraftChange({
      paneKey,
      setDraft,
      setHistory,
      setCaret,
      setActiveSuggestion,
      handleDraftOrCaretChange
    })

    const fieldState = chatTagFieldState(
      tags,
      disabled,
      sendButtonDisabled,
      isWorking,
      optionSnapshot
    )
    return (
      <NativeChatComposerField
        agent={agent}
        routineContext={{ tabId: terminalTabId, paneKey }}
        {...nativeChatPromptEngineerFields(engineer, engineerDisabled, focus, go)}
        sessionPrepStatus={sessionPrep.sessionPrepStatus}
        {...fieldState}
        stopDisabled={!hasPty || !onStop}
        textareaRef={textareaRef}
        draft={draft}
        hasPty={hasPty}
        canSend={canSend}
        autocomplete={autocomplete}
        activeSuggestion={activeSuggestion}
        notice={
          [structuredTransport?.sendUnavailableReason, notice].filter(Boolean).join(' ') || null
        }
        imageAttachments={imageAttachments}
        dictationDisabled={dictationDisabled}
        isDictating={isDictating}
        isDictationHoldMode={voiceSettings?.dictationMode === 'hold'}
        imeEnterGesture={imeEnterGesture}
        onDraftChange={handleDraftChange}
        onTextareaSelect={(element) => {
          syncCaret(element)
          handleDraftOrCaretChange(element.value, element.selectionStart ?? element.value.length)
          setActiveSuggestion(0)
        }}
        onKeyDown={(event) => {
          if (imeEnterGesture.isComposing() || !tags.handleKeyDown(event)) {
            handleKeyDown(event)
          }
        }}
        onImeSettled={(element) => {
          if (element.value !== draft) {
            handleDraftChange(element.value, element)
          }
          attachments.flushPendingAttachments()
        }}
        onPaste={handlePaste}
        pickerListboxId={picker.listboxId}
        onChoosePickerItem={completeItem}
        onRetrySkills={picker.retrySkills}
        onAcceptMention={tags.acceptMention}
        onRemoveImageAttachment={(id) => removeImageAttachment(id)}
        onAttach={pickAttachment}
        onDictationToggle={toggleDictation}
        onDictationHoldStart={startHoldDictation}
        onDictationHoldEnd={stopHoldDictation}
        onSend={send}
        onStop={interrupt}
        sessionOptionsSurface={sessionOptionsSurface}
        sessionOptionsSnapshot={optionSnapshot}
        sessionOptionsPickerRequest={structuredTransport?.optionPickerRequest ?? null}
        sessionOptionsApplyStatus={relaunchStatus}
      />
    )
  }
)

export const NativeChatComposer = forwardRef<NativeChatComposerHandle, NativeChatComposerProps>(
  function NativeChatComposer(props, ref): React.JSX.Element {
    const scope = useHandoffScope()
    return <NativeChatComposerPane key={`${scope}:${props.paneKey}`} {...props} ref={ref} />
  }
)
