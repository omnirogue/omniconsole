/**
 * Is the agent a person's queued prompt was typed for still running in its terminal?
 *
 * Why: once the agent exits, its pane reads free (an idle shell), and a prompt written there is
 * run as a shell command. Only a positive reading of an agent-less pane refuses; a pane whose
 * processes cannot be read (Windows, a silent SSH owner) is loss of contact, never evidence the
 * agent is gone (`docs/reference/ssh-execution-boundary.md`), and keeps its old delivery.
 */

import type { ConversationSource } from '../../shared/conversation-source'
import type { OrcaRuntimeService } from './omni-runtime'
import type { TerminalAgentProcessProof } from './terminal-agent-process'

export const PROMPT_QUEUE_AGENT_NOT_RUNNING =
  'The agent is not running in this pane, so the prompt was not sent. Start it, then queue the prompt again.'

export type PaneAgentPresence =
  | { kind: 'proven'; proof: TerminalAgentProcessProof }
  | { kind: 'gone' }
  | { kind: 'unverifiable' }

type PresenceRuntime = Pick<
  OrcaRuntimeService,
  'resolveTerminalPane' | 'readTerminalProcessEvidence' | 'assertTerminalAgentProcess'
>

export async function readPaneAgentPresence(
  runtime: PresenceRuntime,
  source: ConversationSource
): Promise<PaneAgentPresence> {
  if (source.kind !== 'pty') {
    return { kind: 'unverifiable' }
  }
  try {
    const { handle } = runtime.resolveTerminalPane(source.paneKey, source.worktreeId)
    const evidence = await runtime.readTerminalProcessEvidence(handle)
    if (evidence?.proof) {
      return { kind: 'proven', proof: evidence.proof }
    }
    return evidence?.tree.kind === 'agent-gone' ? { kind: 'gone' } : { kind: 'unverifiable' }
  } catch {
    // A closed pane is refused by delivery itself, in its own words.
    return { kind: 'unverifiable' }
  }
}

/** Why this prompt must not be written now, or null: re-proven before every terminal write. */
export async function paneAgentRefusal(
  runtime: PresenceRuntime,
  presence: PaneAgentPresence | null
): Promise<string | null> {
  if (presence?.kind === 'gone') {
    return PROMPT_QUEUE_AGENT_NOT_RUNNING
  }
  if (presence?.kind !== 'proven') {
    return null
  }
  try {
    await runtime.assertTerminalAgentProcess(presence.proof, presence.proof.ptyId)
    return null
  } catch {
    return PROMPT_QUEUE_AGENT_NOT_RUNNING
  }
}
