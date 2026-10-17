/**
 * Which failed deliveries provably moved nothing. A sender that must never repeat itself (a
 * reviewer's notes to the agent) sends again only after one of these; any failure after the
 * first write began may have reached the agent, and stays final.
 */
import { describe, expect, it } from 'vitest'
import type { ConversationSource } from '../../shared/conversation-source'
import { deliverToConversation } from './conversation-delivery'
import { ConversationNotSentError } from './conversation-delivery-not-sent'
import { GUARDED_WRITE_FENCE_REVOKED } from '../pty/guarded-pty-write'
import type { OrcaRuntimeService } from './omni-runtime'

const PANE: ConversationSource = { worktreeId: 'wt', paneKey: 'tab-1:leaf-1', kind: 'pty' }

type SendOptions = {
  beforeWrite?: (ptyId: string) => void | Promise<void>
  afterWrite?: (ptyId: string) => void
}

/** A terminal door whose submission does what the test says. */
function door(send: (options: SendOptions) => Promise<void>, open = true): OrcaRuntimeService {
  return {
    resolveTerminalPane: () => {
      if (!open) {
        throw new Error('terminal_not_found')
      }
      return { handle: 'term-1' }
    },
    sendTerminalAgentPrompt: async (_handle: string, _text: string, options: SendOptions) =>
      send(options)
  } as unknown as OrcaRuntimeService
}

const failure = (runtime: OrcaRuntimeService, source = PANE): Promise<unknown> =>
  deliverToConversation(runtime, source, 'Tighten the intro.', { operationId: 'op-1' }).then(
    () => null,
    (error: unknown) => error
  )

describe('a delivery that failed', () => {
  it('moved nothing when the pane was gone or refused before its first write', async () => {
    const gone = await failure(door(async () => {}, false))
    expect(gone).toBeInstanceOf(ConversationNotSentError)
    expect((gone as Error).message).toBe('This terminal conversation is no longer open.')

    const unwritable = await failure(
      door(async () => {
        throw new Error('terminal_not_writable')
      })
    )
    expect(unwritable).toBeInstanceOf(ConversationNotSentError)
    // The same words the person's queue has always shown.
    expect((unwritable as Error).message).toBe('terminal_not_writable')
  })

  it('may have reached the agent once a write began, so it is not retried as unsent', async () => {
    const midway = await failure(
      door(async (options) => {
        await options.beforeWrite?.('pty-1')
        throw new Error('terminal_handle_stale')
      })
    )
    expect(midway).toBeInstanceOf(Error)
    expect(midway).not.toBeInstanceOf(ConversationNotSentError)
    expect((midway as Error).message).toBe('terminal_handle_stale')
  })

  it('moved nothing when the write guard refused before any byte landed', async () => {
    const refused = await failure(
      door(async (options) => {
        await options.beforeWrite?.('pty-1')
        throw new Error(GUARDED_WRITE_FENCE_REVOKED)
      })
    )
    expect(refused).toBeInstanceOf(ConversationNotSentError)
    expect((refused as Error).message).toBe(GUARDED_WRITE_FENCE_REVOKED)
  })

  it('may have reached the agent when the guard refused after bytes landed', async () => {
    const partly = await failure(
      door(async (options) => {
        await options.beforeWrite?.('pty-1')
        options.afterWrite?.('pty-1')
        await options.beforeWrite?.('pty-1')
        throw new Error(GUARDED_WRITE_FENCE_REVOKED)
      })
    )
    expect(partly).toBeInstanceOf(Error)
    expect(partly).not.toBeInstanceOf(ConversationNotSentError)
  })

  it('moved nothing when the chat session was gone before anything was asked of it', async () => {
    const chat: ConversationSource = {
      worktreeId: 'wt',
      paneKey: 'agent-session:s1',
      kind: 'structured',
      sessionId: 's1'
    }
    const gone = await failure(
      door(async () => {}),
      chat
    )
    expect(gone).toBeInstanceOf(ConversationNotSentError)
    expect((gone as Error).message).toBe('This chat conversation is no longer open.')
  })
})
