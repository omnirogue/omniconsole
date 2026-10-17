import { validateCouncilBallot } from './presets/council'
import { validateDiscoverClusters } from './presets/discover-clustering'
import { validateDiscoverRanking, validateFindingVote } from './presets/discover-assessment'
import { validateDiscoverReviewedRanking } from './presets/discover-reviewed-ranking'
import type { WorkflowProgramSemanticContract } from './workflow-program-context'

/** The exact semantic check must be durable because worker_done cannot precede it. */
export function workingAgentSemanticProblem(
  contract: WorkflowProgramSemanticContract,
  value: unknown
): string | null {
  switch (contract.kind) {
    case 'none':
      return null
    case 'council-ballot':
      return validateCouncilBallot(value, contract.expectedLabels)
    case 'discover-clusters':
      return validateDiscoverClusters(
        value,
        contract.expectedIds.map((id) => ({ id })) as Parameters<typeof validateDiscoverClusters>[1]
      )
    case 'discover-vote':
      return validateFindingVote(value)
    case 'discover-ranking':
      return validateDiscoverRanking(
        value,
        contract.expectedIds.map((id) => ({ id }))
      )
    case 'discover-reviewed-ranking':
      return validateDiscoverReviewedRanking(value, contract.survivors)
  }
}

export function assertWorkingAgentSemanticContract(
  value: WorkflowProgramSemanticContract | undefined
): asserts value is WorkflowProgramSemanticContract {
  if (
    !value ||
    ![
      'none',
      'council-ballot',
      'discover-clusters',
      'discover-vote',
      'discover-ranking',
      'discover-reviewed-ranking'
    ].includes(value.kind)
  ) {
    throw new Error('Working-agent call requires a supported durable semantic contract')
  }
  if (
    'expectedLabels' in value &&
    (!Array.isArray(value.expectedLabels) ||
      value.expectedLabels.length !== 2 ||
      new Set(value.expectedLabels).size !== 2 ||
      value.expectedLabels.some((label) => !/^Response [A-C]$/.test(label)))
  ) {
    throw new Error('Invalid Council ballot labels')
  }
  if (
    'expectedIds' in value &&
    (!Array.isArray(value.expectedIds) ||
      !value.expectedIds.length ||
      new Set(value.expectedIds).size !== value.expectedIds.length ||
      value.expectedIds.some((id) => !id.trim()))
  ) {
    throw new Error('Invalid Discover semantic identities')
  }
  if (
    value.kind === 'discover-reviewed-ranking' &&
    (!Array.isArray(value.survivors) ||
      !value.survivors.length ||
      value.survivors.length > 12 ||
      value.survivors.some(
        (finding) =>
          typeof finding?.id !== 'string' ||
          !finding.id ||
          !Array.isArray(finding.evidence) ||
          !finding.evidence.length
      ))
  ) {
    throw new Error('Invalid reviewed Discover survivor evidence')
  }
}
