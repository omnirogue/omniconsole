import type { NativeChatBlock, NativeChatMessage } from '../../../../shared/native-chat-types'
import { translate } from '@/i18n/i18n'

export function chatWorkStage(blocks: readonly NativeChatBlock[]): string {
  const calls = blocks.filter((block) => block.type === 'tool-call')
  const latest = calls.at(-1)
  const description =
    latest?.type === 'tool-call'
      ? `${latest.name} ${(JSON.stringify(latest.input) ?? '').slice(0, 2000)}`
      : ''
  if (/\b(?:test|testing|vitest|playwright|pytest|jest)\b/i.test(description)) {
    return translate('chatActions.testing', 'Testing — Checking the result')
  }
  if (/\b(?:verify|verifying|typecheck|lint|check)\b/i.test(description)) {
    return translate('chatActions.verifying', 'Verifying — Checking the work')
  }
  if (/\b(?:write|edit|patch|build|implement)\b/i.test(description)) {
    return translate('chatActions.building', 'Working — Making changes')
  }
  return latest
    ? translate('chatActions.working', 'Working — Carrying out the task')
    : translate('chatActions.thinking', 'Thinking…')
}

export function currentChatWorkStage(messages: readonly NativeChatMessage[]): string {
  const current: NativeChatBlock[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') {
      break
    }
    current.unshift(...messages[i]!.blocks)
  }
  return chatWorkStage(current)
}
