import { workflowCallCeiling } from '../../../src/main/runtime/workflow-script/workflow-checkpoint-admission'
import {
  createLocalWorkflowDraft,
  type LocalWorkflowDraft
} from '../../../src/shared/local-workflow-draft'

/** The concurrency the frozen-revision baselines ran with; the current default is 6. */
const LEGACY_QUALITY_CONCURRENCY = 4

/**
 * Draft limits for a probe that pins a legacy program revision. Today's defaults size the current
 * programs (13 Council calls, 160 Discover agents), which a legacy revision's call ceiling refuses
 * at Start; these take the pinned revision's own ceiling, with the legacy Discover fields only.
 */
export function legacyQualityDefaults(
  preset: 'council' | 'discover',
  revision: { councilProgramRevision?: number; discoverProgramRevision?: number }
): LocalWorkflowDraft {
  const draft = createLocalWorkflowDraft(preset)
  const callLimit = workflowCallCeiling(preset, revision)
  const { dimensions, lenses, minimumSeverity, maxCandidates } = draft.discover
  return {
    ...draft,
    concurrency: LEGACY_QUALITY_CONCURRENCY,
    callLimit,
    maxHostAttempts: callLimit * draft.attemptLimit,
    discover: { dimensions, lenses, minimumSeverity, maxCandidates }
  }
}
