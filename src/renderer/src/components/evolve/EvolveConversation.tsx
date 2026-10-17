import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { WorkflowGuideCard } from '../local-workflows/WorkflowGuideCard'
import { EvolveRunView } from './EvolveRunView'
import { EvolveStartForm } from './EvolveStartForm'

/** An Evolve tab: its setup until Start, then the run it started. */
export function EvolveConversation({ tab }: { tab: TerminalTab }) {
  const runId = tab.localWorkflow?.executionId
  return (
    <div className="mx-auto w-full max-w-3xl">
      {runId ? (
        <EvolveRunView tabId={tab.id} runId={runId} />
      ) : (
        <>
          <WorkflowGuideCard kind="evolve" className="mb-4" />
          <EvolveStartForm tab={tab} />
        </>
      )}
    </div>
  )
}
