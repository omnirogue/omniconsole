import { translate } from '@/i18n/i18n'
import { upNextAddressForPane } from '@/lib/conversation-source-for-pane'
import { upNextConnection } from '@/components/next-action/up-next-connection'
import {
  parsePromptQueueCommand,
  type PromptQueueCommand
} from '../../../../shared/prompt-queue-command'
import { runPromptQueueCommand } from './prompt-queue-command-runner'

export type PromptQueueComposerCommand = (text: string) => boolean

/** One command through the pane's own Up next door; false when the pane has no address yet. */
function runForPane(
  paneKey: string,
  tabId: string,
  command: PromptQueueCommand,
  setDraft: (value: string) => void,
  report: (notice: string) => void
): boolean {
  const address = upNextAddressForPane(paneKey, tabId)
  if (!address) {
    return false
  }
  setDraft('')
  void runPromptQueueCommand(address.source, command, upNextConnection(address.owner)).then(
    (result) => report(result.notice)
  )
  return true
}

/**
 * `/next …` typed in the chat composer.
 *
 * It is the SAME command as in a terminal pane, so it runs the same thing
 * (`runPromptQueueCommand`): the prompt is appended at the head and queued in one go —
 * "Enter queues · same as /next" — and the composer reports what happened to it. Two
 * implementations is how `/next` came to compose a draft here that nothing ever sent.
 */
export function usePromptQueueCommand(
  paneKey: string,
  tabId: string,
  setDraft: (value: string) => void,
  report: (notice: string) => void
): PromptQueueComposerCommand {
  return (text) => {
    const command = parsePromptQueueCommand(text)
    if (!command) {
      return false
    }
    if (!runForPane(paneKey, tabId, command, setDraft, report)) {
      setDraft('')
      report(
        translate(
          'upNext.commandUnavailable',
          'Up next is not available for this conversation yet.'
        )
      )
    }
    return true
  }
}
