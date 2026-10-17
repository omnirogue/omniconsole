import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { StructuredCodexLaunchDecision } from '@/lib/structured-codex-launch-decision'

/** Only the turn options Codex accepts at create; everything else stays with the terminal plan. */
export function structuredLaunchOptions(
  sessionOptions: Record<string, unknown> | undefined
): Record<string, string> {
  const options: Record<string, string> = {}
  for (const key of ['model', 'effort'] as const) {
    const value = sessionOptions?.[key]
    if (typeof value === 'string' && value.trim()) {
      options[key] = value.trim()
    }
  }
  return options
}

/** A fallback the person did not configure gets one sentence, not silence. */
export function explainStructuredCodexFallback(
  decision: Extract<StructuredCodexLaunchDecision, { structured: false }>
): void {
  const reasons: Record<typeof decision.reason, string> = {
    agent: translate('components.native-chat.structuredFallback.agent', 'only Codex runs there'),
    'chat-ui-off': translate(
      'components.native-chat.structuredFallback.chatUiOff',
      'Chat UI is off in Settings'
    ),
    'default-view-terminal': translate(
      'components.native-chat.structuredFallback.defaultViewTerminal',
      'the default view is Terminal chat'
    ),
    'structured-off': translate(
      'components.native-chat.structuredFallback.structuredOff',
      'structured chat is off in Settings › Experimental'
    ),
    remote: translate(
      'components.native-chat.structuredFallback.remote',
      'this workspace runs on another computer'
    ),
    wsl: translate('components.native-chat.structuredFallback.wsl', 'this workspace runs in WSL'),
    windows: translate(
      'components.native-chat.structuredFallback.windows',
      'structured chat is not available on Windows yet'
    ),
    'repair-required': translate(
      'components.native-chat.structuredFallback.repairRequired',
      'the local runtime needs repair'
    ),
    'custom-args': translate(
      'components.native-chat.structuredFallback.customArgs',
      'this launch carries its own Codex arguments ({{detail}})',
      { detail: decision.detail ?? '' }
    ),
    'launch-env': translate(
      'components.native-chat.structuredFallback.launchEnv',
      'this launch pins an account environment ({{detail}})',
      { detail: decision.detail ?? '' }
    ),
    'default-args': translate(
      'components.native-chat.structuredFallback.defaultArgs',
      'the configured Codex arguments cannot be applied to the app-server ({{detail}})',
      { detail: decision.detail ?? '' }
    )
  }
  toast.message(
    translate(
      'components.native-chat.structuredFallback.title',
      'Opened as a terminal-backed chat: {{reason}}',
      { reason: reasons[decision.reason] }
    )
  )
}
