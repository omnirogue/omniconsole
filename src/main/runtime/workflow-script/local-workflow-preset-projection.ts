import type { LocalWorkflowCallView, LocalWorkflowView } from '../../../shared/local-workflow-view'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import { projectCouncilRun } from './local-workflow-council-projection'
import { projectDiscoverRun } from './local-workflow-discover-projection'

export function projectPresetRun(
  snapshot: LocalWorkflowHostSnapshot,
  preset: LocalWorkflowView['preset'],
  results: Map<string, unknown>,
  calls: LocalWorkflowCallView[],
  state: LocalWorkflowView['state']
): Pick<LocalWorkflowView, 'audit' | 'councilRun' | 'discoverRun'> {
  if (snapshot.audit) {
    return {
      audit: {
        version: 1,
        sourceCount: snapshot.audit.corpus.sources.length,
        chunkCount: snapshot.audit.corpus.chunks.length
      }
    }
  }
  return preset === 'council'
    ? { councilRun: projectCouncilRun(snapshot, results, calls) }
    : {
        // A settled run leaves unlanded votes unverified.
        discoverRun: projectDiscoverRun(
          snapshot,
          results,
          calls,
          ['completed', 'cancelled', 'failed', 'recovery_required'].includes(state)
        )
      }
}
