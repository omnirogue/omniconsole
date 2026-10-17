import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { NativeChatLaunchDraft } from '@/lib/native-chat-launch-prompt'
import { useAppStore } from '../../store'
import { emitNativeChatMessageSent } from '@/lib/native-chat-telemetry'
import {
  sendNativeChatMessage,
  sendNativeChatTypedCommand,
  submitNativeChatPrompt
} from './native-chat-runtime-send'
import type { NativeChatSendHandle } from './native-chat-runtime-send'
import { sendNativeChatMessageWithImageAttachments } from './native-chat-runtime-image-send'
import { resolveNativeChatLaunchDraftSend } from './native-chat-launch-draft-send'
import { nativeChatComposerTargetIsRemote } from './native-chat-composer-target'
import type { NativeChatResolvedTarget } from './native-chat-composer-target'
import { pushHistory, type HistoryState } from './native-chat-composer-state'
import { isSlashCommandDraft } from '../../../../shared/native-chat-slash-commands'
import { detectAgentStartupIntervention } from '../../../../shared/agent-startup-intervention'
import { translate } from '@/i18n/i18n'
import type { NativeChatPickerState } from './use-native-chat-picker-state'
import type { NativeChatSendLifecycle } from './use-native-chat-send-lifecycle'
import type { NativeChatPtySessionOptionsSurface } from './native-chat-pty-session-options'
import {
  preparePtyTaskContext,
  refreshPtyTaskContext,
  sessionTaskContextIsCurrent,
  type PreparedTaskContext
} from '@/lib/session-task-context'
import { useSessionTasks } from '@/store/session-task-store'
import { prependPtySessionContext } from '@/lib/session-context-delivery'

