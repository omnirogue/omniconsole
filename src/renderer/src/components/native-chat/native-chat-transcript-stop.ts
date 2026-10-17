import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  isInterruptedStatusMessage,
  type NativeChatMessage,
  type NativeChatTurnLifecycle
} from '../../../../shared/native-chat-types'
import { sendRuntimePtyInputVerified } from '@/runtime/runtime-terminal-inspection'
import { cancelRuntimeSessionInputVerified } from '@/runtime/runtime-session-input'
import { cancelNativeChatPtySends, waitForNativeChatPtyIdle } from './native-chat-pty-send-queue'

export type NativeChatStopSnapshot = {
  messages: NativeChatMessage[]
  transcriptLifecycle?: NativeChatTurnLifecycle
}

export type NativeChatTranscriptStopOutcome = 'interrupted' | 'unverified' | 'cancelled'

function lastUserId(snapshot: NativeChatStopSnapshot): string | null {
  return snapshot.messages.findLast((message) => message.role === 'user')?.id ?? null
}

function interruptionObserved(
  baseline: NativeChatStopSnapshot,
  current: NativeChatStopSnapshot
): boolean {
  const tail = baseline.messages.at(-1)
  const tailIndex = tail ? current.messages.findIndex((message) => message.id === tail.id) : -1
  const knownIds = new Set(baseline.messages.map((message) => message.id))
  // Paging in an old interruption must not acknowledge this request.
  if (
    tailIndex >= 0 &&
    current.messages
      .slice(tailIndex + 1)
      .some(
        (message) =>
          !knownIds.has(message.id) &&
          message.source === 'transcript' &&
          isInterruptedStatusMessage(message)
      )
  ) {
    return true
  }
  const before = baseline.transcriptLifecycle
  const after = current.transcriptLifecycle
  if (
    after?.state !== 'interrupted' ||
    (before?.state === after.state &&
      before.turnId === after.turnId &&
      before.timestamp === after.timestamp)
  ) {
    return false
  }
  const boundaryTime = Math.max(before?.timestamp ?? 0, tail?.timestamp ?? 0)
  if (after.timestamp != null && boundaryTime > 0) {
    return after.timestamp >= boundaryTime
  }
  // Without timestamps, only the same explicit provider turn can establish order.
  return before?.state === 'working' && before.turnId === after.turnId
}

/** A host-accepted Escape requests Stop; a fresh provider boundary confirms it. */
export function stopNativeChatTranscript(args: {
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
  ptyId: string
  signal: AbortSignal
  readSnapshot: () => NativeChatStopSnapshot | null
  timeoutMs?: number
}): Promise<NativeChatTranscriptStopOutcome> {
  return new Promise((resolve) => {
    let finished = false
    let deadline: ReturnType<typeof setTimeout> | null = null
    let poll: ReturnType<typeof setTimeout> | null = null
    const finish = (outcome: NativeChatTranscriptStopOutcome): void => {
      if (finished) {
        return
      }
      finished = true
      if (deadline !== null) {
        clearTimeout(deadline)
      }
      if (poll !== null) {
        clearTimeout(poll)
      }
      args.signal.removeEventListener('abort', onAbort)
      resolve(outcome)
    }
    const onAbort = (): void => finish('cancelled')
    args.signal.addEventListener('abort', onAbort, { once: true })
    if (args.signal.aborted) {
      onAbort()
      return
    }
    deadline = setTimeout(() => finish('unverified'), args.timeoutMs ?? 5_000)

    const execute = async (): Promise<void> => {
      const baseline = args.readSnapshot()
      if (!baseline) {
        finish('unverified')
        return
      }
      const readCurrent = (): NativeChatStopSnapshot | null => {
        const current = args.readSnapshot()
        if (!current) {
          finish('unverified')
          return null
        }
        if (lastUserId(current) !== lastUserId(baseline)) {
          finish('cancelled')
          return null
        }
        return current
      }
      cancelNativeChatPtySends(args.ptyId)
      const cancelled = await cancelRuntimeSessionInputVerified(args.ptyId, { origin: 'chat' })
      if (finished) {
        return
      }
      if (!cancelled) {
        finish('unverified')
        return
      }
      await waitForNativeChatPtyIdle(args.ptyId)
      if (finished) {
        return
      }
      const current = readCurrent()
      if (!current) {
        return
      }
      if (interruptionObserved(baseline, current)) {
        finish('interrupted')
        return
      }
      const accepted = await sendRuntimePtyInputVerified(args.settings, args.ptyId, '\x1b', {
        requireAcceptance: true
      })
      if (finished) {
        return
      }
      if (!accepted) {
        finish('unverified')
        return
      }
      const observe = (): void => {
        if (finished) {
          return
        }
        try {
          const snapshot = readCurrent()
          if (!snapshot) {
            return
          }
          if (interruptionObserved(baseline, snapshot)) {
            finish('interrupted')
          } else {
            poll = setTimeout(observe, 50)
          }
        } catch {
          finish('unverified')
        }
      }
      observe()
    }
    void execute().catch(() => finish('unverified'))
  })
}
