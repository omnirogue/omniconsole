import { translate } from '@/i18n/i18n'

/** The Spec to draft PR batches dialog's words; kept apart so the dialog stays under max-lines. */
export function specPrBatchCopy() {
  return {
    reviewUnavailable: translate(
      'auto.components.artifacts.specBatch.reviewUnavailable',
      'Review unavailable'
    ),
    title: translate('auto.components.artifacts.specBatch.title', 'Spec to draft PR batches'),
    description: translate(
      'auto.components.artifacts.specBatch.description',
      'Select five approved text specs, confirm their GitHub destinations, then start five independent builders on this computer.'
    ),
    batchStatus: translate('auto.components.artifacts.specBatch.batchStatus', 'Batch status'),
    refresh: translate('auto.components.artifacts.specBatch.refresh', 'Refresh'),
    newBatch: translate('auto.components.artifacts.specBatch.newBatch', 'New batch'),
    stopFutureSteps: translate(
      'auto.components.artifacts.specBatch.stopFutureSteps',
      'Stop future steps'
    ),
    workspacePending: translate(
      'auto.components.artifacts.specBatch.workspacePending',
      'Workspace pending'
    ),
    openWorkspace: translate('auto.components.artifacts.specBatch.openWorkspace', 'Open workspace'),
    openBuilder: translate('auto.components.artifacts.specBatch.openBuilder', 'Open builder'),
    batchManifest: translate('auto.components.artifacts.specBatch.batchManifest', 'Batch manifest'),
    approvedForTarget: translate(
      'auto.components.artifacts.specBatch.approvedForTarget',
      'Approved for this target'
    ),
    needsApproval: translate(
      'auto.components.artifacts.specBatch.needsApproval',
      'Needs exact implementation approval and GitHub target'
    ),
    targetRepository: translate(
      'auto.components.artifacts.specBatch.targetRepository',
      'Target repository'
    ),
    baseBranch: translate('auto.components.artifacts.specBatch.baseBranch', 'Base branch'),
    agentCodex: translate('auto.components.artifacts.specBatch.agentCodex', 'Codex'),
    agentClaude: translate('auto.components.artifacts.specBatch.agentClaude', 'Claude'),
    build: translate('auto.components.artifacts.specBatch.build', 'Build 5 draft PRs'),
    selectFive: translate(
      'auto.components.artifacts.specBatch.selectFive',
      'Select exactly five pages in Artifacts to prepare a new batch.'
    ),
    recentBatches: translate('auto.components.artifacts.specBatch.recentBatches', 'Recent batches'),
    verifiedDraftPrs: (verified: number) =>
      translate(
        'auto.components.artifacts.specBatch.verifiedDraftPrs',
        '{{verified}}/5 verified draft PRs',
        { verified }
      ),
    draftPrs: (verified: number) =>
      translate('auto.components.artifacts.specBatch.draftPrs', '{{verified}}/5 draft PRs', {
        verified
      }),
    openDraftPr: (number: number | string) =>
      translate('auto.components.artifacts.specBatch.openDraftPr', 'Open draft PR #{{number}}', {
        number
      }),
    revision: (revision: number | string) =>
      translate('auto.components.artifacts.specBatch.revision', 'Revision {{revision}}', {
        revision
      }),
    baseBranchFor: (name: string) =>
      translate('auto.components.artifacts.specBatch.baseBranchFor', 'Base branch for {{name}}', {
        name
      })
  }
}
