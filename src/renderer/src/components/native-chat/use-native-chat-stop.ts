import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import { stopNativeChatCodex, type CodexStopOutcome } from './native-chat-codex-stop'
import {
  stopNativeChatTranscript,
  type NativeChatStopSnapshot
} from './native-chat-transcript-stop'
import type { NativeChatInteractiveSend } from './use-native-chat-interactive-send'

export function useNativeChatStop(args: {
  agent: AgentType
  terminalTabId: string
  paneKey: string
  ptyId: string | null
  sessionId: string | null
  runtimeEnvironmentId?: string | null
  connectionId?: string | null
  /** The provider can exit while its parent shell keeps the same PTY alive. */
  agentExited?: boolean
  readTerminalScreen?: () => string | null
  readSnapshot?: () => NativeChatStopSnapshot | null
  interactiveSend: NativeChatInteractiveSend
  onInterrupted: () => void
}): {
  stop: () => void
  pending: boolean
  unverified: boolean
  backgroundStopRequested: boolean
  reset: () => void
} {
  const identity = JSON.stringify([
    args.agent,
    args.terminalTabId,
    args.paneKey,
    args.ptyId,
    args.sessionId,
    args.runtimeEnvironmentId ?? null,
    args.connectionId ?? null,
    Boolean(args.agentExited)
  ])
  const latest = useRef({ identity, args })
  // Written after commit, not during render: stop() reads this later to decide whether
  // the pane it captured is still the one on screen, and a render React replayed or
  // discarded would otherwise let it act for a pane the user never landed on.
  useEffect(() => {
    latest.current = { identity, args }
  })
  const active = useRef<AbortController | null>(null)
  const [pending, setPending] = useState(false)
  const [unverified, setUnverified] = useState(false)
  const [backgroundStopRequested, setBackgroundStopRequested] = useState(false)
  const reset = useCallback(() => {
    active.current?.abort()
    active.current = null
    setPending(false)
    setUnverified(false)
    setBackgroundStopRequested(false)
  }, [])
  useLayoutEffect(() => {
    reset()
    return () => {
      active.current?.abort()
      active.current = null
    }
  }, [identity, reset])

  const stop = useCallback(() => {
    if (active.current) {
      return
    }
    const captured = latest.current
    const target = captured.args
    if (target.agentExited) {
      return
    }
    target.interactiveSend.cancelPending()
    if (!target.ptyId || (target.agent === 'codex' && !target.readTerminalScreen)) {
      setUnverified(true)
      return
    }
    const controller = new AbortController()
    active.current = controller
    setPending(true)
    setUnverified(false)
    setBackgroundStopRequested(false)
    const isCurrent = (): boolean =>
      active.current === controller &&
      latest.current.identity === captured.identity &&
      !controller.signal.aborted
    const settle = (outcome: CodexStopOutcome): void => {
      if (!isCurrent()) {
        return
      }
      active.current = null
      setPending(false)
      setUnverified(outcome === 'unverified')
      setBackgroundStopRequested(outcome === 'background-stop-requested')
      if (outcome === 'interrupted' || outcome === 'background-stop-requested') {
        target.onInterrupted()
      }
    }
    try {
      const settings = getSettingsForAgentTabRuntimeOwner(target.terminalTabId)
      const operation =
        target.agent === 'codex'
          ? stopNativeChatCodex({
              settings,
              ptyId: target.ptyId,
              signal: controller.signal,
              readTerminalScreen: () => (isCurrent() ? target.readTerminalScreen!() : null)
            })
          : stopNativeChatTranscript({
              settings,
              ptyId: target.ptyId,
              signal: controller.signal,
              readSnapshot: () =>
                isCurrent() ? (latest.current.args.readSnapshot?.() ?? null) : null
            })
      void operation.then(settle, () => settle('unverified'))
    } catch {
      settle('unverified')
    }
  }, [])
  return { stop, pending, unverified, backgroundStopRequested, reset }
}
