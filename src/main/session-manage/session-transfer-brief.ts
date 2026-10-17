import type { SessionTransferMode, TransferSession } from './session-manage-transfer-contract'

/** A source as the brief names it; a source on another computer carries only its title. */
export type TransferBriefSource = { entry: Pick<TransferSession['entry'], 'title'> }

/**
 * The brief delivered to the target. Why the fixed opening: a brief is an instruction, so no source
 * title or summary may make it read as a bare approval of the target's own proposal.
 */
export function transferBrief(
  mode: SessionTransferMode,
  sources: readonly TransferBriefSource[],
  briefs: readonly string[],
  note?: string
): string {
  const extra = note?.trim() ? `\n\n${note.trim()}` : ''
  if (mode === 'handoff') {
    return `You are taking over this work from session “${sources[0].entry.title}”. Here is its handoff:\n\n${briefs[0]}${extra}\n\nConfirm you have it and continue with the next step.`
  }
  return `You are taking over the combined work of ${sources.length} sessions. Here are their summaries:\n\n${sources.map((source, index) => `## ${source.entry.title}\n\n${briefs[index]}`).join('\n\n')}${extra}\n\nContinue the combined work. Where these summaries overlap or conflict, say so before acting.`
}
