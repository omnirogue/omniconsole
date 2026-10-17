import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { subscribeToPtyData } from '../terminal-pane/pty-data-sidecar-subscriptions'
import { isRemoteRuntimePtyId, sendRuntimePtyInput } from '@/runtime/runtime-terminal-inspection'
import { subscribeToRuntimeTerminalData } from '@/runtime/runtime-terminal-stream'
import { NATIVE_CHAT_SUBMIT } from './native-chat-send'
import { stripScrollbackAnsi } from './native-chat-scrape-fallback'
import { ompModelSwitchOutcome } from './omp-model-switch-confirmation'

const DETECTION_TIMEOUT_MS = 5_000
const MAX_OBSERVED_BYTES = 64 * 1024

type SubscribeToData = (watcher: (data: string) => void) => Promise<() => void> | (() => void)

export type NativeChatModelSwitchOutcome =
  | 'applied'
  | 'rejected'
  | 'interaction-required'
  | 'unknown'

export type NativeChatModelSwitchConfirmationObserver = {
  ready: Promise<void>
  result: Promise<NativeChatModelSwitchOutcome>
  arm(): void
  startDetection(): void
  dispose(): void
}

export function hasClaudeModelSwitchConfirmation(buffer: string): boolean {
  const text = compactTerminalText(buffer)
  return (
    text.includes('switchmodel?') && text.includes('thisconversationiscachedforthecurrentmodel')
  )
}

function compactTerminalText(buffer: string): string {
  // Why: Claude positions TUI words with cursor-column escapes instead of
  // emitting literal spaces, so matching must not depend on rendered gaps.
  return stripScrollbackAnsi(buffer).replace(/\s+/g, '').toLowerCase()
}

function hasClaudeModelSwitchSuccess(buffer: string, modelLabel: string): boolean {
  const text = compactTerminalText(buffer)
  const marker = `setmodelto${modelLabel.replace(/\s+/g, '').toLowerCase()}`
  if (text.includes(marker)) {
    return true
  }
  // Why: resolved echoes insert a version ("Opus 5 (1M context)"); retaining
  // every picker token prevents one context variant from confirming another.
  const labelTokens = modelLabel.toLowerCase().match(/[a-z]+|\d+[a-z]*/g) ?? []
  const successStart = text.lastIndexOf('setmodelto')
  if (successStart === -1 || labelTokens.length === 0) {
    return false
  }
  const successText = text.slice(successStart)
  let tokenEnd = 0
  for (const token of labelTokens) {
    const tokenStart = successText.indexOf(token, tokenEnd)
    if (tokenStart === -1) {
      return false
    }
    tokenEnd = tokenStart + token.length
  }
  return true
}

function hasClaudeModelSwitchRejection(buffer: string): boolean {
  return compactTerminalText(buffer).includes('keptmodelas')
}

function hasClaudeModelSwitchInteraction(buffer: string): boolean {
  const text = compactTerminalText(buffer)
  return (
    text.includes('fable5usesusagecreditsandneedsaone-timeconsent') ||
    text.includes('pickfablefrom/modelinaninteractivesessiontosetitup') ||
    (text.includes('switchtofable5?') && text.includes('usagecredits'))
  )
}

function subscribeToNativeChatModelSwitchData(args: {
  ptyId: string
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
  subscribeToData?: SubscribeToData
  watcher: (data: string) => void
}): Promise<() => void> | (() => void) {
  if (args.subscribeToData) {
    return args.subscribeToData(args.watcher)
  }
  if (isRemoteRuntimePtyId(args.ptyId)) {
    return subscribeToRuntimeTerminalData(
      args.settings,
      args.ptyId,
      `desktop:native-chat-model-switch:${args.ptyId}`,
      args.watcher,
      { startAtLiveTail: true }
    )
  }
  return subscribeToPtyData(args.ptyId, args.watcher)
}