export function useNativeChatPtyComposerSend(args: {
  agent: AgentType
  draft: string
  imageAttachments: readonly { path: string }[]
  disabled: boolean
  isDispatchingSessionOption: boolean
  launchDraft?: NativeChatLaunchDraft | null
  launchDraftResolved: boolean
  readTerminalScreen?: () => string | null
  resolveTarget: () => NativeChatResolvedTarget | null
  classifySend: NativeChatPickerState['classifySend']
  onOptimisticSend?: (text: string, imagePaths?: string[]) => string | undefined
  onSlashCommand?: (command: string) => void
  sessionOptionsSurface: NativeChatPtySessionOptionsSurface | null
  terminalTabId: string
  trackPendingSend: NativeChatSendLifecycle['trackPendingSend']
  setHistory: Dispatch<SetStateAction<HistoryState>>
  setDraft: (value: string) => void
  setCaret: Dispatch<SetStateAction<number>>
  clearSkillOrigin: () => void
  clearImageAttachments: () => void
  setNotice: Dispatch<SetStateAction<string | null>>
}): (textOverride?: string, historyText?: string) => boolean {
  const latest = useRef(args)
  latest.current = args
  const active = useRef(true)
  const refreshing = useRef<symbol | null>(null)
  const contextSend = useRef<NativeChatSendHandle | null>(null)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      contextSend.current?.cancel()
    }
  }, [])
  return useCallback(
    (textOverride?: string, historyText?: string) => {
      const text = textOverride ?? args.draft
      const imagePaths = args.imageAttachments.map((attachment) => attachment.path)
      if ((text.trim() === '' && imagePaths.length === 0) || args.disabled) {
        return false
      }
      // Why: keep option-command and prompt writes from interleaving on the PTY input line.
      if (args.isDispatchingSessionOption) {
        return false
      }
      const target = args.resolveTarget()
      if (!target) {
        return false
      }
      // Why: a startup menu (update offer, trust, sign-in) reads the next Enter as
      // its answer. Keep the draft and say so instead of feeding it to the menu.
      if (detectAgentStartupIntervention(args.agent, args.readTerminalScreen?.() ?? null)) {
        args.setNotice(
          translate(
            'conversations.startupIntervention.composerHeld',
            'Answer the startup prompt above first — your message is kept.'
          )
        )
        return false
      }
      const classification = args.classifySend(text)
      const context =
        classification === 'chat'
          ? preparePtyTaskContext(text, args.terminalTabId, target.ptyId)
          : { text, commit() {} }
      const targetIsCurrent = () => {
        const current = latest.current
        const next = current.resolveTarget()
        return (
          active.current &&
          current.agent === args.agent &&
          current.terminalTabId === args.terminalTabId &&
          !current.disabled &&
          !current.isDispatchingSessionOption &&
          next?.ptyId === target.ptyId &&
          (next.settings?.activeRuntimeEnvironmentId ?? null) ===
            (target.settings?.activeRuntimeEnvironmentId ?? null)
        )
      }
      const sendPrepared = (context: PreparedTaskContext) => {
        // Why: the agent gets the user's words (plus task context) only; next steps live in the UI.
        const submittedText =
          classification === 'chat'
            ? prependPtySessionContext(context.text, args.terminalTabId, target.ptyId)
            : context.text
        const { sendOptions: draftSendOptions } = resolveNativeChatLaunchDraftSend({
          launchDraft: args.launchDraft,
          launchDraftResolved: args.launchDraftResolved,
          agent: args.agent,
          readScreen: () => args.readTerminalScreen?.()
        })
        const sendOptions =
          args.agent === 'omp' ? { ...draftSendOptions, agent: 'omp' as const } : draftSendOptions
        let pendingHandle: NativeChatSendHandle | null = null
        // Why: slash-like text must not silently drop its attached images.
        if (classification !== 'chat' && imagePaths.length === 0) {
          pendingHandle =
            args.agent === 'codex' && isSlashCommandDraft(text)
              ? sendNativeChatTypedCommand(target.settings, target.ptyId, text)
              : sendNativeChatMessage(target.settings, target.ptyId, text, sendOptions)
        } else if (imagePaths.length > 0) {
          pendingHandle = sendNativeChatMessageWithImageAttachments(
            target.settings,
            target.ptyId,
            submittedText,
            imagePaths,
            sendOptions
          )
        } else if (text.trim().length > 0) {
          pendingHandle = sendNativeChatMessage(
            target.settings,
            target.ptyId,
            submittedText,
            sendOptions
          )
        } else {
          submitNativeChatPrompt(target.settings, target.ptyId)
        }
        if (classification !== 'chat') {
          if (pendingHandle) {
            args.trackPendingSend(pendingHandle)
          }
          if (classification === 'command') {
            args.onSlashCommand?.(text.trim())
            args.sessionOptionsSurface?.recordOutgoingCommand(text.trim())
          }
        } else {
          const pendingId = args.onOptimisticSend?.(text, imagePaths)
          if (pendingHandle) {
            args.trackPendingSend(pendingHandle, pendingId)
            if (context.fence) {
              const handle = pendingHandle
              contextSend.current = handle
              const cancelStale = () => {
                if (!targetIsCurrent() || !sessionTaskContextIsCurrent(context.fence!)) {
                  handle.cancel()
                }
              }
              const stopAccount = useAppStore.subscribe(cancelStale)
              const stopBinding = useSessionTasks.subscribe(cancelStale)
              void (handle.settled ?? Promise.resolve()).finally(() => {
                stopAccount()
                stopBinding()
                if (contextSend.current === handle) {
                  contextSend.current = null
                }
              })
            }
            if (pendingHandle.settled && pendingHandle.wasSubmitted) {
              const handle = pendingHandle
              void handle.settled!.then(() => {
                if (handle.wasSubmitted?.()) {
                  context.commit()
                }
              })
            }
          }
        }
        emitNativeChatMessageSent({
          agent: args.agent,
          runtime: nativeChatComposerTargetIsRemote(target.ptyId) ? 'remote' : 'local'
        })
        args.setHistory((previous) => pushHistory(previous, historyText ?? text))
        if (latest.current.draft === args.draft) {
          args.setDraft('')
          args.setCaret(0)
          args.clearSkillOrigin()
        }
        if (latest.current.imageAttachments === args.imageAttachments) {
          args.clearImageAttachments()
        }
        args.setNotice(null)
        useAppStore.getState().clearNativeChatLaunchDraft(args.terminalTabId)
        return true
      }
      if (classification !== 'chat') {
        refreshing.current = null
      }
      if (classification !== 'chat' || !context.fence) {
        return sendPrepared(context)
      }
      if (refreshing.current) {
        return false
      }
      const token = Symbol()
      refreshing.current = token
      void refreshPtyTaskContext(text, args.terminalTabId, target.ptyId)
        .then((prepared) => {
          if (refreshing.current !== token || !active.current) {
            return
          }
          if (
            !targetIsCurrent() ||
            !prepared.fence ||
            !sessionTaskContextIsCurrent(prepared.fence) ||
            detectAgentStartupIntervention(
              args.agent,
              latest.current.readTerminalScreen?.() ?? null
            )
          ) {
            throw new Error('The task or conversation changed. Your message is kept.')
          }
          sendPrepared(prepared)
        })
        .catch((error) => {
          if (active.current && refreshing.current === token) {
            args.setNotice(error instanceof Error ? error.message : String(error))
          }
        })
        .finally(() => {
          if (refreshing.current === token) {
            refreshing.current = null
          }
        })
      return true
    },
    [args]
  )
}
