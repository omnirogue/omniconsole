import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import type { AgentType } from '../../../../shared/agent-status-types'
import { buildCodexResumeRelaunchStartup } from './codex-resume-relaunch-plan'
import { codexResumeRelaunchRefusalCopy } from './codex-resume-relaunch-copy'
import {
  advanceCodexResumeRelaunch,
  attachCodexResumeRelaunchCapture,
  beginCodexResumeRelaunch,
  CODEX_RELAUNCH_STALE_IN_FLIGHT_MS,
  readCodexResumeRelaunch,
  readCodexResumeRelaunchCapture,
  useCodexResumeRelaunchStatus,
  type CodexResumeRelaunchStatus
} from './codex-resume-relaunch-state'
import { mirrorNativeChatSessionOptionCache } from './native-chat-session-option-cache'
import { cancelNativeChatPtySends, waitForNativeChatPtyIdle } from './native-chat-pty-send-queue'
import type { NativeChatPtySessionOptionsSurface } from './native-chat-pty-session-options'
import type { NativeChatSessionOptionRelaunch } from './native-chat-session-option-command-dispatch'

export const CODEX_RELAUNCH_START_TIMEOUT_MS = 10_000
export const CODEX_RELAUNCH_VERIFY_POLL_MS = 300
import {
  CODEX_RELAUNCH_VERIFY_DEADLINE_MS,
  failRelaunch,
  relaunchFailedCopy,
  relaunchUnverifiedCopy,
  settleRelaunchUnverified,
  verifyCodexRelaunchTick,
  type LatestArgs
} from './codex-resume-relaunch-verify'
import { startRelaunchLiveCapture } from './codex-resume-relaunch-live-capture'

export { CODEX_RELAUNCH_VERIFY_DEADLINE_MS }

