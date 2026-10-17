import { translate } from '@/i18n/i18n'
import type { ConversationSource } from '../../../../shared/conversation-source'
import type { PromptQueueCommand } from '../../../../shared/prompt-queue-command'
import { UP_NEXT_RPC, UP_NEXT_WRITE_UNAVAILABLE } from '../../../../shared/up-next-types'
import { readUpNext, writeUpNext } from '@/components/next-action/up-next-client'
import {
  LOCAL_UP_NEXT_CONNECTION,
  type UpNextConnection
} from '@/components/next-action/up-next-connection'
import {
  upNextStatedRuleKey,
  upNextUnmappedMessage
} from '@/components/next-action/up-next-refusal'

export type PromptQueueCommandReport = {
  /** What the pane echoes: the chain, exactly as `/queue` prints it. */
  lines: string[]
  /** The one sentence a composer shows as its notice. */
  notice: string
  /** True when the prompt is queued and waiting for this agent to be free. */
  queued: boolean
}
export function promptQueueCommandHint(): string {
  return translate('upNext.commandHint', 'Type /next <prompt> to add a prompt to Up next')
}

/**
 * A refusal the host stated as a rule is said in the person's own language, not as its
 * key — from BOTH catalogs the engine throws (an ordering refusal and a reason an add is
 * off, e.g. a finished session), or a pane would print `upNext.addDisabled.sessionClosed`
 * at the person. A failure that states no catalog rule still carries a host-authored
 * sentence on some paths; that is shown as-is, never a raw unmapped key or a blank line.
 */
function said(failure: unknown): string {
  const stated = upNextStatedRuleKey(failure)
  if (stated) {
    return translate(stated, stated)
  }
  return (
    upNextUnmappedMessage(failure) ??
    translate('upNext.writeUnavailable', UP_NEXT_WRITE_UNAVAILABLE)
  )
}

/** Terminal commands share the same host door as useUpNext; there is no React tree here. */
export async function runPromptQueueCommand(
  source: ConversationSource,
  command: PromptQueueCommand,
  connection: UpNextConnection = LOCAL_UP_NEXT_CONNECTION
): Promise<PromptQueueCommandReport> {
  try {
    let view = await readUpNext(source, connection)
    const write = async (method: string, params: Record<string, unknown>) => {
      await writeUpNext(
        source,
        method,
        params,
        (next) => {
          view = next
        },
        connection
      )
    }
    let notice = ''
    let queued = false
    if (command.kind === 'add') {
      // `/next …` IS `+ Prompt` and Enter: the prompt goes to the head and is QUEUED in the
      // same breath. It names the one block it just wrote, so the blocks the person is still
      // composing beside it stay theirs to send.
      const before = new Set(view.blocks.map((block) => block.id))
      const when = view.header.state === 'idle' ? ('now' as const) : ('after' as const)
      await write(UP_NEXT_RPC.append, {
        position: 'head',
        draft: { kind: 'prompt', text: command.text, when }
      })
      const added = view.blocks.find(
        (block) => !before.has(block.id) && block.kind === 'prompt' && block.text === command.text
      )
      if (added) {
        await write(UP_NEXT_RPC.commit, { blockIds: [added.id] })
        // A prompt sent into a free agent is already gone; only a waiting one is "queued".
        queued = when === 'after'
        notice = queued
          ? translate(
              'upNext.commandQueued',
              'Prompt queued; it goes to this agent as soon as it is free.'
            )
          : translate('upNext.commandSent', 'Prompt sent to the agent now.')
      } else {
        // The host took the prompt but does not show it: it is composed, not queued, and
        // saying so is better than claiming a delivery nobody can point at.
        notice = translate(
          'upNext.commandAdded',
          'Prompt added to Up next; review and queue it there.'
        )
      }
    } else if (command.kind === 'clear') {
      for (const block of view.blocks.filter(
        (item) => item.kind === 'prompt' && !item.locked && ['queued', 'draft'].includes(item.state)
      )) {
        await write(UP_NEXT_RPC.remove, { blockId: block.id })
      }
    }
    const chain = view.notation || translate('upNext.empty', 'Nothing queued.')
    return { lines: [chain], notice: notice || chain, queued }
  } catch (failure) {
    const refused = said(failure)
    return { lines: [refused], notice: refused, queued: false }
  }
}
