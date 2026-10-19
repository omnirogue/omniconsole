import { createHash } from 'node:crypto'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { mainConversationInventory } from '../session-host-owner/main-conversation-inventory'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { structuredConversationSource } from '../../shared/conversation-source'
import { deliverToConversation } from '../runtime/conversation-delivery'
import type { TeamPane } from './bridge'

/** This desktop registers only the conversations it owns; remote hosts retain their credentials. */
export function readTeamPanes(runtime: OrcaRuntimeService): TeamPane[] {
  const inventory = runtime.readOwnerConversationInventory()
  if (!inventory) {
    throw new Error('Local conversation inventory is unavailable.')
  }
  const terminal: TeamPane[] = inventory
    ? mainConversationInventory(inventory)
        .conversations.filter((row) => row.listed && row.rest === 'live')
        .map((row) => ({
          id: `${row.worktreeId}:${row.paneKey}:${row.conversation ?? ''}`,
          provider: row.agent,
          name: row.title,
          source: { kind: 'pty' as const, paneKey: row.paneKey, worktreeId: row.worktreeId }
        }))
    : []
  const structured: TeamPane[] = (getStructuredAgentSessionHost()?.listSessionTabs() ?? []).map(
    (tab) => ({
      id: `structured:${tab.sessionId}`,
      provider: tab.agent,
      name: tab.agent,
      source: structuredConversationSource(tab.workspaceId, tab.sessionId)
    })
  )
  return [...terminal, ...structured]
}

export async function assertTeamPaneReady(
  runtime: OrcaRuntimeService,
  pane: TeamPane
): Promise<void> {
  if (pane.source.kind === 'structured') {
    return
  }
  const target = runtime.resolveTerminalPane(pane.source.paneKey, pane.source.worktreeId)
  const evidence = await runtime.readTerminalAgentEvidence(target.handle, pane.provider)
  if (
    !evidence.process ||
    !evidence.screen?.readyPrompt ||
    evidence.screen.working ||
    evidence.screen.blocked
  ) {
    throw new Error('The selected AI is not ready for a new turn.')
  }
}

export async function deliverTeamDirective(
  runtime: OrcaRuntimeService,
  pane: TeamPane,
  text: string,
  operation: string,
  signal: AbortSignal
): Promise<void> {
  const guard = (): void => {
    if (signal.aborted || !readTeamPanes(runtime).some((current) => current.id === pane.id)) {
      throw new Error('OmniSI pane is no longer open.')
    }
  }
  guard()
  let receiver: Parameters<typeof deliverToConversation>[3]['receiver']
  if (pane.source.kind === 'pty') {
    const target = runtime.resolveTerminalPane(pane.source.paneKey, pane.source.worktreeId)
    const evidence = await runtime.readTerminalAgentEvidence(target.handle, pane.provider)
    const proof = evidence.process
    if (
      !proof ||
      !evidence.screen?.readyPrompt ||
      evidence.screen.working ||
      evidence.screen.blocked
    ) {
      throw new Error('The selected AI is not ready for a new turn.')
    }
    receiver = {
      process: proof,
      verify: (ptyId) => runtime.assertTerminalAgentProcess(proof, ptyId)
    }
  }
  await deliverToConversation(runtime, pane.source, text, {
    operationId: operation,
    beforeWrite: guard,
    unattended: true,
    ...(receiver ? { receiver } : {})
  })
}

export function teamReceiptKey(id: string): string {
  return createHash('sha256').update(id).digest('hex')
}
