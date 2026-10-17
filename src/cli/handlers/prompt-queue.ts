/**
 * `omni prompt-queue …` — reading the Prompt Queue from a shell.
 *
 * `list` reads the same queue the strip shows, through the same `promptQueue.list`
 * RPC. `add` and `clear` do NOT work from here, and this file says so instead of
 * relaying an authority error:
 *
 * Queuing or unqueuing a prompt is a decision, and the host admits decisions only
 * from the authenticated user interface — the desktop renderer, or a paired
 * mobile/runtime device (`assertSessionOutcomeUser`). The CLI reaches the runtime
 * over the local Unix socket / named pipe, which dispatches with no clientId, no
 * clientKind and no pairedDeviceId (`runtime-rpc-request-admission.ts`), so it can
 * never satisfy that gate. Nor should it fake one: the runtime auth token sits in a
 * file every agent on this machine can read, and the pane environment an agent
 * inherits is identical to the person's, so nothing available here distinguishes
 * "Sal typed this" from "an agent typed this". Measured live on build f6fe7704c1:
 * every add/clear/list returned `This decision requires the authenticated user
 * interface, not an agent assertion.`
 *
 * So the honest CLI is a reader, and the one line it prints for a write points at
 * the interface that IS the person: `/next <prompt>` typed in their own terminal.
 *
 * The conversation defaults to the pane the command is run in: OmniConsole puts
 * `ORCA_PANE_KEY` and `ORCA_WORKTREE_ID` in every pane's environment, which is the
 * same address the UI queues to for that pane.
 */

import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import type { ConversationSource } from '../../shared/conversation-source'
import { promptQueueCommandPreview } from '../../shared/prompt-queue-command'
import {
  PROMPT_QUEUE_RPC,
  promptQueuePending,
  type PromptQueue,
  type PromptQueueEntry
} from '../../shared/prompt-queue-types'

/**
 * What a person gets instead of an authority error. It names the interface that can
 * do it and the exact thing to type there — the only two facts that help.
 */
export const PROMPT_QUEUE_CLI_WRITE_REFUSAL =
  'Queueing needs the app: type /next <prompt> in this terminal.'

type Flags = Map<string, string | boolean>

function conversation(flags: Flags): ConversationSource {
  const paneKey = stringFlag(flags, 'pane') ?? process.env.ORCA_PANE_KEY?.trim()
  const worktreeId = stringFlag(flags, 'worktree') ?? process.env.ORCA_WORKTREE_ID?.trim()
  if (!paneKey || !worktreeId) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Name the conversation with --pane <key> --worktree <id>, or run this inside an OmniConsole pane.'
    )
  }
  // Only a terminal conversation can run a shell, so the CLI addresses that door.
  return { worktreeId, paneKey, kind: 'pty' }
}

function stringFlag(flags: Flags, name: string): string | undefined {
  const value = flags.get(name)
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function describe(entry: PromptQueueEntry, index: number): string {
  return `${index + 1}. ${entry.state} · ${promptQueueCommandPreview(entry.text)}`
}

function formatQueue(queue: PromptQueue): string {
  const pending = promptQueuePending(queue)
  return pending.length
    ? [`Queued ${pending.length}`, ...pending.map(describe)].join('\n')
    : 'Nothing is queued for this conversation.'
}

export const PROMPT_QUEUE_HANDLERS: Record<string, CommandHandler> = {
  // Refused before any call: the host would refuse it, and an authority error is not
  // an answer. Nothing is sent, so nothing can be half-done.
  'prompt-queue add': async () => {
    throw new RuntimeClientError('permission_denied', PROMPT_QUEUE_CLI_WRITE_REFUSAL)
  },
  'prompt-queue clear': async () => {
    throw new RuntimeClientError(
      'permission_denied',
      'Unqueueing needs the app: remove a queued prompt from the strip under the work header, or type /queue clear in this terminal.'
    )
  },
  'prompt-queue list': async ({ flags, client, json }) => {
    const response = await client.call<{ queue: PromptQueue }>(PROMPT_QUEUE_RPC.list, {
      source: conversation(flags)
    })
    printResult(response, json, (result) => formatQueue(result.queue))
  }
}
