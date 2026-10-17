import type { SessionTransferMode, TransferSession } from './session-manage-transfer-contract'
import type { TransferBriefSource } from './session-transfer-brief'
import type { HostMovePlan } from './session-transfer-host-contract'
import { unpushedReason } from './session-transfer-host'

function briefStep(mode: SessionTransferMode, source: TransferSession): string {
  return `Ask “${source.entry.title}” for ${mode === 'handoff' ? 'a handoff brief' : 'a short summary'}.`
}

/** What a transfer will do, in order, as its dry run lists it. */
export function transferSteps(
  mode: SessionTransferMode,
  sources: readonly TransferSession[],
  target: TransferSession | 'new',
  /** What a new target copies; the first source unless every source runs under a host. */
  template: TransferSession | undefined = sources[0]
): string[] {
  return [
    ...sources.map((source) => briefStep(mode, source)),
    target === 'new' && template
      ? `Create a conversation with ${template.entry.agent} in ${template.entry.worktreeId}, folder ${template.entry.folder ?? 'unfiled'}.`
      : target === 'new'
        ? 'Create a conversation.'
        : `Use target “${target.entry.title}”.`,
    'Deliver the brief through continue --prompt.',
    'Wait for the matching finished turn acknowledging the brief.',
    'Point anything waiting on a source at the target.',
    'Only then archive every source; never delete.'
  ]
}

/** The same for a move to another computer: nothing there is created before the briefs exist. */
export function hostMoveSteps(
  mode: SessionTransferMode,
  sources: readonly TransferSession[],
  plan: HostMovePlan,
  title: string
): string[] {
  const where = `${plan.label} (${plan.hostId})`
  const work = sources.map((source, index) => {
    const current = plan.works[index]
    const reason = unpushedReason(current)
    if (current.kind === 'folder') {
      return `“${source.entry.title}” works in a folder; only its brief goes to ${plan.workspace.path}.`
    }
    return reason
      ? `Ask “${source.entry.title}” to commit and push branch ${current.branch} (${reason}), then check git again; refuse if anything is still unpushed.`
      : `“${source.entry.title}” is on branch ${current.branch}, already on ${typeof current.upstream === 'object' ? current.upstream.name : 'its remote'}.`
  })
  return [
    ...work,
    ...sources.map((source) => briefStep(mode, source)),
    `Start ${sources[0].entry.agent} on ${where} in ${plan.workspace.path} as “${title}”, its first prompt the brief, the branch and the acceptance line; file it in ${sources[0].entry.folder ?? 'unfiled'}.`,
    'Wait for its finished reply to be exactly that acceptance line (it confirms it has the work first).',
    `Only then archive every source here (never delete), naming the new session on ${plan.label}. Asking a source turned its Keep going off.`
  ]
}

export function transferTargetTitle(
  mode: SessionTransferMode,
  sources: readonly TransferBriefSource[]
): string {
  return mode === 'handoff'
    ? `${sources[0].entry.title} (continued)`
    : `Consolidated: ${sources[0].entry.title} +${sources.length - 1}`
}

export function transferDryRunSummary(
  mode: SessionTransferMode,
  sources: readonly TransferBriefSource[],
  move: HostMovePlan | null,
  targetTitle: string
): string {
  const into = move
    ? `a new session on ${move.label} in ${move.workspace.path}`
    : `“${targetTitle}”`
  return `Would ${mode} ${sources.map((source) => `“${source.entry.title}”`).join(', ')} into ${into}. Nothing changed.`
}
