import { useWorkSessionOptions } from '@/hooks/useWorkSessionOptions'
import type { CodexResumeRelaunchStatus } from './codex-resume-relaunch-state'
import {
  isCodexResumeRelaunchStatusInFlight,
  useCodexResumeRelaunchStatus
} from './codex-resume-relaunch-state'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { NativeChatPtySessionOptionsSurface } from './native-chat-pty-session-options'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../shared/native-chat-session-options'
import { useNativeChatSessionOptionCommand } from './use-native-chat-session-option-command'
import { useNativeChatSessionOptions } from './use-native-chat-session-options'

type CommandArgs = Parameters<typeof useNativeChatSessionOptionCommand>[0]
type OptionsArgs = Parameters<typeof useNativeChatSessionOptions>[0]

/**
 * The composer's session-option wiring: the typed-command dispatcher, the PTY
 * option surface, the Codex restart-on-thread status, and the surface the
 * pickers actually get — the structured transport's when there is one, else the
 * PTY's. Structured choices come from the live provider. Why one
 * hook: the relaunch lock is part of `disabled`, and `disabled` feeds the
 * dispatcher, so the composer reads the lock here before its own disabled state.
 */
export function useNativeChatComposerSessionOptions(
  args: Omit<CommandArgs, 'disabled'> &
    Omit<OptionsArgs, 'dispatchCommand' | 'onAgentPicker'> & {
      canSend: boolean
      /** A structured transport always has a target; only `canSend` gates it. */
      structuredTransport?: Pick<
        NativeChatStructuredComposerTransport,
        'worktreeId' | 'optionsSurface' | 'optionSnapshot'
      >
      onSwitchToTerminal?: () => void
    }
): {
  hasPty: boolean
  disabled: boolean
  isDispatchingSessionOption: boolean
  ptySessionOptionsSurface: NativeChatPtySessionOptionsSurface | null
  sessionOptionsSurface: SessionOptionsSurface | null
  sessionOptionsSnapshot: SessionOptionDescriptor[]
  relaunchStatus: CodexResumeRelaunchStatus | null
} {
  const { structuredTransport } = args
  // Why: the cross-surface double-apply lock — the pane is being killed and
  // respawned, so nothing may be typed until the resumed Codex is verified.
  const relaunchInFlight = isCodexResumeRelaunchStatusInFlight(
    useCodexResumeRelaunchStatus(args.paneKey)
  )
  const [hasPty, disabled] = structuredTransport
    ? [true, !args.canSend]
    : [args.targetPtyId !== null, args.targetPtyId === null || !args.canSend || relaunchInFlight]
  const { dispatch, isDispatching } = useNativeChatSessionOptionCommand({
    agent: args.agent,
    disabled,
    onSlashCommand: args.onSlashCommand,
    resolveTarget: args.resolveTarget,
    setHistory: args.setHistory
  })
  const { surface, snapshot, relaunchStatus } = useNativeChatSessionOptions({
    agent: args.agent,
    terminalTabId: args.terminalTabId,
    paneKey: args.paneKey,
    targetPtyId: args.targetPtyId,
    isWorking: args.isWorking,
    dispatchCommand: dispatch,
    onAgentPicker: args.onSwitchToTerminal,
    readTerminalScreen: args.readTerminalScreen,
    reportedModel: args.reportedModel
  })
  const workOptions = useWorkSessionOptions({
    agent: args.agent,
    tabId: args.terminalTabId,
    worktreeId: structuredTransport?.worktreeId,
    surface: structuredTransport?.optionsSurface ?? surface,
    snapshot: structuredTransport?.optionSnapshot ?? snapshot,
    transport: structuredTransport ? 'agent-session' : 'catalog'
  })
  return {
    hasPty,
    disabled,
    isDispatchingSessionOption: isDispatching,
    ptySessionOptionsSurface: surface,
    sessionOptionsSurface: workOptions.surface,
    sessionOptionsSnapshot: workOptions.snapshot,
    relaunchStatus
  }
}
