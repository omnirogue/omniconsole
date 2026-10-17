import { expect, it } from 'vitest'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeService } from './session-outcome-service'
import { resumeSessionOutcomeWork } from './session-outcome-resume'
import { workflowProofFixture } from './session-outcome-workflow-proof-fixture'

it('explicit Resume retries only unresolved activations without a known Dispatch and preserves retired work', async () => {
  const { workflow } = workflowProofFixture()
  workflow.activations = [
    {
      jobId: 'job_unclaimed',
      state: 'unverifiable',
      error: 'Claim response lost',
      launchDisposition: 'unverifiable'
    },
    {
      jobId: 'job_existing',
      state: 'unverifiable',
      dispatchId: 'ctx_existing',
      error: 'Process unknown'
    },
    { jobId: 'job_started', state: 'started', dispatchId: 'ctx_started', runId: 'run_started' }
  ]
  const retired = { ...structuredClone(workflow), operationId: 'retired', retired: true }
  const chain = {
    steps: [],
    outcomeSet: { workflow, workflowHistory: [retired], attempts: [], outcomes: [], revision: 1 }
  } as unknown as SessionChain
  const service = { save: (next: SessionChain) => next } as unknown as SessionOutcomeService
  const next = await resumeSessionOutcomeWork(service, chain)
  expect(next.outcomeSet!.workflow!.activations[0]).toMatchObject({
    jobId: 'job_unclaimed',
    state: 'requested'
  })
  expect(next.outcomeSet!.workflow!.activations[0]!.error).toBeUndefined()
  expect(next.outcomeSet!.workflow!.activations.slice(1)).toEqual(workflow.activations.slice(1))
  expect(next.outcomeSet!.workflowHistory![0]).toEqual(retired)
})
