import type { LocalWorkflowCallView, LocalWorkflowView } from '../../../shared/local-workflow-view'
import type { LocalWorkflowStageDefinition } from './local-workflow-council-projection'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import { discoverV7StageDefinitions } from './local-workflow-discover-run'
import { DISCOVER_REVISION } from './workflow-program-revisions'

/** Stage rail for Discover runs; the stage id is the call-id prefix. */
export function discoverStageDefinitions(
  snapshot: LocalWorkflowHostSnapshot,
  results: ReadonlyMap<string, unknown>,
  evidence: Pick<LocalWorkflowView, 'discoverCounts'> | undefined,
  /** Revision 7 only: call states tell a lasting failure from one that will run again. */
  calls: readonly LocalWorkflowCallView[] = []
): LocalWorkflowStageDefinition[] {
  if (snapshot.discoverProgramRevision === DISCOVER_REVISION) {
    return discoverV7StageDefinitions(snapshot, results, calls)
  }
  return [
    {
      id: 'discover',
      label: 'Discover',
      total: snapshot.discover?.dimensions.length,
      summary: 'Inspect the selected dimensions'
    },
    {
      id: 'refute',
      label: 'Refute',
      total: evidence?.discoverCounts?.verdictsTotal,
      summary: 'Independent skeptical verdicts'
    },
    {
      id: 'rank',
      label: 'Synthesize / Rank',
      total: results.has('rank/final') ? 1 : undefined,
      summary: 'Rank surviving findings'
    }
  ]
}
