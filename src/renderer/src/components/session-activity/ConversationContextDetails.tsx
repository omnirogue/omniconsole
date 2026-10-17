import { useMemo } from 'react'
import { translate } from '@/i18n/i18n'
import { isKnownHarnessInjectedUserTurnText } from '../../../../shared/harness-injected-user-turns'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  assistantProse,
  finalAssistantAnswer,
  personWords
} from '../../../../shared/session-handoff-summary'

type ConversationContext = {
  first: { id: string; text: string } | undefined
  latest: { id: string; text: string } | undefined
  update: string | null
}

function conversationContext(messages: readonly NativeChatMessage[]): ConversationContext {
  const instructions = messages.flatMap((message) => {
    if (message.role !== 'user') {
      return []
    }
    const text = assistantProse(message)
    return isKnownHarnessInjectedUserTurnText(text) || !personWords(text)
      ? []
      : [{ id: message.id, text: personWords(text) }]
  })
  const answer = finalAssistantAnswer(messages)
  return {
    first: instructions[0],
    latest: instructions.at(-1),
    update: answer ? assistantProse(answer) : null
  }
}

/**
 * The conversation's recorded words, read-only: the first request, the latest instruction and the
 * latest agent update. It sits inside the Info panel's More disclosure, which is its only fold.
 */
export function ConversationContextDetails({
  messages
}: {
  messages?: readonly NativeChatMessage[]
}): React.JSX.Element | null {
  const context = useMemo(
    () => (messages?.length ? conversationContext(messages) : null),
    [messages]
  )
  if (!context) {
    return null
  }
  const { first, latest, update } = context
  return (
    <div className="space-y-2" data-conversation-context data-conversation-context-content>
      <p className="text-muted-foreground">
        {translate(
          'conversationContext.source',
          'From the loaded conversation history. Agent updates describe progress; they are not independent completion checks.'
        )}
      </p>
      {first ? (
        <ContextExcerpt
          label={translate('conversationContext.firstRequest', 'First recorded request')}
          text={first.text}
        />
      ) : null}
      {latest && latest.id !== first?.id ? (
        <ContextExcerpt
          label={translate('conversationContext.latestInstruction', 'Latest recorded instruction')}
          text={latest.text}
        />
      ) : null}
      {update ? (
        <ContextExcerpt
          label={translate('conversationContext.latestUpdate', 'Latest agent update')}
          text={update}
        />
      ) : null}
    </div>
  )
}

function ContextExcerpt({ label, text }: { label: string; text: string }): React.JSX.Element {
  return (
    <div className="space-y-1">
      <p className="font-medium text-foreground">{label}</p>
      <p className="max-h-40 overflow-auto scrollbar-sleek whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-2 text-foreground">
        {text}
      </p>
    </div>
  )
}