export function useCodexResumeRelaunch(args: {
  agent: AgentType
  paneKey: string
  terminalTabId: string
  targetPtyId: string | null
  isWorking: boolean
  surface: NativeChatPtySessionOptionsSurface | null
  readTerminalScreen?: () => string | null
}): {
  relaunchSessionOptions: NativeChatSessionOptionRelaunch | undefined
  status: CodexResumeRelaunchStatus | null
} {
  const { agent, paneKey, terminalTabId, targetPtyId, isWorking, surface, readTerminalScreen } =
    args
  const status = useCodexResumeRelaunchStatus(paneKey)
  const latestRef = useRef<LatestArgs>({
    terminalTabId,
    targetPtyId,
    isWorking,
    surface,
    readTerminalScreen
  })
  useLayoutEffect(() => {
    latestRef.current = { terminalTabId, targetPtyId, isWorking, surface, readTerminalScreen }
  }, [terminalTabId, targetPtyId, isWorking, surface, readTerminalScreen])

  const relaunchSessionOptions = useCallback<NativeChatSessionOptionRelaunch>(
    async ({ requested, selectedOption, onCommitted }) => {
      const check = () =>
        buildCodexResumeRelaunchStartup({
          state: useAppStore.getState(),
          paneKey,
          terminalTabId: latestRef.current.terminalTabId,
          ptyId: latestRef.current.targetPtyId,
          isWorking: latestRef.current.isWorking,
          requested
        })
      const first = check()
      if (!first.ok) {
        throw new Error(codexResumeRelaunchRefusalCopy(first.refusal))
      }
      const drainedPtyId = latestRef.current.targetPtyId
      if (drainedPtyId) {
        cancelNativeChatPtySends(drainedPtyId)
        await waitForNativeChatPtyIdle(drainedPtyId)
      }
      // Why re-check: a turn may have started, or the PTY changed, during the drain.
      const built = check()
      const ptyId = latestRef.current.targetPtyId
      if (!built.ok || !ptyId) {
        throw new Error(
          codexResumeRelaunchRefusalCopy(built.ok ? { code: 'no-pty' } : built.refusal)
        )
      }
      beginCodexResumeRelaunch(paneKey, {
        phase: 'restarting',
        requested,
        selectedOption,
        threadId: built.providerSession.id,
        previousPtyId: ptyId,
        startedAt: Date.now()
      })
      onCommitted()
      mirrorNativeChatSessionOptionCache(ptyId, latestRef.current.terminalTabId)
      useAppStore.getState().queueCodexPaneRestarts([ptyId], built.startup)
    },
    [paneKey]
  )

  useEffect(() => {
    if (!status) {
      return
    }
    if (status.phase === 'restarting') {
      if (targetPtyId && targetPtyId !== status.previousPtyId) {
        // Why capture first: the replacement pty is bound now and its shell may
        // already be echoing; the box Codex paints must not be missed.
        attachCodexResumeRelaunchCapture(paneKey, startRelaunchLiveCapture(targetPtyId))
        advanceCodexResumeRelaunch(paneKey, { phase: 'verifying', newPtyId: targetPtyId })
        return
      }
      const elapsed = Date.now() - status.startedAt
      if (elapsed >= CODEX_RELAUNCH_STALE_IN_FLIGHT_MS) {
        settleRelaunchUnverified(paneKey, latestRef.current.surface)
        return
      }
      // Why two timers: "didn't start" is only provable while the restart is still
      // queued. Once an executor has claimed it the spawn is in progress (main's
      // buildSpawnEnv, hook install, provider spawn) and the PTY id flips when it
      // lands, so a claimed restart is judged by the deadline alone — failing it at
      // 10 s would revert the picker while Codex comes up on the new values.
      const startTimer = setTimeout(
        () => {
          if (readCodexResumeRelaunch(paneKey)?.phase !== 'restarting') {
            return
          }
          const store = useAppStore.getState()
          if (!store.consumePendingCodexPaneRestart(status.previousPtyId)) {
            return
          }
          store.takeCodexPaneRestartStartup(status.previousPtyId)
          failRelaunch(
            paneKey,
            latestRef.current.surface,
            translate(
              'components.native-chat.composer.relaunchDidNotStart',
              "The restart didn't start. Try again."
            )
          )
        },
        Math.max(0, CODEX_RELAUNCH_START_TIMEOUT_MS - elapsed)
      )
      const deadlineTimer = setTimeout(
        () => {
          if (readCodexResumeRelaunch(paneKey)?.phase !== 'restarting') {
            return
          }
          failRelaunch(paneKey, latestRef.current.surface, relaunchFailedCopy())
        },
        Math.max(0, CODEX_RELAUNCH_VERIFY_DEADLINE_MS - elapsed)
      )
      return () => {
        clearTimeout(startTimer)
        clearTimeout(deadlineTimer)
      }
    }
    if (status.phase !== 'verifying') {
      return
    }
    if (Date.now() - status.startedAt >= CODEX_RELAUNCH_STALE_IN_FLIGHT_MS) {
      settleRelaunchUnverified(paneKey, latestRef.current.surface)
      return
    }
    const capture = readCodexResumeRelaunchCapture(paneKey)
    if (capture?.ptyId !== status.newPtyId) {
      // Why unverified, not a fresh capture: the bytes from the pty's first
      // moments are gone (module state was reset), and anything read from here
      // on could be replayed transcript rather than the startup box.
      settleRelaunchUnverified(paneKey, latestRef.current.surface)
      toast.warning(relaunchUnverifiedCopy())
      return
    }
    const interval = setInterval(() => {
      if (verifyCodexRelaunchTick(paneKey, latestRef.current, capture)) {
        clearInterval(interval)
      }
    }, CODEX_RELAUNCH_VERIFY_POLL_MS)
    return () => clearInterval(interval)
  }, [paneKey, status, targetPtyId])

  return {
    relaunchSessionOptions: agent === 'codex' ? relaunchSessionOptions : undefined,
    status
  }
}