export function createNativeChatModelSwitchConfirmationObserver(args: {
  ptyId: string
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
  expectedModelLabel: string | null
  expectedOmpModelId?: string
  expectedEffortLevel?: string
  subscribeToData?: SubscribeToData
  submitConfirmation?: () => boolean | void
  timeoutMs?: number
}): NativeChatModelSwitchConfirmationObserver {
  let armed = false
  let settled = false
  let confirmationSubmitted = false
  let observed = ''
  let timeout: ReturnType<typeof setTimeout> | null = null
  let unsubscribe: (() => void) | null = null
  let resolveResult!: (outcome: NativeChatModelSwitchOutcome) => void
  let resolveReady!: () => void
  const result = new Promise<NativeChatModelSwitchOutcome>((resolve) => {
    resolveResult = resolve
  })
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })

  const finish = (outcome: NativeChatModelSwitchOutcome): void => {
    if (settled) {
      return
    }
    settled = true
    if (timeout !== null) {
      clearTimeout(timeout)
      timeout = null
    }
    unsubscribe?.()
    unsubscribe = null
    resolveResult(outcome)
  }

  const scheduleTimeout = (): void => {
    if (timeout !== null) {
      clearTimeout(timeout)
    }
    timeout = setTimeout(() => finish('unknown'), args.timeoutMs ?? DETECTION_TIMEOUT_MS)
  }

  const observeData = (data: string): void => {
    if (!armed || settled) {
      return
    }
    observed = `${observed}${data}`.slice(-MAX_OBSERVED_BYTES)
    if (args.expectedOmpModelId) {
      const outcome = ompModelSwitchOutcome(observed, args.expectedOmpModelId)
      if (outcome) {
        finish(outcome)
      }
      return
    }
    const effort = args.expectedEffortLevel?.toLowerCase()
    const text = compactTerminalText(observed)
    const success = effort
      ? text.includes(`seteffortlevelto${effort}`)
      : args.expectedModelLabel && hasClaudeModelSwitchSuccess(observed, args.expectedModelLabel)
    if (success) {
      finish('applied')
      return
    }
    if (effort ? text.includes('kepteffortlevelas') : hasClaudeModelSwitchRejection(observed)) {
      finish('rejected')
      return
    }
    if (hasClaudeModelSwitchInteraction(observed)) {
      finish('interaction-required')
      return
    }
    const confirmation = effort
      ? text.includes('changeeffortlevel?') &&
        text.includes('thisconversationiscachedforthecurrenteffortlevel') &&
        text.includes(`yes,switchto${effort}`)
      : hasClaudeModelSwitchConfirmation(observed)
    if (!confirmationSubmitted && confirmation) {
      confirmationSubmitted = true
      try {
        // Why: the picker selection already expresses consent to switch; this
        // exact Claude warning defaults to “Yes” and needs only one Enter.
        const accepted = args.submitConfirmation
          ? args.submitConfirmation() !== false
          : sendRuntimePtyInput(args.settings, args.ptyId, NATIVE_CHAT_SUBMIT)
        if (!accepted) {
          finish('unknown')
          return
        }
        scheduleTimeout()
      } catch {
        finish('unknown')
      }
    }
  }

  try {
    const subscription = subscribeToNativeChatModelSwitchData({
      ptyId: args.ptyId,
      settings: args.settings,
      subscribeToData: args.subscribeToData,
      watcher: observeData
    })
    void Promise.resolve(subscription)
      .then((dispose) => {
        if (settled) {
          dispose()
        } else {
          unsubscribe = dispose
        }
      })
      .catch(() => finish('unknown'))
      .finally(resolveReady)
  } catch {
    finish('unknown')
    resolveReady()
  }

  return {
    ready,
    result,
    arm: () => {
      if (settled || armed) {
        return
      }
      armed = true
    },
    startDetection: () => {
      // Why: measure the detection window from when the command is actually
      // delivered, not from arm(). On SSH/remote the body+Enter round-trips can
      // otherwise burn the timeout before the agent has even responded, turning
      // a successful switch into a false "could not verify the model change".
      if (settled) {
        return
      }
      scheduleTimeout()
    },
    dispose: () => finish('unknown')
  }
}
