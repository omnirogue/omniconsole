import type { OrcaRuntimeService } from './omni-runtime'
import type { TerminalAgentProcessProof } from './terminal-agent-process'
import { readScreenEvidence, type TerminalAgentEvidence } from './terminal-agent-evidence'

type EvidenceOwner = Pick<
  OrcaRuntimeService,
  | 'readTerminalAgentForeground'
  | 'readTerminalProcessEvidence'
  | 'readTerminal'
  | 'getTerminalPaneKey'
  | 'getTerminalProcessIncarnation'
  | 'getLastAgentHookRowForPane'
  | 'getFreshAgentHookStatusForHandle'
  | 'getReportedProviderSessionsForPane'
  | 'assertTerminalAgentProcess'
>

function completedCodexTurn(
  owner: EvidenceOwner,
  handle: string,
  proof?: TerminalAgentProcessProof
) {
  const paneKey = owner.getTerminalPaneKey(handle)
  const row = paneKey ? owner.getLastAgentHookRowForPane(paneKey) : null
  const fresh = owner.getFreshAgentHookStatusForHandle(handle)
  const provider = paneKey ? owner.getReportedProviderSessionsForPane(paneKey)[0] : null
  const incarnation = owner.getTerminalProcessIncarnation(handle)
  if (
    (proof && proof.agent !== 'codex') ||
    !incarnation ||
    !row ||
    !fresh ||
    row.connectionId !== null ||
    row.paneKey !== paneKey ||
    row.agentType !== 'codex' ||
    typeof row.agentPid !== 'number' ||
    !Number.isSafeInteger(row.agentPid) ||
    row.agentPid < 2 ||
    fresh.agentPid !== row.agentPid ||
    (proof && row.agentPid !== proof.pid) ||
    row.state !== 'done' ||
    fresh.state !== 'done' ||
    row.restoredUnconfirmed ||
    row.failed ||
    row.interrupted ||
    row.sessionBoundary ||
    row.interactivePrompt ||
    row.lastAssistantMessageIsToolOutput ||
    fresh.failed ||
    fresh.interrupted ||
    fresh.sessionBoundary ||
    fresh.interactivePrompt ||
    !Number.isFinite(row.stateStartedAt) ||
    row.stateStartedAt <= 0 ||
    (proof && row.stateStartedAt < proof.startTimeMs) ||
    !row.lastAssistantMessage?.trim() ||
    fresh.lastAssistantMessage !== row.lastAssistantMessage ||
    !provider?.id ||
    provider.id !== row.providerSession?.id ||
    provider.key !== row.providerSession.key
  ) {
    return null
  }
  return {
    reporter: { pid: row.agentPid, completedAt: row.stateStartedAt, incarnation },
    fingerprint: JSON.stringify([
      incarnation,
      row.paneKey,
      row.agentPid,
      provider.key,
      provider.id,
      row.stateStartedAt,
      row.turnCompletedAt,
      row.prompt,
      row.lastAssistantMessage,
      fresh.stateStartedAt,
      fresh.prompt
    ])
  }
}

/** Keep a completed hook correlated across the asynchronous process/screen reads. */
export async function collectTerminalAgentEvidence(
  owner: EvidenceOwner,
  handle: string,
  expectedAgent: string | null | undefined,
  detectors: Parameters<typeof readScreenEvidence>[1]
): Promise<TerminalAgentEvidence> {
  const foreground = await owner.readTerminalAgentForeground(handle, expectedAgent)
  const candidate = completedCodexTurn(owner, handle)
  const processes = await owner
    .readTerminalProcessEvidence(handle, candidate?.reporter)
    .catch(() => null)
  const proof = processes?.proof
  const completionProof = processes?.completionProof ?? proof
  const before = completionProof ? completedCodexTurn(owner, handle, completionProof) : null
  const read = await owner.readTerminal(handle, { screen: true }).catch(() => null)
  let completedCodexReply: string | null = null
  if (
    before &&
    before.fingerprint === candidate?.fingerprint &&
    completionProof &&
    read?.source === 'screen'
  ) {
    const stillOwns = await owner
      .assertTerminalAgentProcess(completionProof, completionProof.ptyId)
      .then(
        () => true,
        () => false
      )
    if (
      stillOwns &&
      completedCodexTurn(owner, handle, completionProof)?.fingerprint === before.fingerprint
    ) {
      completedCodexReply =
        owner.getFreshAgentHookStatusForHandle(handle)?.lastAssistantMessage ?? null
    }
  }
  return {
    foreground,
    process: proof ?? null,
    tree: processes?.tree ?? null,
    screen:
      read?.source === 'screen'
        ? readScreenEvidence(read.tail, detectors, completedCodexReply, read.screenDecorations)
        : null
  }
}
