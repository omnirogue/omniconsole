import { translate } from '@/i18n/i18n'
import type { AssistedBriefGenerateResult } from '../../../../../shared/assisted-brief-contract'
import type { BriefActor } from '../../../../../shared/assisted-brief-types'
import type { BriefWorkspace } from './assisted-brief-workspace'

/** Why drafting cannot run for this workspace, or null when it can. */
export function briefRunnerUnavailableReason(workspace: BriefWorkspace): string | null {
  if (!window.api?.assistedBrief) {
    return translate('assistedBrief.runnerUnavailable', 'Drafting needs the desktop app.')
  }
  if (workspace.paired || !workspace.worktreePath) {
    return translate(
      'assistedBrief.pairedUnavailable',
      'Drafting runs on this computer or an SSH host. Paired-host workspaces can still send directly.'
    )
  }
  return null
}

/** One read-only draft or review, run on the workspace's own computer. */
export async function runBriefGeneration(input: {
  workspace: BriefWorkspace
  actor: BriefActor
  purpose: 'draft' | 'challenge'
  prompt: string
}): Promise<AssistedBriefGenerateResult> {
  const { actor, workspace } = input
  const api = window.api?.assistedBrief
  const unavailable = briefRunnerUnavailableReason(workspace)
  if (unavailable || !api || !workspace.worktreePath) {
    return { ok: false, error: unavailable ?? '' }
  }
  try {
    return await api.generate({
      purpose: input.purpose,
      worktreePath: workspace.worktreePath,
      ...(workspace.connectionId ? { connectionId: workspace.connectionId } : {}),
      agent: actor.agent,
      ...(actor.model ? { model: actor.model } : {}),
      ...(actor.effort ? { effort: actor.effort } : {}),
      ...(actor.accountChoiceId ? { accountChoiceId: actor.accountChoiceId } : {}),
      prompt: input.prompt
    })
  } catch {
    return {
      ok: false,
      error: translate(
        'assistedBrief.runnerFailed',
        'The drafting request did not finish. Try again.'
      )
    }
  }
}

export function cancelBriefGeneration(workspace: BriefWorkspace): void {
  if (!workspace.worktreePath) {
    return
  }
  void window.api?.assistedBrief
    ?.cancel({
      worktreePath: workspace.worktreePath,
      ...(workspace.connectionId ? { connectionId: workspace.connectionId } : {})
    })
    .catch(() => {})
}
