import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { stripAnsiEscapeSequences } from '../../../../shared/ansi-escape-sequences'
import { subscribeToPtyData } from '../terminal-pane/pty-data-sidecar-subscriptions'
import { subscribeToRuntimeTerminalData } from '@/runtime/runtime-terminal-stream'
import {
  isRemoteRuntimePtyId,
  sendRuntimePtyInputVerified
} from '@/runtime/runtime-terminal-inspection'
import { typeNativeChatCommand } from './native-chat-runtime-send'
import { cancelRuntimeSessionInputVerified } from '@/runtime/runtime-session-input'
import { cancelNativeChatPtySends, waitForNativeChatPtyIdle } from './native-chat-pty-send-queue'

type RuntimeSettings = Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
export type CodexStopOutcome =
  | 'interrupted'
  | 'background-stop-requested'
  | 'unverified'
  | 'cancelled'
type Subscribe = (watcher: (data: string) => void) => Promise<() => void> | (() => void)

function plain(text: string): string {
  return stripAnsiEscapeSequences(text).replace(/\s+/g, '').toLowerCase()
}

function waitFor(
  predicate: () => boolean,
  signal: AbortSignal,
  timeoutMs: number
): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (matched: boolean): void => {
      if (timer !== null) {
        clearTimeout(timer)
      }
      signal.removeEventListener('abort', cancel)
      resolve(matched)
    }
    const cancel = (): void => finish(false)
    const check = (): void => {
      try {
        if (signal.aborted) {
          finish(false)
        } else if (predicate()) {
          finish(true)
        } else if (Date.now() >= deadline) {
          finish(false)
        } else {
          timer = setTimeout(check, 50)
        }
      } catch {
        finish(false)
      }
    }
    signal.addEventListener('abort', cancel, { once: true })
    check()
  })
}

/** Codex Escape ends its turn; /stop separately terminates its background terminals. */
export async function stopNativeChatCodex(args: {
  settings: RuntimeSettings
  ptyId: string
  signal: AbortSignal
  readTerminalScreen: () => string | null
  subscribeToData?: Subscribe
  interrupt?: () => Promise<boolean>
  stopBackground?: () => Promise<boolean>
  timeoutMs?: number
}): Promise<CodexStopOutcome> {
  let unsubscribe: (() => void) | null = null
  let armed = false
  let observed = ''
  const controller = new AbortController()
  const signal = controller.signal
  let abortReason: 'external' | 'unverified' | null = null
  const disposeSubscription = (): void => {
    const dispose = unsubscribe
    unsubscribe = null
    dispose?.()
  }
  const abort = (reason: 'external' | 'unverified'): void => {
    if (signal.aborted) {
      return
    }
    abortReason = reason
    controller.abort()
  }
  const abortExternal = (): void => abort('external')
  const abortUnverified = (): void => abort('unverified')
  args.signal.addEventListener('abort', abortExternal, { once: true })
  if (args.signal.aborted) {
    abortExternal()
  }
  const timeoutMs = args.timeoutMs ?? 5_000
  const deadline = setTimeout(abortUnverified, Math.max(0, timeoutMs))
  signal.addEventListener('abort', disposeSubscription, { once: true })
  const watcher = (data: string): void => {
    if (armed && !signal.aborted) {
      observed = `${observed}${data}`.slice(-64 * 1024)
    }
  }
  const unavailable = (): CodexStopOutcome =>
    abortReason === 'external' ? 'cancelled' : 'unverified'
  const execute = async (): Promise<CodexStopOutcome> => {
    try {
      if (signal.aborted) {
        return unavailable()
      }
      cancelNativeChatPtySends(args.ptyId)
      const cancelled = await cancelRuntimeSessionInputVerified(args.ptyId, { origin: 'chat' })
      if (signal.aborted || !cancelled) {
        return unavailable()
      }
      await waitForNativeChatPtyIdle(args.ptyId)
      if (signal.aborted) {
        return unavailable()
      }
      unsubscribe = await (args.subscribeToData
        ? args.subscribeToData(watcher)
        : isRemoteRuntimePtyId(args.ptyId)
          ? subscribeToRuntimeTerminalData(
              args.settings,
              args.ptyId,
              `desktop:native-chat-stop:${args.ptyId}`,
              watcher,
              {
                startAtLiveTail: true,
                onEnd: abortUnverified,
                onError: abortUnverified,
                onTransportClose: abortUnverified
              }
            )
          : subscribeToPtyData(args.ptyId, watcher))
      if (signal.aborted) {
        disposeSubscription()
        return unavailable()
      }
      // Replay is ignored; only output after this Stop can acknowledge it.
      armed = true
      const accepted = await (args.interrupt
        ? args.interrupt()
        : sendRuntimePtyInputVerified(args.settings, args.ptyId, '\x1b'))
      if (
        signal.aborted ||
        !accepted ||
        !(await waitFor(
          () => plain(observed).includes('conversationinterrupted'),
          signal,
          timeoutMs
        ))
      ) {
        return unavailable()
      }

      let background = false
      let idleSince = 0
      const readable = await waitFor(
        () => {
          const screen = args.readTerminalScreen()
          if (!screen) {
            idleSince = 0
            return false
          }
          const compact = plain(screen)
          background = /[1-9]\d*backgroundterminals?running/.test(compact)
          if (background) {
            return compact.includes('/stoptoclose')
          }
          const idle = compact.includes('conversationinterrupted') && /(?:^|\n)\s*›/.test(screen)
          idleSince = idle ? idleSince || Date.now() : 0
          // Let the footer paint before concluding that the interrupted turn has no tools left.
          return idleSince > 0 && Date.now() - idleSince >= 500
        },
        signal,
        timeoutMs
      )
      if (!readable || signal.aborted) {
        return unavailable()
      }
      if (!background) {
        return 'interrupted'
      }

      observed = ''
      const stopAccepted = await (args.stopBackground
        ? args.stopBackground()
        : typeNativeChatCommand(args.settings, args.ptyId, '/stop', signal))
      if (
        signal.aborted ||
        !stopAccepted ||
        !(await waitFor(
          () => plain(observed).includes('stoppingallbackgroundterminals.'),
          signal,
          timeoutMs
        ))
      ) {
        return unavailable()
      }
      // This is the provider's request acknowledgment; it is not an OS exit receipt.
      return 'background-stop-requested'
    } catch {
      return unavailable()
    } finally {
      armed = false
      disposeSubscription()
    }
  }
  const aborted = new Promise<CodexStopOutcome>((resolve) => {
    if (signal.aborted) {
      resolve(unavailable())
      return
    }
    signal.addEventListener('abort', () => resolve(unavailable()), { once: true })
  })
  try {
    return await Promise.race([execute(), aborted])
  } finally {
    clearTimeout(deadline)
    args.signal.removeEventListener('abort', abortExternal)
  }
}
