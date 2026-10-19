/**
 * What hook-first answers read from this runtime: the launch it recorded for a pane (sha256 of the
 * launch token it stamped into that PTY), the pane's proven agent pid, and taking back a wake line.
 */

import { conversationSourceRowKey } from '../../shared/conversation-source'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { readPaneAgentPresence } from '../runtime/prompt-queue-agent-presence'
import type { WorkPane } from '../work-delivery/work-delivery-claimer-types'
import type { HolderIdentity } from './answer-inbox'

type PaneRuntime = Pick<
  OrcaRuntimeService,
  | 'resolveTerminalPane'
  | 'getOrchestrationDispatchAuthority'
  | 'readTerminalProcessEvidence'
  | 'assertTerminalAgentProcess'
  | 'readPromptQueue'
  | 'removePromptQueueEntry'
>

/** The launch this runtime recorded for a live pane; null for a pane it did not launch (or lost). */
export function paneLaunchHash(runtime: PaneRuntime, paneKey: string): string | null {
  try {
    const { handle } = runtime.resolveTerminalPane(paneKey)
    return runtime.getOrchestrationDispatchAuthority(handle)?.launchTokenHash ?? null
  } catch {
    return null
  }
}

export async function holderIdentity(
  runtime: PaneRuntime,
  pane: WorkPane
): Promise<HolderIdentity | null> {
  const launchHash = paneLaunchHash(runtime, pane.paneKey)
  if (!launchHash) {
    return null
  }
  const presence = await readPaneAgentPresence(runtime, {
    kind: 'pty',
    worktreeId: pane.worktreeId,
    paneKey: pane.paneKey
  }).catch(() => null)
  // Why hook-report only: that pid is the one the hook script itself reports.
  const agentPid =
    presence?.kind === 'proven' && presence.proof.via === 'hook-report' ? presence.proof.pid : null
  return { paneKey: pane.paneKey, launchHash, agentPid }
}

/** Takes back a prompt still waiting in the queue (never one already being typed). */
export function cancelQueuedPrompt(runtime: PaneRuntime, pane: WorkPane, id: string): void {
  const rowKey = conversationSourceRowKey(pane)
  if (
    runtime.readPromptQueue(rowKey)?.entries.find((entry) => entry.id === id)?.state === 'queued'
  ) {
    runtime.removePromptQueueEntry(rowKey, id)
  }
}

export function answerInboxRuntime(runtime: PaneRuntime) {
  return {
    holderIdentity: (pane: WorkPane) => holderIdentity(runtime, pane),
    cancelQueued: (pane: WorkPane, id: string) => cancelQueuedPrompt(runtime, pane, id)
  }
}
