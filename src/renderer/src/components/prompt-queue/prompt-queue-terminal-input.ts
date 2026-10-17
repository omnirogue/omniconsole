/**
 * `/next …` typed in a terminal pane.
 *
 * ONE reader on the xterm data path (`pty-input-forward.ts` → `forwardPtyInput`).
 * It answers a single question per chunk: "is this the Enter that ends a `/next`
 * command?" Everything else returns false and is forwarded byte for byte, which is
 * the only acceptable default for a terminal — a person's keystrokes are not ours
 * to reinterpret.
 *
 * When it IS the command: the Enter is swallowed (so nothing is submitted), the
 * characters the person typed are taken back out of the agent's input box with
 * exactly as many backspaces, and the answer is written into the pane locally.
 * The queue itself is reached through the same RPCs the strip uses.
 *
 * "The Enter that ends the line" is whatever door delivered it — a real keypress
 * (`\r`, or its kitty encoding when the agent negotiated one) and the accessible
 * "Terminal input", which writes the line and its Enter as a single value. Both
 * end in this one runner; neither reaches the PTY. `omni terminal send` is the
 * documented exception: it writes to the PTY in the main process and so is not
 * read here at all.
 */

import { translate } from '@/i18n/i18n'
import type { UpNextAddress } from '@/lib/up-next-address'
import { upNextConnection } from '@/components/next-action/up-next-connection'
import {
  emptyTypedTerminalLine,
  observeTypedTerminalInput,
  parsePromptQueueCommand,
  promptQueueCommandErase,
  type TypedTerminalLine
} from '../../../../shared/prompt-queue-command'
import { runPromptQueueCommand } from './prompt-queue-command-runner'

export type PromptQueueTerminalInputDeps = {
  /** The conversation this pane is; null when it cannot be addressed yet. */
  address: () => UpNextAddress | null
  /** False for a plain shell — the prompt still queues, and the answer says so. */
  hasAgentSession: () => boolean
  /** Bytes for the PTY that only take back what the person typed. */
  erase: (data: string) => void
  /** Lines shown in this pane only; they never reach the shell. */
  echo: (lines: string[]) => void
}

/** True when the chunk was the command's Enter and must not reach the PTY. */
export type PromptQueueTerminalInput = (data: string) => boolean

export function createPromptQueueTerminalInput(
  deps: PromptQueueTerminalInputDeps
): PromptQueueTerminalInput {
  let typed: TypedTerminalLine = emptyTypedTerminalLine()
  return (data: string): boolean => {
    const observed = observeTypedTerminalInput(typed, data)
    typed = observed.state
    const line = observed.committed
    const command = line ? parsePromptQueueCommand(line) : null
    if (!line || !command) {
      return false
    }
    // Only ever as many backspaces as the agent's box actually holds: a line written
    // in one go never reached it, so nothing is taken back.
    const erase = promptQueueCommandErase(observed.echoed)
    if (erase) {
      deps.erase(erase)
    }
    const address = deps.address()
    if (!address) {
      deps.echo([
        translate(
          'promptQueue.commandNoConversation',
          'This pane cannot hold a prompt queue yet — open it and try again.'
        )
      ])
      return true
    }
    const waitsForIdle = command.kind === 'add' && !deps.hasAgentSession()
    void runPromptQueueCommand(address.source, command, upNextConnection(address.owner)).then(
      (report) =>
        deps.echo(
          waitsForIdle && report.queued
            ? [
                ...report.lines,
                translate(
                  'promptQueue.commandNoAgent',
                  'No agent is running here. Start one first, or the prompt is refused rather than typed into the shell.'
                )
              ]
            : report.lines
        )
    )
    return true
  }
}
